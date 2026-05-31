import { phasePassed, phaseFailed } from "../contracts/phase-result.js";
import { FailureKind, failure } from "../contracts/failure.js";
import { runAgent } from "../agents/agent-runner.js";
import { parseVerifierJson } from "../agents/response-parser.js";
import { writeArtifact } from "../artifacts/artifact-store.js";
import { validateVerdict } from "../artifacts/validators.js";

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

export async function runVerify(ctx) {
  const { project, cpbRoot, pool, sourcePath, jobId } = ctx;
  const deliverableArtifact = getRequiredArtifact(ctx.previousResults, "deliverable");

  const prompt = await buildVerifyPrompt(ctx, deliverableArtifact) + JSON_INSTRUCTION;

  const agentResult = await runAgent({
    role: "verifier",
    ...resolveAgent(ctx, "codex"),
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

Task: ${ctx.task}
Project: ${ctx.project}
${deliverableArtifact ? `\nDeliverable: ${deliverableArtifact.name}\n` : ""}
Check that the implementation correctly addresses the task requirements.`;
}

function resolveAgent(ctx, fallback) {
  const raw = ctx.agents?.verifier || ctx.agent || fallback;
  if (typeof raw === "object" && raw !== null) return { agent: raw.agent || fallback, variant: raw.variant || null };
  return { agent: raw, variant: null };
}
