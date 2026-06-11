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
  "remediationStatus": "FIXED",
  "summary": "Added try-catch around database query and proper error response",
  "changes": ["src/routes/api.js", "src/models/user.js"]
}
\`\`\`

Rules:
- The response MUST be valid JSON inside a \`\`\`json code block
- Do NOT include any text outside the code block
- remediationStatus MUST be exactly "FIXED", "UNFIXABLE", or "NEEDS_RETRY"
- Do NOT write any artifact files yourself. The system will persist the remediation report.`;

export async function runRemediate(ctx) {
  const { project, cpbRoot, pool, sourcePath, jobId } = ctx;
  const role = ctx.role || "remediator";

  const prompt = await buildRemediatePrompt(ctx) + JSON_INSTRUCTION;

  const agentResult = await runAgent({
    role,
    ...resolveAgent(ctx, "claude"),
    project,
    jobId,
    prompt,
    cwd: sourcePath || cpbRoot,
    pool,
    scope: ctx.scope || null,
    env: ctx.env || {},
    timeoutMs: ctx.timeouts?.remediate ?? 0,
  });

  if (!agentResult.ok) {
    const failed = agentResult as Record<string, any>;
    return phaseFailed({
      phase: "remediate",
      failure: failure({
        kind: failed.kind,
        phase: "remediate",
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
      phase: "remediate",
      failure: failure({
        kind: FailureKind.AGENT_CONTRACT_INVALID,
        phase: "remediate",
        reason: parsed.reason,
        retryable: true,
      }),
      diagnostics: success.diagnostics,
    });
  }

  const status = parsed.data.remediationStatus || "UNFIXABLE";
  const content = renderRemediationMarkdown(parsed.data);

  const artifact = await writeArtifact(cpbRoot, {
    project,
    jobId,
    kind: "remediation",
    content,
    metadata: { remediationStatus: status },
  });

  if (status !== "FIXED") {
    return phaseFailed({
      phase: "remediate",
      failure: failure({
        kind: FailureKind.VERIFICATION_FAILED,
        phase: "remediate",
        reason: `remediation status: ${status}`,
        retryable: status === "NEEDS_RETRY",
        cause: { remediationStatus: status, artifact },
      }),
      diagnostics: { artifact },
    });
  }

  return phasePassed({
    phase: "remediate",
    artifact,
    diagnostics: success.diagnostics,
  });
}

function renderRemediationMarkdown(data) {
  return `# Remediation Report

## Status
${data.remediationStatus || "UNKNOWN"}

## Summary
${data.summary || "N/A"}

## Changes
${(data.changes || []).map((c) => `- ${c}`).join("\n") || "- None"}
`;
}

async function buildRemediatePrompt(ctx) {
  if (typeof ctx.buildPrompt === "function") {
    return ctx.buildPrompt("remediate", ctx);
  }
  return `You are a remediation agent. Fix the CPB/runtime issues from the failed job:

Task: ${ctx.task}
Project: ${ctx.project}
Job: ${ctx.jobId}

Analyze the failure and apply fixes.`;
}

function resolveAgent(ctx, fallback) {
  const role = ctx.role || "remediator";
  const raw = ctx.agents?.[role] || ctx.agents?.remediator || ctx.agent || fallback;
  if (typeof raw === "object" && raw !== null) return { agent: raw.agent || fallback, variant: raw.variant || null };
  return { agent: raw, variant: null };
}
