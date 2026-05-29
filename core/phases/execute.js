import { phasePassed, phaseFailed } from "../contracts/phase-result.js";
import { FailureKind, failure } from "../contracts/failure.js";
import { runAgent } from "../agents/agent-runner.js";
import { parseExecutorJson } from "../agents/response-parser.js";
import { writeArtifact } from "../artifacts/artifact-store.js";
import { validateDeliverable } from "../artifacts/validators.js";

const JSON_INSTRUCTION = `

You MUST respond with a JSON envelope:
\`\`\`json
{
  "status": "ok",
  "summary": "brief summary of changes",
  "tests": ["test descriptions or file paths"],
  "risks": ["any risks or concerns"]
}
\`\`\`

Do NOT write any artifact files yourself. The system will persist the deliverable.`;

export async function runExecute(ctx) {
  const { project, cpbRoot, pool, sourcePath, jobId } = ctx;
  const planArtifact = getRequiredArtifact(ctx.previousResults, "plan");

  const prompt = await buildExecutePrompt(ctx, planArtifact) + JSON_INSTRUCTION;

  const agentResult = await runAgent({
    role: "executor",
    agent: resolveAgent(ctx, "claude"),
    project,
    prompt,
    cwd: sourcePath || cpbRoot,
    pool,
    timeoutMs: ctx.timeouts?.execute || 1_800_000,
  });

  if (!agentResult.ok) {
    return phaseFailed({
      phase: "execute",
      failure: failure({
        kind: agentResult.kind,
        phase: "execute",
        reason: agentResult.reason,
        retryable: agentResult.retryable,
        exitCode: agentResult.exitCode,
        signal: agentResult.signal,
        cause: agentResult.cause || {},
      }),
      diagnostics: agentResult.diagnostics,
    });
  }

  const parsed = parseExecutorJson(agentResult.output);
  if (!parsed.ok) {
    return phaseFailed({
      phase: "execute",
      failure: failure({
        kind: FailureKind.AGENT_CONTRACT_INVALID,
        phase: "execute",
        reason: parsed.reason,
        retryable: true,
        stderrSnippet: agentResult.output.slice(-500),
      }),
      diagnostics: agentResult.diagnostics,
    });
  }

  const deliverable = renderDeliverableMarkdown(ctx, planArtifact, parsed);

  const validation = validateDeliverable(deliverable, ctx);
  if (!validation.ok) {
    return phaseFailed({
      phase: "execute",
      failure: failure({
        kind: validation.kind || FailureKind.ARTIFACT_INVALID,
        phase: "execute",
        reason: validation.reason,
        retryable: validation.retryable ?? false,
      }),
      diagnostics: agentResult.diagnostics,
    });
  }

  const artifact = await writeArtifact(cpbRoot, {
    project,
    jobId,
    kind: "deliverable",
    content: deliverable,
    metadata: { agent: agentResult.agent },
  });

  return phasePassed({
    phase: "execute",
    artifact,
    diagnostics: agentResult.diagnostics,
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

function renderDeliverableMarkdown(ctx, planArtifact, parsed) {
  return `# Deliverable

## Task
${ctx.task}

## Plan
${planArtifact ? `See ${planArtifact.name}` : "No plan artifact"}

## Summary
${parsed.summary}

## Tests
${parsed.tests.map((t) => `- ${t}`).join("\n") || "- No test descriptions provided"}

## Risks
${parsed.risks.map((r) => `- ${r}`).join("\n") || "- None identified"}
`;
}

async function buildExecutePrompt(ctx, planArtifact) {
  if (typeof ctx.buildPrompt === "function") {
    return ctx.buildPrompt("execute", ctx, { planArtifact });
  }
  return `You are a software execution agent. Implement the following task:

Task: ${ctx.task}
Project: ${ctx.project}
${planArtifact ? `\nPlan reference: ${planArtifact.name}\n` : ""}
Execute the implementation. Make code changes as needed.`;
}

function resolveAgent(ctx, fallback) {
  return ctx.agents?.executor || ctx.agent || fallback;
}

export { getRequiredArtifact };
