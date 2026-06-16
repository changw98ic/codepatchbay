import { createHash } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { runCommandTree } from "../runtime/process-tree.js";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { phasePassed, phaseFailed } from "../contracts/phase-result.js";
import { FailureKind, failure } from "../contracts/failure.js";
import { runAgent } from "../agents/agent-runner.js";
import { parseVerifierJson } from "../agents/response-parser.js";
import { writeArtifact } from "../artifacts/artifact-store.js";
import { writePromptArtifact, withPromptArtifactDiagnostics } from "../artifacts/prompt-artifact.js";
import { phaseExecutionContract } from "./prompt-contract.js";
import { validateChecklistVerdict } from "../workflow/acceptance-checklist.js";
import { buildEvidenceProbePlan, validateEvidenceObservation } from "../workflow/evidence-probes.js";
import { runChecklistProbes } from "../workflow/probe-runner.js";

const execFile: any = promisify(execFileCb);
const OUTPUT_TAIL_CHARS = 4000;
const PROMPT_PLAN_CHARS = 12_000;
const PROMPT_DIFF_CHARS = 16_000;
const PROMPT_DIFF_STAT_CHARS = 40_000;
const VERDICT_LINE_PREFIX = "VERDICT:";

const JSON_INSTRUCTION = `

You MUST respond with ONLY a JSON envelope inside a code block. No text before or after.

Example response (passing):
\`\`\`json
{
  "status": "ok",
  "verdict": "pass",
  "reason": "Implementation matches all acceptance criteria",
  "details": "GET /users endpoint returns correct JSON structure. Pagination works with limit/offset params. Input validation rejects invalid params with 400.",
  "confidence": 0.9
}
\`\`\`

Example response (failing):
\`\`\`json
{
  "status": "ok",
  "verdict": "fail",
  "reason": "Missing input validation for negative page numbers",
  "details": "The endpoint accepts page=-1 without error. Expected 400 Bad Request.",
  "confidence": 0.95
}
\`\`\`

Rules:
- The response MUST be valid JSON inside a \`\`\`json code block
- Do NOT include any text outside the code block
- verdict MUST be exactly "pass", "fail", or "partial"
- confidence MUST be a number between 0.0 and 1.0
- Do NOT write any artifact files yourself. The system will persist the verdict.`;

async function getChangedJsFiles(cwd: string) {
  const files = new Set<string>();
  try {
    // Tracked: staged or modified vs HEAD
    const { stdout: diffOut } = await execFile("git", ["diff", "--name-only", "--diff-filter=AM", "HEAD"], { cwd });
    for (const f of diffOut.trim().split("\n")) {
      if (f && /\.(js|mjs)$/.test(f)) files.add(f);
    }
  } catch { /* not a git repo */ }
  try {
    // Untracked: new files not yet staged
    const { stdout: statOut } = await execFile("git", ["ls-files", "--others", "--exclude-standard"], { cwd });
    for (const f of statOut.trim().split("\n")) {
      if (f && /\.(js|mjs)$/.test(f)) files.add(f);
    }
  } catch { /* ignore */ }
  return [...files];
}

async function hasTestScript(cwd: string) {
  try {
    const raw = await readFile(`${cwd}/package.json`, "utf8");
    const pkg = JSON.parse(raw);
    return typeof pkg.scripts?.test === "string";
  } catch {
    return false;
  }
}

async function focusedNodeTestFiles(cwd: string, jsFiles: string[]) {
  const tests = new Set<string>();
  for (const file of jsFiles) {
    if (file.endsWith(".test.js")) tests.add(file);
    const base = file.replace(/\.(js|mjs)$/, "");
    for (const candidate of [
      `${base}.test.js`,
      `tests/${base.split("/").pop()}.test.js`,
    ]) {
      try {
        await execFile("test", ["-f", candidate], { cwd });
        tests.add(candidate);
      } catch {}
    }
  }
  return [...tests];
}

async function runHardGates(cwd: string, opts: { signal?: AbortSignal; registerChild?: (pid: number) => void | Promise<void> } = {}) {
  const errors = [];
  const checks = [];

  const gateTimeout = (key: string, def: number) => {
    const n = Number.parseInt(process.env[key] || "", 10);
    return Number.isFinite(n) && n > 0 ? n : def;
  };
  const checkMs = gateTimeout("CPB_GATE_TIMEOUT_CHECK", 30_000);
  const testMs = gateTimeout("CPB_GATE_TIMEOUT_TEST", 120_000);
  const fullMs = gateTimeout("CPB_GATE_TIMEOUT_FULL", 600_000);

  // Adapt a runCommandTree result into the err-shape formatCommandFailure expects
  // (execFile used to throw an Error with code/signal/stdout/stderr).
  const toErr = (r: Record<string, any>, timeoutMs: number) => ({
    code: r.exitCode,
    signal: r.signal,
    stdout: r.stdout,
    stderr: r.stderr,
    timedOut: r.timedOut,
    message: r.timedOut ? `timed out after ${timeoutMs}ms` : (r.error?.message || `exit code ${r.exitCode}`),
  });
  const run = (command: string, args: string[], timeoutMs: number, env?: Record<string, string>) =>
    runCommandTree(command, args, {
      cwd,
      env,
      signal: opts.signal,
      timeoutMs,
      onSpawn: opts.registerChild ? (pid) => opts.registerChild(pid) : undefined,
    });

  // Gate 1: node --check on relevant compiled .js files
  const jsFiles = await getChangedJsFiles(cwd);
  for (const file of jsFiles) {
    const r = await run("node", ["--check", file], checkMs);
    if (r.exitCode === 0) {
      checks.push({ gate: "node --check", file, ok: true });
    } else {
      const formatted = formatCommandFailure(`node --check ${file}`, toErr(r, checkMs));
      checks.push({ gate: "node --check", file, ok: false, ...formatted });
      errors.push(formatted.reason);
    }
  }

  const focusedTests = await focusedNodeTestFiles(cwd, jsFiles);
  if (focusedTests.length > 0) {
    const r = await run("node", ["--test", ...focusedTests], testMs, { ...process.env, CI: "1" });
    if (r.exitCode === 0) {
      checks.push({ gate: "focused node --test", files: focusedTests, ok: true });
    } else {
      const formatted = formatCommandFailure(`node --test ${focusedTests.join(" ")}`, toErr(r, testMs));
      checks.push({ gate: "focused node --test", files: focusedTests, ok: false, ...formatted });
      errors.push(formatted.reason);
    }
  } else {
    checks.push({ gate: "focused node --test", ok: true, skipped: true, reason: "no matching focused node tests" });
  }

  // Gate 2: full npm test only when explicitly requested. The verifier agent still
  // checks acceptance criteria after these hard gates.
  if (process.env.CPB_VERIFY_FULL === "1" && await hasTestScript(cwd)) {
    const r = await run("npm", ["test"], fullMs, { ...process.env, CI: "1" });
    if (r.exitCode === 0) {
      checks.push({ gate: "npm test", ok: true });
    } else {
      const formatted = formatCommandFailure("npm test", toErr(r, fullMs));
      checks.push({ gate: "npm test", ok: false, ...formatted });
      errors.push(formatted.reason);
    }
  }

  if (errors.length > 0) {
    return { ok: false, reason: errors.join("\n"), checks };
  }
  return { ok: true, checks };
}

function tail(text: unknown, maxChars = OUTPUT_TAIL_CHARS): string {
  const value = String(text || "");
  return value.length > maxChars ? value.slice(-maxChars) : value;
}

function formatCommandFailure(command: string, err: Record<string, any>) {
  const exitCode = err?.code ?? null;
  const signal = err?.signal ?? null;
  const stdoutTail = tail(err?.stdout || "");
  const stderrTail = tail(err?.stderr || "");
  const parts = [`${command} failed`];
  if (exitCode !== null) parts.push(`exitCode=${exitCode}`);
  if (signal) parts.push(`signal=${signal}`);
  if (stdoutTail.trim()) parts.push(`stdout tail:\n${stdoutTail.trim()}`);
  if (stderrTail.trim()) parts.push(`stderr tail:\n${stderrTail.trim()}`);
  if (!stdoutTail.trim() && !stderrTail.trim() && err?.message) parts.push(`message: ${err.message}`);
  return {
    command,
    exitCode,
    signal,
    stdoutTail,
    stderrTail,
    message: err?.message || "",
    reason: parts.join("\n"),
  };
}

/**
 * Build the evidence ledger before the verifier prompt.
 * The ledger is deterministic: the verifier may only cite ids already present here.
 */
export function buildEvidenceLedger({ jobId, project, attemptId, acceptanceChecklist, verificationEvidence, evidenceProbePlan, ledgerId }: Record<string, any>) {
  const finalWorktree = {
    head: verificationEvidence.git?.head || null,
    diffHash: verificationEvidence.git?.diffHash || null,
  };

  if (!acceptanceChecklist) {
    return { schemaVersion: 1, jobId, project, attemptId, ledgerId, finalWorktree, evidence: [] };
  }

  const evidence: Record<string, any>[] = [];
  let index = 1;
  for (const probe of evidenceProbePlan.probes || []) {
    const checklistItem = acceptanceChecklist.items.find((item: Record<string, any>) => item.id === probe.checklistId);
    if (!checklistItem) continue;
    const validation = validateEvidenceObservation(probe.observation, checklistItem, { attemptId, finalWorktree });
    // `valid` = the record-gate: whether to emit a ledger entry at all.
    // `satisfied` = the result: pass vs fail. A valid-but-not-satisfied entry
    // (e.g. static matchCount:0) must be emitted with result:"fail" so the
    // honest fail flows to retry/remediate — never silently completed.
    if (!validation.valid && !probe.emitFailedClaim) continue;
    evidence.push({
      id: `EV-${String(index++).padStart(3, "0")}`,
      type: "evidence_claim",
      observationType: checklistItem.verificationMethod,
      checklistId: probe.checklistId,
      attemptId,
      verificationMethod: checklistItem.verificationMethod,
      predicateId: checklistItem.predicateId,
      probeId: probe.probeId,
      result: validation.satisfied ? "pass" : "fail",
      ...probe.observation,
      worktreeHead: finalWorktree.head,
      diffHash: finalWorktree.diffHash,
      ...(probe.poisonedSession === true ? { poisonedSession: true, poisonedReasons: probe.poisonedReasons || [] } : {}),
    });
  }
  return { schemaVersion: 1, jobId, project, attemptId, ledgerId, finalWorktree, evidence };
}

/**
 * Synthesize a failing checklist verdict with every required item marked unchecked.
 */
function synthesizeUncheckedChecklistVerdict({ jobId, acceptanceChecklist, reason }: Record<string, any>) {
  return {
    schemaVersion: 1,
    jobId,
    status: "fail",
    items: acceptanceChecklist.items
      .filter((item: Record<string, any>) => item.required)
      .map((item: Record<string, any>) => ({
        checklistId: item.id,
        result: "unchecked",
        evidenceRefs: [] as any[],
        actualResult: "",
        reason,
        fixScope: [] as any[],
      })),
    blocking: [] as any[],
    fixScope: [] as any[],
    reason,
  };
}

/**
 * Re-map evidenceRefs in the checklistVerdict from the placeholder ledgerId
 * the verifier used to the actual ledgerId assigned by the evidence ledger.
 */
function remapEvidenceRefs(checklistVerdict: Record<string, any>, actualLedgerId: string) {
  if (!Array.isArray(checklistVerdict?.items)) return checklistVerdict;
  return {
    ...checklistVerdict,
    items: checklistVerdict.items.map((item: Record<string, any>) => ({
      ...item,
      evidenceRefs: (Array.isArray(item.evidenceRefs) ? item.evidenceRefs : []).map(
        (ref: Record<string, any>) => ({
          ...ref,
          ledgerId: ref.ledgerId === "pending" || !ref.ledgerId ? actualLedgerId : ref.ledgerId,
        }),
      ),
    })),
  };
}

export async function runVerify(ctx: Record<string, any>) {
  const { project, cpbRoot, pool, sourcePath, jobId } = ctx;
  const { dataRoot } = ctx;
  const role = ctx.role || "verifier";
  const cwd = sourcePath || cpbRoot;
  const attemptId = ctx.attemptId || jobId;

  // Resolve active acceptance checklist.
  // The authoritative source is the event-indexed artifact store, but for
  // performance we use the sourceContext fast path when run-job has already
  // validated and event-indexed the checklist.
  // sourceContext.acceptanceChecklist WITHOUT an event-indexed artifact
  // handle is ignored for checklist authority -- it cannot make the verifier
  // mint checklist artifacts.
  let acceptanceChecklist: Record<string, any> | null = null;
  if (ctx.sourceContext?.acceptanceChecklistArtifact?.name && ctx.sourceContext?.acceptanceChecklist) {
    // Fast path: run-job already validated and event-indexed the checklist
    acceptanceChecklist = ctx.sourceContext.acceptanceChecklist;
  }
  // Do NOT fall through to readActiveChecklistArtifacts in the hot path.
  // The artifact store lookup is available for completion-gate and audit
  // which run after the phase returns.

  const planArtifact = getRequiredArtifact(ctx.previousResults, "plan");
  const planRequired = shouldRequirePlanArtifact(ctx);
  const planEvidence = await collectPlanEvidence(planArtifact, { required: planRequired, workflow: ctx.workflow });
  if (planRequired && !isUsablePlanEvidence(planEvidence)) {
    const reason = planEvidence.reason || "verify requires a readable plan artifact before judging current diff";
    return phaseFailed({
      phase: "verify",
      failure: failure({
        kind: FailureKind.VERIFICATION_FAILED,
        phase: "verify",
        reason,
        retryable: false,
        cause: {
          planRequired: true,
          plan: planEvidence,
        },
      }),
      diagnostics: { planRequired: planEvidence },
    });
  }

  // Hard gates run BEFORE agent — non-bypassable syntax + test checks
  const gate = await runHardGates(cwd, { signal: ctx?.signal, registerChild: ctx?.processHooks?.registerChild });
  if (!gate.ok) {
    return phaseFailed({
      phase: "verify",
      failure: failure({
        kind: FailureKind.VERIFICATION_FAILED,
        phase: "verify",
        reason: gate.reason,
        retryable: false,
        cause: {
          hardGate: true,
          checks: gate.checks,
        },
      }),
      diagnostics: { hardGate: gate },
    });
  }

  const verificationEvidence = await collectVerificationEvidence(cwd, planArtifact, gate, planEvidence);

  // Build evidence ledger BEFORE verifier prompt.
  // The ledger is deterministic: the verifier sees the exact claim ids it may cite.
  const ledgerId = `evidence-ledger-${jobId}`;
  // Deterministic probes provide objective scope evidence (the change landed
  // in the item's declared files), independent of the verifier agent's claim.
  const probeChecks = acceptanceChecklist
    ? await runChecklistProbes(acceptanceChecklist, cwd, { finalWorktree: verificationEvidence.git, attemptId })
    : [];
  const hardGateChecks = [...(verificationEvidence.hardGate?.checks || []), ...probeChecks];
  const evidenceProbePlan = acceptanceChecklist
    ? buildEvidenceProbePlan({
        acceptanceChecklist,
        hardGateChecks,
        attemptId,
        finalWorktree: verificationEvidence.git,
      })
    : { probes: [] as any[] };
  const evidenceLedger = buildEvidenceLedger({
    jobId,
    project,
    attemptId,
    acceptanceChecklist,
    verificationEvidence,
    evidenceProbePlan,
    ledgerId,
  });

  const prompt = await buildVerifyPrompt(ctx, planArtifact, verificationEvidence, { acceptanceChecklist, evidenceLedger }) + JSON_INSTRUCTION;
  const resolvedAgent = resolveAgent(ctx, "codex");
  const promptArtifact = await writePromptArtifact(cpbRoot, {
    project,
    jobId,
    phase: "verify",
    role,
    agent: resolvedAgent.agent,
    prompt,
    dataRoot,
  });

  const agentResult: Record<string, any> = await runAgent({
    role,
    ...resolvedAgent,
    project,
    jobId,
    prompt,
    cwd,
    pool,
    timeoutMs: ctx.timeouts?.verify ?? 0,
    scope: ctx.scope,
    env: ctx.env,
    dataRoot,
  });

  if (!agentResult.ok) {
    return phaseFailed({
      phase: "verify",
      failure: failure({
        kind: agentResult.kind,
        phase: "verify",
        reason: agentResult.reason,
        retryable: agentResult.retryable,
        exitCode: agentResult.exitCode,
        signal: agentResult.signal,
        cause: agentResult.cause || {},
      }),
      diagnostics: withPromptArtifactDiagnostics(agentResult.diagnostics, promptArtifact),
    });
  }

  const verdict: Record<string, any> = parseVerifierJson(agentResult.output) as any;
  if (!verdict.ok) {
    return phaseFailed({
      phase: "verify",
      failure: failure({
        kind: FailureKind.VERDICT_INVALID,
        phase: "verify",
        reason: verdict.reason,
        retryable: true,
        stderrSnippet: agentResult.output.slice(-500),
      }),
      diagnostics: withPromptArtifactDiagnostics(agentResult.diagnostics, promptArtifact),
    });
  }

  // Persist evidence ledger only for checklist-aware jobs.
  // Legacy jobs don't need the evidence-ledger artifact.
  let evidenceLedgerArtifact: Record<string, any> | null = null;
  if (acceptanceChecklist) {
    evidenceLedgerArtifact = await writeArtifact(cpbRoot, {
      project,
      jobId,
      kind: "evidence-ledger",
      content: JSON.stringify(evidenceLedger, null, 2),
      dataRoot,
      metadata: evidenceLedger,
    });
  }

  // ── Checklist-aware verdict validation ──────────────────────────────
  // When a readable event-indexed acceptance-checklist artifact exists,
  // require a valid checklistVerdict. sourceContext.acceptanceChecklist
  // does not authorize checklist artifacts.
  if (acceptanceChecklist) {
    const rawChecklistVerdict = verdict.checklistVerdict || null;
    const checklistVerdict = rawChecklistVerdict
      ? remapEvidenceRefs(rawChecklistVerdict, evidenceLedger.ledgerId)
      : null;

    // Try to validate the verifier-provided checklist verdict
    let verdictValidation: Record<string, any> | null = null;
    if (checklistVerdict) {
      verdictValidation = validateChecklistVerdict(checklistVerdict, acceptanceChecklist);
    }

    const usedSynthesized = !checklistVerdict || !verdictValidation?.ok;
    const finalChecklistVerdict = usedSynthesized
      ? synthesizeUncheckedChecklistVerdict({
          jobId,
          acceptanceChecklist,
          reason: checklistVerdict
            ? `checklist verdict validation failed`
            : "checklist-aware job requires checklistVerdict",
        })
      : checklistVerdict;

    const checklistVerdictArtifact = await writeArtifact(cpbRoot, {
      project,
      jobId,
      kind: "checklist-verdict",
      content: JSON.stringify(finalChecklistVerdict, null, 2),
      dataRoot,
      metadata: finalChecklistVerdict,
    });

    // If we had to synthesize the verdict, the verify phase FAILS.
    if (usedSynthesized) {
      return phaseFailed({
        phase: "verify",
        failure: failure({
          kind: FailureKind.VERDICT_INVALID,
          phase: "verify",
          reason: finalChecklistVerdict.reason,
          retryable: false,
          cause: { checklistVerdict: finalChecklistVerdict },
        }),
        diagnostics: withPromptArtifactDiagnostics(
          { ...agentResult.diagnostics, evidenceLedgerArtifact, checklistVerdictArtifact },
          promptArtifact,
        ),
      });
    }

    // Checklist verdict is valid; still write legacy verdict for compatibility
    const verdictMarkdown = renderVerdictMarkdown(verdict);
    const artifact = await writeArtifact(cpbRoot, {
      project,
      jobId,
      kind: "verdict",
      content: verdictMarkdown,
      dataRoot,
      metadata: verdict,
    });

    // A valid checklist verdict with status "fail" must fail the verify phase,
    // mirroring the legacy path (verdict.status !== "pass" -> VERIFICATION_FAILED).
    // Otherwise a verifier that returns a failing checklist would be recorded as
    // passing just because its verdict shape validated.
    if (finalChecklistVerdict.status === "fail") {
      return phaseFailed({
        phase: "verify",
        failure: failure({
          kind: FailureKind.VERIFICATION_FAILED,
          phase: "verify",
          reason: finalChecklistVerdict.reason || verdict.reason || "verification failed",
          retryable: true,
          cause: { verdict, artifact, checklistVerdict: finalChecklistVerdict, checklistVerdictArtifact },
        }),
        diagnostics: withPromptArtifactDiagnostics(
          { ...agentResult.diagnostics, artifact, verdict, evidenceLedgerArtifact, checklistVerdictArtifact },
          promptArtifact,
        ),
      });
    }

    return phasePassed({
      phase: "verify",
      verdict: `VERDICT: ${verdict.status.toUpperCase()}`,
      artifact,
      diagnostics: withPromptArtifactDiagnostics(
        { ...agentResult.diagnostics, verdict, verificationEvidence, evidenceLedgerArtifact, checklistVerdictArtifact },
        promptArtifact,
      ),
    } as any);
  }

  // ── Legacy (non-checklist-aware) path ───────────────────────────────
  const verdictMarkdown = renderVerdictMarkdown(verdict);
  const artifact = await writeArtifact(cpbRoot, {
    project,
    jobId,
    kind: "verdict",
    content: verdictMarkdown,
    dataRoot,
    metadata: verdict,
  });

  if (verdict.status !== "pass") {
    return phaseFailed({
      phase: "verify",
      failure: failure({
        kind: FailureKind.VERIFICATION_FAILED,
        phase: "verify",
        reason: verdict.reason || "verification failed",
        retryable: true,
        cause: { verdict, artifact },
      }),
      diagnostics: withPromptArtifactDiagnostics({ ...agentResult.diagnostics, artifact, verdict }, promptArtifact),
    });
  }

  return phasePassed({
    phase: "verify",
    verdict: `VERDICT: ${verdict.status.toUpperCase()}`,
    artifact,
    diagnostics: withPromptArtifactDiagnostics({ ...agentResult.diagnostics, verdict, verificationEvidence }, promptArtifact),
  } as any);
}

async function collectVerificationEvidence(cwd: string, planArtifact: Record<string, any>, hardGate: Record<string, any>, planEvidence: Record<string, any> | null = null) {
  const [plan, gitEvidence] = await Promise.all([
    planEvidence ? Promise.resolve(planEvidence) : collectPlanEvidence(planArtifact),
    collectGitEvidence(cwd),
  ]);
  const sourceOfTruth = ["task", "current_diff", "changed_files", "hard_gates"];
  if (plan.available) sourceOfTruth.splice(1, 0, "plan");
  return {
    sourceOfTruth,
    executorDeliverablePolicy: "self_report_only_not_verification_evidence",
    plan,
    git: gitEvidence,
    hardGate,
  };
}

function shouldRequirePlanArtifact(ctx: Record<string, any>) {
  return ctx?.workflow !== "direct";
}

async function collectPlanEvidence(planArtifact: Record<string, any>, { required = true, workflow = null }: Record<string, any> = {}) {
  if (!planArtifact) {
    if (!required) {
      return {
        available: false,
        optional: true,
        workflow,
        reason: "direct workflow has no plan phase; verify must use task, current diff, changed files, hard gates, and tests",
      };
    }
    return { available: false, reason: "verify requires a plan artifact in previous phase results" };
  }
  const plan: Record<string, any> = {
    available: true,
    name: planArtifact.name || null,
    path: planArtifact.path || null,
    sha256: planArtifact.sha256 || null,
    bytes: planArtifact.bytes || null,
  };
  if (!planArtifact.path) {
    plan.available = false;
    plan.reason = "verify requires a readable plan artifact path";
    return plan;
  }
  try {
    const content = await readFile(planArtifact.path, "utf8");
    plan.excerpt = limitText(content, PROMPT_PLAN_CHARS);
    plan.truncated = content.length > PROMPT_PLAN_CHARS;
    if (!content.trim()) {
      plan.available = false;
      plan.reason = "verify requires non-empty plan artifact content";
    }
  } catch (err) {
    plan.available = false;
    plan.reason = `plan artifact unreadable: ${err?.message || err}`;
  }
  return plan;
}

function isUsablePlanEvidence(plan: Record<string, any>) {
  return Boolean(plan?.available && plan.path && String(plan.excerpt || "").trim());
}

async function collectGitEvidence(cwd: string) {
  const evidence: Record<string, any> = {
    available: false,
    cwd,
    statusShort: "",
    changedFiles: [],
    diffStat: "",
    diffExcerpt: "",
    diffTruncated: false,
    head: null,
    diffHash: null,
    reason: null,
  };

  try {
    const [status, trackedFiles, untrackedFiles, diffStat, diff] = await Promise.all([
      git(cwd, ["status", "--short"]),
      git(cwd, ["diff", "--name-only", "--diff-filter=ACMRTUXB", "HEAD"]),
      git(cwd, ["ls-files", "--others", "--exclude-standard"]),
      git(cwd, ["diff", "--stat", "HEAD"]),
      git(cwd, ["diff", "HEAD"]),
    ]);

    const changedFiles = uniqueLines(`${trackedFiles.stdout}\n${untrackedFiles.stdout}`);
    const diffExcerpt = limitText(diff.stdout, PROMPT_DIFF_CHARS);
    evidence.available = true;
    evidence.statusShort = status.stdout.trim();
    evidence.changedFiles = changedFiles;
    evidence.diffStat = limitText(diffStat.stdout, PROMPT_DIFF_STAT_CHARS).trim();
    evidence.diffExcerpt = diffExcerpt;
    evidence.diffTruncated = diff.stdout.length > PROMPT_DIFF_CHARS;

    // Collect HEAD commit and diff hash for evidence freshness
    const head = await git(cwd, ["rev-parse", "HEAD"]).catch(() => ({ stdout: "" }));
    evidence.head = head.stdout.trim() || null;
    evidence.diffHash = diff.stdout ? `sha256:${createHash("sha256").update(diff.stdout).digest("hex")}` : "sha256:empty";
  } catch (err) {
    evidence.reason = err?.message || String(err);
  }

  return evidence;
}

async function git(cwd: string, args: string[]) {
  return execFile("git", args, { cwd, maxBuffer: 20 * 1024 * 1024 })
    .then(({ stdout = "", stderr = "" }: any) => ({ stdout, stderr }));
}

function uniqueLines(text: unknown): string[] {
  return [...new Set(String(text || "").split("\n").map((line) => line.trim()).filter(Boolean))];
}

function limitText(text: unknown, maxChars: number): string {
  const value = String(text || "");
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated ${value.length - maxChars} chars]`;
}

function getRequiredArtifact(previousResults: Record<string, any>[], kind: string) {
  for (let i = previousResults.length - 1; i >= 0; i--) {
    if (previousResults[i].artifact?.kind === kind) {
      return previousResults[i].artifact;
    }
  }
  return null;
}

function renderVerdictMarkdown(verdict: Record<string, any>) {
  const statusUpper = verdict.status.toUpperCase();
  return `# Verdict

${VERDICT_LINE_PREFIX} ${statusUpper}

## Status
${statusUpper}

## Reason
${verdict.reason}

## Details
${verdict.details || "N/A"}

## Confidence
${verdict.confidence || "N/A"}
`;
}

export function verifyPhaseOutputContract() {
  return {
    verdictLinePrefix: VERDICT_LINE_PREFIX,
  };
}

async function buildVerifyPrompt(ctx: Record<string, any>, planArtifact: Record<string, any>, verificationEvidence: Record<string, any>, checklistContext: Record<string, any> = {}) {
  if (typeof ctx.buildPrompt === "function") {
    return ctx.buildPrompt("verify", ctx, { planArtifact, verificationEvidence });
  }

  let checklistSection = "";
  if (checklistContext.acceptanceChecklist) {
    const ledger = checklistContext.evidenceLedger;
    const evidenceSummary = (ledger?.evidence || []).map((entry: Record<string, any>) => ({
      evidenceId: entry.id,
      checklistId: entry.checklistId,
      verificationMethod: entry.verificationMethod,
      predicateId: entry.predicateId,
      probeId: entry.probeId,
      result: entry.result,
      summary: entry.summary || entry.command || entry.queryId || "",
    }));

    checklistSection = `

## CHECKLIST-AWARE VERIFICATION (MANDATORY)
This is a checklist-aware job. You MUST return checklistVerdict in your JSON envelope. Cover every required checklist id. A pass item must cite evidenceRefs from the provided evidence ledger. You may only cite existing evidence ids whose checklistId, verificationMethod, and predicateId match the item. Do not invent evidence ids. Do not use executor summary or generic hard-gate output as pass evidence.

### Frozen Acceptance Checklist
${JSON.stringify(checklistContext.acceptanceChecklist, null, 2)}

### Predeclared Evidence Ledger (ledgerId: ${ledger?.ledgerId || "none"})
You may only cite evidence ids from this table:
${JSON.stringify(evidenceSummary, null, 2)}

If an item needs a probe that is not present, return unchecked with reason "probe_definition_missing" or fail. Do not invent EV-* ids.
`;
  }

  return `You are a software verification agent. Verify the following implementation:

${phaseExecutionContract("verify")}

Task: ${ctx.task}
Project: ${ctx.project}
${planArtifact ? `\nPlan reference: ${planArtifact.name}\n` : "\nPlan reference: unavailable\n"}
${checklistSection}
## Verification Source Of Truth
Use only the original task, the plan artifact when present, the current worktree diff/changed files, hard-gate results, and tests you actually run as proof.
Executor deliverables/summaries are self-reports for later audit only. Do not use an executor deliverable, executor summary, or executor test list as proof for PASS.
Codegraph/project indexes are optional accelerators. If unavailable, record the reason and continue with git diff, focused file inspection, and real tests.

## Current Evidence Snapshot
${JSON.stringify(verificationEvidence, null, 2)}

## MANDATORY checks (MUST run before any other verification):
1. Run \`node --check\` on every relevant compiled .js file. If ANY file has a syntax error, verdict = FAIL.
2. Run focused tests for directly changed files when they exist. Full \`npm test\` is a regression layer only when explicitly requested.
3. Verify concrete request-level acceptance probes from the task requirements and plan before returning PASS.
4. Cross-check every claimed implementation path against the current diff. If the diff implements a different product path than the plan requires, verdict = FAIL or PARTIAL even when tests pass.`;
}

function resolveAgent(ctx: Record<string, any>, fallback: string) {
  const role = ctx.role || "verifier";
  const raw = ctx.agents?.[role] || ctx.agents?.verifier || ctx.agent || fallback;
  if (typeof raw === "object" && raw !== null) return { agent: raw.agent || fallback, variant: raw.variant || null };
  return { agent: raw, variant: null };
}
