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
  "repairStatus": "FIXED",
  "summary": "Added try-catch around database query and proper error response",
  "changes": ["src/routes/api.js", "src/models/user.js"]
}
\`\`\`

Rules:
- The response MUST be valid JSON inside a \`\`\`json code block
- Do NOT include any text outside the code block
- repairStatus MUST be exactly "FIXED", "UNFIXABLE", or "NEEDS_RETRY"
- Do NOT write any artifact files yourself. The system will persist the repair report.`;

export async function runRepair(ctx) {
  const { project, cpbRoot, pool, sourcePath, jobId } = ctx;

  const prompt = await buildRepairPrompt(ctx) + JSON_INSTRUCTION;

  const agentResult = await runAgent({
    role: "repairer",
    ...resolveAgent(ctx, "claude"),
    project,
    prompt,
    cwd: sourcePath || cpbRoot,
    pool,
    timeoutMs: ctx.timeouts?.repair || 1_200_000,
  });

  if (!agentResult.ok) {
    return phaseFailed({
      phase: "repair",
      failure: failure({
        kind: agentResult.kind,
        phase: "repair",
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
      phase: "repair",
      failure: failure({
        kind: FailureKind.AGENT_CONTRACT_INVALID,
        phase: "repair",
        reason: parsed.reason,
        retryable: true,
      }),
      diagnostics: agentResult.diagnostics,
    });
  }

  const status = parsed.data.repairStatus || "UNFIXABLE";
  const content = renderRepairMarkdown(parsed.data);

  const artifact = await writeArtifact(cpbRoot, {
    project,
    jobId,
    kind: "repair",
    content,
    metadata: { repairStatus: status },
  });

  if (status !== "FIXED") {
    return phaseFailed({
      phase: "repair",
      failure: failure({
        kind: FailureKind.VERIFICATION_FAILED,
        phase: "repair",
        reason: `repair status: ${status}`,
        retryable: status === "NEEDS_RETRY",
        cause: { repairStatus: status, artifact },
      }),
      diagnostics: { artifact },
    });
  }

  return phasePassed({
    phase: "repair",
    artifact,
    diagnostics: agentResult.diagnostics,
  });
}

function renderRepairMarkdown(data) {
  return `# Repair Report

## Status
${data.repairStatus || "UNKNOWN"}

## Summary
${data.summary || "N/A"}

## Changes
${(data.changes || []).map((c) => `- ${c}`).join("\n") || "- None"}
`;
}

async function buildRepairPrompt(ctx) {
  if (typeof ctx.buildPrompt === "function") {
    return ctx.buildPrompt("repair", ctx);
  }
  return `You are a repair agent. Fix the issues from the failed job:

Task: ${ctx.task}
Project: ${ctx.project}
Job: ${ctx.jobId}

Analyze the failure and apply fixes.`;
}

function resolveAgent(ctx, fallback) {
  const raw = ctx.agents?.repairer || ctx.agent || fallback;
  if (typeof raw === "object" && raw !== null) return { agent: raw.agent || fallback, variant: raw.variant || null };
  return { agent: raw, variant: null };
}
