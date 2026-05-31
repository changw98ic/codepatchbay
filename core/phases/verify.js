import { phasePassed, phaseFailed } from "../contracts/phase-result.js";
import { FailureKind, failure } from "../contracts/failure.js";
import { runAgent } from "../agents/agent-runner.js";
import { parseVerifierJson } from "../agents/response-parser.js";
import { writeArtifact } from "../artifacts/artifact-store.js";
import { validateVerdict } from "../artifacts/validators.js";

const AGENT_ALTERNATES = { codex: "claude", claude: "codex" };

const JSON_INSTRUCTION = `

You MUST respond with ONLY a JSON envelope inside a code block. No text before or after.

Example response (passing):
\`\`\`json
{
  "status": "ok",
  "verdict": "pass",
  "reason": "Implementation matches all acceptance criteria",
  "details": "GET /users endpoint returns correct JSON structure. Pagination works with limit/offset params. Input validation rejects invalid params with 400.",
  "confidence": 0.9,
  "diagnostics": {
    "evidence": [
      "Reviewed src/routes/api.js: getHandler returns {data, pagination} correctly",
      "Confirmed input validation in src/routes/api.js: validatePagination() rejects negative values"
    ],
    "filesReviewed": ["src/routes/api.js", "src/models/user.js"],
    "commandsRun": ["npm test 2>&1 | tail -20"],
    "concerns": []
  }
}
\`\`\`

Example response (failing):
\`\`\`json
{
  "status": "ok",
  "verdict": "fail",
  "reason": "Missing input validation for negative page numbers",
  "details": "The endpoint accepts page=-1 without error. Expected 400 Bad Request.",
  "confidence": 0.95,
  "diagnostics": {
    "evidence": [
      "curl -s http://localhost:3000/api/users?page=-1 returned 200 with data",
      "No validation for 'page' param found in src/routes/api.js:42-58"
    ],
    "filesReviewed": ["src/routes/api.js"],
    "commandsRun": ["curl -s 'http://localhost:3000/api/users?page=-1'"],
    "concerns": ["No pagination input validation"]
  }
}
\`\`\`

Rules:
- The response MUST be valid JSON inside a \`\`\`json code block
- Do NOT include any text outside the code block
- verdict MUST be exactly "pass", "fail", or "partial"
- confidence MUST be a number between 0.0 and 1.0
- diagnostics.evidence MUST be an array of strings describing what you checked
- diagnostics.filesReviewed MUST list files you examined
- diagnostics.commandsRun MUST list commands you executed to verify
- diagnostics.concerns MUST list any unresolved concerns (empty array if none)
- Do NOT write any artifact files yourself. The system will persist the verdict.`;

export async function runVerify(ctx) {
  const { project, cpbRoot, pool, sourcePath, jobId } = ctx;
  const deliverableArtifact = getRequiredArtifact(ctx.previousResults, "deliverable");

  // Verifier independence: ensure verifier uses a different agent from executor
  const agentConfig = resolveVerifierAgent(ctx);

  const prompt = await buildVerifyPrompt(ctx, deliverableArtifact) + JSON_INSTRUCTION;

  const agentResult = await runAgent({
    role: "verifier",
    ...agentConfig,
    project,
    prompt,
    cwd: sourcePath || cpbRoot,
    pool,
    timeoutMs: ctx.timeouts?.verify || 600_000,
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

/**
 * Resolve the verifier agent with independence enforcement.
 * If the verifier would use the same agent as the executor,
 * swap to the alternate to prevent self-review.
 */
function resolveVerifierAgent(ctx) {
  const rawVerifier = ctx.agents?.verifier || ctx.agent || "codex";
  const verifierAgent = typeof rawVerifier === "object" ? (rawVerifier.agent || "codex") : rawVerifier;
  const verifierVariant = typeof rawVerifier === "object" ? (rawVerifier.variant || null) : null;

  // Find the executor agent from previous phase results
  const executorAgent = findExecutorAgent(ctx.previousResults);

  if (executorAgent && executorAgent === verifierAgent) {
    const alternate = AGENT_ALTERNATES[verifierAgent] || verifierAgent;
    return { agent: alternate, variant: verifierVariant, swappedFrom: verifierAgent };
  }

  return { agent: verifierAgent, variant: verifierVariant };
}

function findExecutorAgent(previousResults) {
  for (let i = previousResults.length - 1; i >= 0; i--) {
    const result = previousResults[i];
    if (result?.phase === "execute" && result?.diagnostics?.agent) {
      return result.diagnostics.agent;
    }
  }
  return null;
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
  const diag = verdict.diagnostics || {};
  const evidenceSection = Array.isArray(diag.evidence) && diag.evidence.length > 0
    ? diag.evidence.map((e) => `- ${e}`).join("\n")
    : "- No evidence provided";
  const filesSection = Array.isArray(diag.filesReviewed) && diag.filesReviewed.length > 0
    ? diag.filesReviewed.map((f) => `- ${f}`).join("\n")
    : "- Not reported";
  const commandsSection = Array.isArray(diag.commandsRun) && diag.commandsRun.length > 0
    ? diag.commandsRun.map((c) => `- ${c}`).join("\n")
    : "- Not reported";
  const concernsSection = Array.isArray(diag.concerns) && diag.concerns.length > 0
    ? diag.concerns.map((c) => `- ${c}`).join("\n")
    : "- None";

  return `# Verdict

## Status
${verdict.status.toUpperCase()}

## Reason
${verdict.reason}

## Details
${verdict.details || "N/A"}

## Confidence
${verdict.confidence || "N/A"}

## Evidence
${evidenceSection}

## Files Reviewed
${filesSection}

## Commands Run
${commandsSection}

## Concerns
${concernsSection}
`;
}

async function buildVerifyPrompt(ctx, deliverableArtifact) {
  if (typeof ctx.buildPrompt === "function") {
    return ctx.buildPrompt("verify", ctx, { deliverableArtifact });
  }
  return `You are an independent software verification agent. Your job is to critically verify the following implementation was done correctly. You must NOT assume the implementation is correct — verify each claim independently.

Task: ${ctx.task}
Project: ${ctx.project}
${deliverableArtifact ? `\nDeliverable: ${deliverableArtifact.name}\n` : ""}
Verification requirements:
1. Read the actual source files changed — do not trust the summary alone
2. Run any available tests to confirm correctness
3. Check edge cases mentioned in the task
4. Report specific evidence for each check (file paths, line numbers, test output)
5. List all concerns, even minor ones`;
}
