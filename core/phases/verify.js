import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { phasePassed, phaseFailed } from "../contracts/phase-result.js";
import { FailureKind, failure } from "../contracts/failure.js";
import { runAgent } from "../agents/agent-runner.js";
import { parseVerifierJson } from "../agents/response-parser.js";
import { writeArtifact } from "../artifacts/artifact-store.js";
import { phaseExecutionContract } from "./prompt-contract.js";

const execFile = promisify(execFileCb);
const OUTPUT_TAIL_CHARS = 4000;

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
    if (file.endsWith(".test.mjs")) tests.add(file);
    const base = file.replace(/\.(js|mjs)$/, "");
    for (const candidate of [
      `${base}.test.mjs`,
      `tests/${base.split("/").pop()}.test.mjs`,
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

  // Gate 1: node --check on changed .js/.mjs files
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
  const cwd = sourcePath || cpbRoot;
  const deliverableArtifact = getRequiredArtifact(ctx.previousResults, "deliverable");

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

  const prompt = await buildVerifyPrompt(ctx, deliverableArtifact) + JSON_INSTRUCTION;

  const agentResult = await runAgent({
    role: "verifier",
    ...resolveAgent(ctx, "codex"),
    project,
    prompt,
    cwd,
    pool,
    timeoutMs: ctx.timeouts?.verify ?? 0,
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
      diagnostics: agentResult.diagnostics,
    });
  }

  const verdict = parseVerifierJson(agentResult.output);
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
      diagnostics: agentResult.diagnostics,
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
      diagnostics: { artifact, verdict },
    });
  }

  return phasePassed({
    phase: "verify",
    artifact,
    diagnostics: { verdict },
  });
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
  return `# Verdict

## Status
${verdict.status.toUpperCase()}

## Reason
${verdict.reason}

## Details
${verdict.details || "N/A"}

## Confidence
${verdict.confidence || "N/A"}
`;
}

async function buildVerifyPrompt(ctx, deliverableArtifact) {
  if (typeof ctx.buildPrompt === "function") {
    return ctx.buildPrompt("verify", ctx, { deliverableArtifact });
  }
  return `You are a software verification agent. Verify the following implementation:

${phaseExecutionContract("verify")}

Task: ${ctx.task}
Project: ${ctx.project}
${deliverableArtifact ? `\nDeliverable: ${deliverableArtifact.name}\n` : ""}

## MANDATORY checks (MUST run before any other verification):
1. Run \`node --check\` on every added or modified .js/.mjs file. If ANY file has a syntax error, verdict = FAIL.
2. Run focused tests for directly changed files when they exist. Full \`npm test\` is a regression layer only when explicitly requested.
3. Verify concrete request-level acceptance probes from the task requirements before returning PASS.`;
}

function resolveAgent(ctx, fallback) {
  const raw = ctx.agents?.verifier || ctx.agent || fallback;
  if (typeof raw === "object" && raw !== null) return { agent: raw.agent || fallback, variant: raw.variant || null };
  return { agent: raw, variant: null };
}
