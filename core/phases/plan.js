import { phasePassed, phaseFailed } from "../contracts/phase-result.js";
import { FailureKind, failure } from "../contracts/failure.js";
import { runAgent } from "../agents/agent-runner.js";
import { parsePlannerJson } from "../agents/response-parser.js";
import { writeArtifact } from "../artifacts/artifact-store.js";
import { validatePlanMarkdown } from "../artifacts/validators.js";

const JSON_INSTRUCTION = `

You MUST respond with a JSON envelope:
\`\`\`json
{
  "status": "ok",
  "planMarkdown": "...your plan in markdown..."
}
\`\`\`

Do NOT wrap the plan in any other format. The planMarkdown field must contain the full plan.
Do NOT write any files yourself. The system will persist the plan.`;

export async function runPlan(ctx) {
  const { task, project, cpbRoot, pool, sourcePath, jobId } = ctx;

  // Build prompt — reuse existing prompt-builder if available, else minimal
  const prompt = await buildPlanPrompt(ctx) + JSON_INSTRUCTION;

  const agentResult = await runAgent({
    role: "planner",
    agent: resolveAgent(ctx, "codex"),
    project,
    prompt,
    cwd: sourcePath || cpbRoot,
    pool,
    timeoutMs: ctx.timeouts?.plan || 600_000,
  });

  if (!agentResult.ok) {
    return phaseFailed({
      phase: "plan",
      failure: failure({
        kind: agentResult.kind,
        phase: "plan",
        reason: agentResult.reason,
        retryable: agentResult.retryable,
        exitCode: agentResult.exitCode,
        signal: agentResult.signal,
        cause: agentResult.cause || {},
      }),
      diagnostics: agentResult.diagnostics,
    });
  }

  const parsed = parsePlannerJson(agentResult.output);
  if (!parsed.ok) {
    return phaseFailed({
      phase: "plan",
      failure: failure({
        kind: FailureKind.AGENT_CONTRACT_INVALID,
        phase: "plan",
        reason: parsed.reason,
        retryable: true,
        stderrSnippet: agentResult.output.slice(-500),
      }),
      diagnostics: agentResult.diagnostics,
    });
  }

  const validation = validatePlanMarkdown(parsed.planMarkdown);
  if (!validation.ok) {
    return phaseFailed({
      phase: "plan",
      failure: failure({
        kind: FailureKind.ARTIFACT_INVALID,
        phase: "plan",
        reason: validation.reason,
        retryable: true,
      }),
      diagnostics: agentResult.diagnostics,
    });
  }

  const artifact = await writeArtifact(cpbRoot, {
    project,
    jobId,
    kind: "plan",
    content: parsed.planMarkdown,
    metadata: { task, agent: agentResult.agent },
  });

  return phasePassed({
    phase: "plan",
    artifact,
    diagnostics: agentResult.diagnostics,
  });
}

async function buildPlanPrompt(ctx) {
  if (typeof ctx.buildPrompt === "function") {
    return ctx.buildPrompt("plan", ctx);
  }
  return `You are a software planning agent. Create a detailed implementation plan for the following task:

Task: ${ctx.task}
Project: ${ctx.project}

The plan should include:
- Analysis of the task requirements
- Files that need to be modified or created
- Implementation steps in order
- Testing strategy
- Potential risks and mitigations`;
}

function resolveAgent(ctx, fallback) {
  return ctx.agents?.planner || ctx.agent || fallback;
}
