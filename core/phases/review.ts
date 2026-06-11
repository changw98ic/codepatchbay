import { phasePassed, phaseFailed } from "../contracts/phase-result.js";
import { FailureKind, failure } from "../contracts/failure.js";
import { runAgent } from "../agents/agent-runner.js";
import { writeArtifact } from "../artifacts/artifact-store.js";
import { parseAgentJson } from "../agents/response-parser.js";

const JSON_INSTRUCTION = `

You MUST respond with ONLY a JSON envelope inside a code block. No text before or after.

Example response:
\`\`\`json
{
  "status": "ok",
  "verdict": "changes_requested",
  "summary": "Endpoint logic is correct but missing error handling for database failures",
  "comments": [
    { "file": "src/routes/api.js", "line": 15, "comment": "Wrap db query in try-catch, return 500 on failure" },
    { "file": "src/models/user.js", "line": 8, "comment": "Add connection timeout option to prevent hanging" }
  ]
}
\`\`\`

Rules:
- The response MUST be valid JSON inside a \`\`\`json code block
- Do NOT include any text outside the code block
- verdict MUST be exactly "approved", "changes_requested", or "needs_discussion"
- Do NOT write any artifact files yourself. The system will persist the review.`;

export async function runReview(ctx) {
  const { project, cpbRoot, pool, sourcePath, jobId } = ctx;
  const { dataRoot } = ctx;
  const role = ctx.role || "reviewer";
  const deliverableArtifact = getRequiredArtifact(ctx.previousResults, "deliverable");

  const prompt = await buildReviewPrompt(ctx, deliverableArtifact) + JSON_INSTRUCTION;

  const agentResult = await runAgent({
    role,
    ...resolveAgent(ctx, "codex"),
    project,
    jobId,
    prompt,
    cwd: sourcePath || cpbRoot,
    pool,
    scope: ctx.scope || null,
    env: ctx.env || {},
    timeoutMs: ctx.timeouts?.review ?? 0,
  });

  if (!agentResult.ok) {
    const failed = agentResult as Record<string, any>;
    return phaseFailed({
      phase: "review",
      failure: failure({
        kind: failed.kind,
        phase: "review",
        reason: failed.reason,
        retryable: failed.retryable,
        cause: failed.cause || {},
      }),
      diagnostics: failed.diagnostics,
    });
  }

  const success = agentResult as Record<string, any>;
  const parsed = parseAgentJson(success.output);
  if (!parsed.ok) {
    return phaseFailed({
      phase: "review",
      failure: failure({
        kind: FailureKind.AGENT_CONTRACT_INVALID,
        phase: "review",
        reason: parsed.reason,
        retryable: true,
      }),
      diagnostics: success.diagnostics,
    });
  }

  const content = renderReviewMarkdown(parsed.data);
  const artifact = await writeArtifact(cpbRoot, {
    project,
    jobId,
    kind: "review",
    content,
    dataRoot,
    metadata: parsed.data,
  });

  return phasePassed({
    phase: "review",
    artifact,
    diagnostics: success.diagnostics,
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
  const role = ctx.role || "reviewer";
  const raw = ctx.agents?.[role] || ctx.agents?.reviewer || ctx.agent || fallback;
  if (typeof raw === "object" && raw !== null) return { agent: raw.agent || fallback, variant: raw.variant || null };
  return { agent: raw, variant: null };
}
