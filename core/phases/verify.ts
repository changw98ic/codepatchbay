import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { phasePassed, phaseFailed } from "../contracts/phase-result.js";
import { FailureKind, failure } from "../contracts/failure.js";
import { runAgent } from "../agents/agent-runner.js";
import { parseVerifierJson } from "../agents/response-parser.js";
import { writeArtifact } from "../artifacts/artifact-store.js";
import { writePromptArtifact, withPromptArtifactDiagnostics } from "../artifacts/prompt-artifact.js";
import { phaseExecutionContract } from "./prompt-contract.js";

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

async function getChangedJsFiles(cwd) {
  const files = new Set();
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

async function hasTestScript(cwd) {
  try {
    const raw = await readFile(`${cwd}/package.json`, "utf8");
    const pkg = JSON.parse(raw);
    return typeof pkg.scripts?.test === "string";
  } catch {
    return false;
  }
}

async function focusedNodeTestFiles(cwd, jsFiles) {
  const tests = new Set();
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

async function runHardGates(cwd) {
  const errors = [];
  const checks = [];

  // Gate 1: node --check on relevant compiled .js files
  const jsFiles = await getChangedJsFiles(cwd);
  for (const file of jsFiles) {
    try {
      await execFile("node", ["--check", file], { cwd });
      checks.push({ gate: "node --check", file, ok: true });
    } catch (e) {
      const formatted = formatCommandFailure(`node --check ${file}`, e);
      checks.push({ gate: "node --check", file, ok: false, ...formatted });
      errors.push(formatted.reason);
    }
  }

  const focusedTests = await focusedNodeTestFiles(cwd, jsFiles);
  if (focusedTests.length > 0) {
    try {
      await execFile("node", ["--test", ...focusedTests], { cwd, env: { ...process.env, CI: "1" } });
      checks.push({ gate: "focused node --test", files: focusedTests, ok: true });
    } catch (e) {
      const formatted = formatCommandFailure(`node --test ${focusedTests.join(" ")}`, e);
      checks.push({ gate: "focused node --test", files: focusedTests, ok: false, ...formatted });
      errors.push(formatted.reason);
    }
  } else {
    checks.push({ gate: "focused node --test", ok: true, skipped: true, reason: "no matching focused node tests" });
  }

  // Gate 2: full npm test only when explicitly requested. The verifier agent still
  // checks acceptance criteria after these hard gates.
  if (process.env.CPB_VERIFY_FULL === "1" && await hasTestScript(cwd)) {
    try {
      await execFile("npm", ["test"], { cwd, env: { ...process.env, CI: "1" } });
      checks.push({ gate: "npm test", ok: true });
    } catch (e) {
      const formatted = formatCommandFailure("npm test", e);
      checks.push({ gate: "npm test", ok: false, ...formatted });
      errors.push(formatted.reason);
    }
  }

  if (errors.length > 0) {
    return { ok: false, reason: errors.join("\n"), checks };
  }
  return { ok: true, checks };
}

function tail(text, maxChars = OUTPUT_TAIL_CHARS) {
  const value = String(text || "");
  return value.length > maxChars ? value.slice(-maxChars) : value;
}

function formatCommandFailure(command, err) {
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

export async function runVerify(ctx) {
  const { project, cpbRoot, pool, sourcePath, jobId } = ctx;
  const role = ctx.role || "verifier";
  const cwd = sourcePath || cpbRoot;
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
  const gate = await runHardGates(cwd);
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
  const prompt = await buildVerifyPrompt(ctx, planArtifact, verificationEvidence) + JSON_INSTRUCTION;
  const resolvedAgent = resolveAgent(ctx, "codex");
  const promptArtifact = await writePromptArtifact(cpbRoot, {
    project,
    jobId,
    phase: "verify",
    role,
    agent: resolvedAgent.agent,
    prompt,
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

  const verdictMarkdown = renderVerdictMarkdown(verdict);
  const artifact = await writeArtifact(cpbRoot, {
    project,
    jobId,
    kind: "verdict",
    content: verdictMarkdown,
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

async function collectVerificationEvidence(cwd, planArtifact, hardGate, planEvidence = null) {
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

function shouldRequirePlanArtifact(ctx) {
  return ctx?.workflow !== "direct";
}

async function collectPlanEvidence(planArtifact, { required = true, workflow = null } = {}) {
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

function isUsablePlanEvidence(plan) {
  return Boolean(plan?.available && plan.path && String(plan.excerpt || "").trim());
}

async function collectGitEvidence(cwd) {
  const evidence = {
    available: false,
    cwd,
    statusShort: "",
    changedFiles: [],
    diffStat: "",
    diffExcerpt: "",
    diffTruncated: false,
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
  } catch (err) {
    evidence.reason = err?.message || String(err);
  }

  return evidence;
}

async function git(cwd, args) {
  return execFile("git", args, { cwd, maxBuffer: 20 * 1024 * 1024 })
    .then(({ stdout = "", stderr = "" }) => ({ stdout, stderr }));
}

function uniqueLines(text) {
  return [...new Set(String(text || "").split("\n").map((line) => line.trim()).filter(Boolean))];
}

function limitText(text, maxChars) {
  const value = String(text || "");
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated ${value.length - maxChars} chars]`;
}

function getRequiredArtifact(previousResults, kind) {
  for (let i = previousResults.length - 1; i >= 0; i--) {
    if (previousResults[i].artifact?.kind === kind) {
      return previousResults[i].artifact;
    }
  }
  return null;
}

function renderVerdictMarkdown(verdict) {
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

async function buildVerifyPrompt(ctx, planArtifact, verificationEvidence) {
  if (typeof ctx.buildPrompt === "function") {
    return ctx.buildPrompt("verify", ctx, { planArtifact, verificationEvidence });
  }
  return `You are a software verification agent. Verify the following implementation:

${phaseExecutionContract("verify")}

Task: ${ctx.task}
Project: ${ctx.project}
${planArtifact ? `\nPlan reference: ${planArtifact.name}\n` : "\nPlan reference: unavailable\n"}

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

function resolveAgent(ctx, fallback) {
  const role = ctx.role || "verifier";
  const raw = ctx.agents?.[role] || ctx.agents?.verifier || ctx.agent || fallback;
  if (typeof raw === "object" && raw !== null) return { agent: raw.agent || fallback, variant: raw.variant || null };
  return { agent: raw, variant: null };
}
