import type { LooseRecord } from "../../shared/types.js";
import { phasePassed, phaseFailed } from "../contracts/phase-result.js";
import { FailureKind, failure } from "../contracts/failure.js";
import { runAgent } from "../agents/agent-runner.js";
import { writeArtifact } from "../artifacts/artifact-store.js";
import { parseAgentJson } from "../agents/response-parser.js";
import { buildPhaseAcpEnv } from "./phase-env.js";

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

function recordValue(value: unknown): LooseRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as LooseRecord : {};
}

function recordArray(value: unknown): LooseRecord[] {
  return Array.isArray(value) ? value.map(recordValue) : [];
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value ? value : fallback;
}

export async function runReview(ctx: LooseRecord) {
  const { project, cpbRoot, pool, sourcePath, jobId } = ctx;
  const { dataRoot } = ctx;
  const role = stringValue(ctx.role, "reviewer");
  const deliverableArtifact = getRequiredArtifact(recordArray(ctx.previousResults), "deliverable");

  const prompt = await buildReviewPrompt(ctx, deliverableArtifact) + JSON_INSTRUCTION;

  const agentResult = await runAgent({
    phase: "review",
    role,
    ...resolveAgent(ctx, "codex"),
    project,
    jobId,
    prompt,
    cwd: sourcePath || cpbRoot,
    pool,
    scope: ctx.scope || null,
    env: buildPhaseAcpEnv(ctx, "review"),
    timeoutMs: typeof recordValue(ctx.timeouts).review === "number" ? recordValue(ctx.timeouts).review : 0,
    dataRoot,
    onProgress: ctx.onProgress,
  });

  if (!agentResult.ok) {
    const failed = recordValue(agentResult);
    const failureKind = typeof failed.kind === "string" ? failed.kind : FailureKind.UNKNOWN;
    return phaseFailed({
      phase: "review",
      failure: failure({
        kind: failureKind,
        phase: "review",
        reason: failed.reason,
        retryable: failed.retryable === true,
        cause: recordValue(failed.cause),
      }),
      diagnostics: recordValue(failed.diagnostics),
    });
  }

  const success = recordValue(agentResult);
  const parsed = recordValue(parseAgentJson(success.output));
  if (!parsed.ok) {
    return phaseFailed({
      phase: "review",
      failure: failure({
        kind: FailureKind.AGENT_CONTRACT_INVALID,
        phase: "review",
        reason: parsed.reason,
        retryable: true,
      }),
      diagnostics: recordValue(success.diagnostics),
    });
  }

  const parsedData = recordValue(parsed.data);
  const content = renderReviewMarkdown(parsedData);
  const artifact = await writeArtifact(cpbRoot, {
    project,
    jobId,
    kind: "review",
    content,
    dataRoot,
    metadata: parsedData,
  });

  return phasePassed({
    phase: "review",
    artifact,
    diagnostics: recordValue(success.diagnostics),
  });
}

function getRequiredArtifact(previousResults: LooseRecord[], kind: string) {
  for (let i = previousResults.length - 1; i >= 0; i--) {
    const artifact = recordValue(previousResults[i].artifact);
    if (artifact.kind === kind) return artifact;
  }
  return null;
}

function renderReviewMarkdown(data: LooseRecord) {
  return `# Review

## Verdict
${data.verdict || "N/A"}

## Summary
${data.summary || "N/A"}

## Comments
${recordArray(data.comments).map((c) => `- **${stringValue(c.file)}${c.line ? `:${c.line}` : ""}**: ${stringValue(c.comment)}`).join("\n") || "- None"}
`;
}

function buildRetrySection(sourceContext: LooseRecord) {
  const retry = recordValue(sourceContext.retry);
  if (Object.keys(retry).length === 0) return "";
  return `

## Previous Attempt Failed
Your previous review pass was rejected. Rerun this same phase with the corrected behavior below.

Error type: ${stringValue(retry.failureKind)}
Error: ${stringValue(retry.failureReason)}
Failure class: ${stringValue(retry.failureClass, "unknown")}
Failure fingerprint: ${stringValue(retry.failureFingerprint, "unavailable")}
Recovery strategy: ${stringValue(retry.retryStrategy, "unavailable")}
Strategy changed: ${retry.strategyChanged === true ? "yes" : "no"}
${retry.retryClass ? `Repair class: ${retry.retryClass}` : ""}
${Array.isArray(retry.fixScope) && retry.fixScope.length > 0 ? `Fix scope: ${retry.fixScope.join(", ")}` : ""}
${retry.failureEvidence ? `Failure evidence:\n\`\`\`json\n${JSON.stringify(retry.failureEvidence, null, 2)}\n\`\`\`` : ""}
${retry.instruction ? `Repair instruction: ${retry.instruction}` : ""}
${retry.previousOutput ? `\nPrevious output for reference:\n\`\`\`\n${retry.previousOutput}\n\`\`\`` : ""}`;
}

async function buildReviewPrompt(ctx: LooseRecord, deliverableArtifact: LooseRecord | null) {
  const retrySection = buildRetrySection(recordValue(ctx.sourceContext));
  if (typeof ctx.buildPrompt === "function") {
    return await ctx.buildPrompt("review", ctx, { deliverableArtifact }) + retrySection;
  }
  return `You are a code review agent. Review the following deliverable:

Task: ${ctx.task}
Project: ${ctx.project}
${deliverableArtifact ? `\nDeliverable: ${deliverableArtifact.name}\n` : ""}
${retrySection}`;
}

function resolveAgent(ctx: LooseRecord, fallback: string) {
  const role = stringValue(ctx.role, "reviewer");
  const agents = recordValue(ctx.agents);
  const raw = agents[role] || agents.reviewer || ctx.agent || fallback;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const record = recordValue(raw);
    return { agent: stringValue(record.agent, fallback), variant: stringValue(record.variant) || null };
  }
  return { agent: stringValue(raw, fallback), variant: null };
}
