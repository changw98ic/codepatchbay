import { phasePassed, phaseFailed } from "../contracts/phase-result.js";
import { FailureKind, failure } from "../contracts/failure.js";
import { runAgent } from "../agents/agent-runner.js";
import { writeArtifact } from "../artifacts/artifact-store.js";
import { parseAgentJson } from "../agents/response-parser.js";

const JSON_INSTRUCTION = `

You MUST respond with a JSON envelope:
\`\`\`json
{
  "status": "ok",
  "verdict": "approved" | "changes_requested" | "needs_discussion",
  "summary": "review summary",
  "comments": [
    { "file": "path/to/file", "line": 42, "comment": "suggestion" }
  ]
}
\`\`\`

Do NOT write any artifact files yourself. The system will persist the review.`;

export async function runReview(ctx) {
  const { project, cpbRoot, pool, sourcePath, jobId } = ctx;
  const deliverableArtifact = getRequiredArtifact(ctx.previousResults, "deliverable");

  const prompt = await buildReviewPrompt(ctx, deliverableArtifact) + JSON_INSTRUCTION;

  const agentResult = await runAgent({
    role: "reviewer",
    ...resolveAgent(ctx, "codex"),
    project,
    prompt,
    cwd: sourcePath || cpbRoot,
    pool,
    timeoutMs: ctx.timeouts?.review || 600_000,
  });

  if (!agentResult.ok) {
    return phaseFailed({
      phase: "review",
      failure: failure({
        kind: agentResult.kind,
        phase: "review",
        reason: agentResult.reason,
        retryable: agentResult.retryable,
        cause: agentResult.cause || {},
      }),
      diagnostics: agentResult.diagnostics,
    });
  }

  const parsed = parseAgentJson(agentResult.output);
  if (!parsed.ok) {
    return phaseFailed({
      phase: "review",
      failure: failure({
        kind: FailureKind.AGENT_CONTRACT_INVALID,
        phase: "review",
        reason: parsed.reason,
        retryable: true,
      }),
      diagnostics: agentResult.diagnostics,
    });
  }

  const content = renderReviewMarkdown(parsed.data);
  const artifact = await writeArtifact(cpbRoot, {
    project,
    jobId,
    kind: "review",
    content,
    metadata: parsed.data,
  });

  return phasePassed({
    phase: "review",
    artifact,
    diagnostics: agentResult.diagnostics,
  });
}

function getRequiredArtifact(previousResults, kind) {
  for (let i = previousResults.length - 1; i >= 0; i--) {
    if (previousResults[i].artifact?.kind === kind) return previousResults[i].artifact;
  }
  return null;
}

function renderReviewMarkdown(data) {
  return `# Review

## Verdict
${data.verdict || "N/A"}

## Summary
${data.summary || "N/A"}

## Comments
${(data.comments || []).map((c) => `- **${c.file}${c.line ? `:${c.line}` : ""}**: ${c.comment}`).join("\n") || "- None"}
`;
}

async function buildReviewPrompt(ctx, deliverableArtifact) {
  if (typeof ctx.buildPrompt === "function") {
    return ctx.buildPrompt("review", ctx, { deliverableArtifact });
  }
  return `You are a code review agent. Review the following deliverable:

Task: ${ctx.task}
Project: ${ctx.project}
${deliverableArtifact ? `\nDeliverable: ${deliverableArtifact.name}\n` : ""}`;
}

function resolveAgent(ctx, fallback) {
  const raw = ctx.agents?.reviewer || ctx.agent || fallback;
  if (typeof raw === "object" && raw !== null) return { agent: raw.agent || fallback, variant: raw.variant || null };
  return { agent: raw, variant: null };
}
