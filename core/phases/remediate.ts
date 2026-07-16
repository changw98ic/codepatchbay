import { recordValue, type LooseRecord } from "../../shared/types.js";
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

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

export async function runRemediate(ctx: LooseRecord) {
  const { project, cpbRoot, pool, sourcePath, jobId } = ctx;
  const { dataRoot } = ctx;
  const role = stringValue(ctx.role, "remediator");

  const prompt = await buildRemediatePrompt(ctx) + JSON_INSTRUCTION;

  const agentResult = await runAgent({
    phase: "remediate",
    role,
    ...resolveAgent(ctx, "claude"),
    project,
    jobId,
    prompt,
    cwd: sourcePath || cpbRoot,
    pool,
    scope: ctx.scope || null,
    env: buildPhaseAcpEnv(ctx, "remediate"),
    timeoutMs: typeof recordValue(ctx.timeouts).remediate === "number" ? recordValue(ctx.timeouts).remediate : 0,
    dataRoot,
    onProgress: ctx.onProgress,
  });

  if (!agentResult.ok) {
    const failed = recordValue(agentResult);
    const failureKind = typeof failed.kind === "string" ? failed.kind : FailureKind.UNKNOWN;
    return phaseFailed({
      phase: "remediate",
      failure: failure({
        kind: failureKind,
        phase: "remediate",
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
      phase: "remediate",
      failure: failure({
        kind: FailureKind.AGENT_CONTRACT_INVALID,
        phase: "remediate",
        reason: parsed.reason,
        retryable: true,
      }),
      diagnostics: recordValue(success.diagnostics),
    });
  }

  const parsedData = recordValue(parsed.data);
  const status = stringValue(parsedData.remediationStatus, "UNFIXABLE");
  const content = renderRemediationMarkdown(parsedData);

  const artifact = await writeArtifact(cpbRoot, {
    project,
    jobId,
    kind: "remediation",
    content,
    dataRoot,
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
    diagnostics: recordValue(success.diagnostics),
  });
}

function renderRemediationMarkdown(data: LooseRecord) {
  return `# Remediation Report

## Status
${data.remediationStatus || "UNKNOWN"}

## Summary
${data.summary || "N/A"}

## Changes
${stringArray(data.changes).map((c) => `- ${c}`).join("\n") || "- None"}
`;
}

function buildRetrySection(sourceContext: LooseRecord) {
  const retry = recordValue(sourceContext.retry);
  if (Object.keys(retry).length === 0) return "";
  return `

## Previous Attempt Failed
Your previous remediation pass was rejected. Rerun this same phase with the corrected behavior below.

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

async function buildRemediatePrompt(ctx: LooseRecord) {
  const retrySection = buildRetrySection(recordValue(ctx.sourceContext));
  if (typeof ctx.buildPrompt === "function") {
    return await ctx.buildPrompt("remediate", ctx) + retrySection;
  }
  return `You are a remediation agent. Fix the CPB/runtime issues from the failed job:

Task: ${ctx.task}
Project: ${ctx.project}
Job: ${ctx.jobId}

Analyze the failure and apply fixes.
${retrySection}`;
}

function resolveAgent(ctx: LooseRecord, fallback: string) {
  const role = stringValue(ctx.role, "remediator");
  const agents = recordValue(ctx.agents);
  const raw = agents[role] || agents.remediator || ctx.agent || fallback;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const record = recordValue(raw);
    return { agent: stringValue(record.agent, fallback), variant: stringValue(record.variant) || null };
  }
  return { agent: stringValue(raw, fallback), variant: null };
}
