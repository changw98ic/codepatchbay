import { phasePassed, phaseFailed } from "../contracts/phase-result.js";
import { FailureKind, failure } from "../contracts/failure.js";
import { runAgent } from "../agents/agent-runner.js";
import { parsePlannerJson } from "../agents/response-parser.js";
import { writeArtifact } from "../artifacts/artifact-store.js";
import { validatePlanMarkdown } from "../artifacts/validators.js";

const JSON_INSTRUCTION = `

You MUST respond with ONLY a JSON envelope inside a code block. No text before or after.

Example response:
\`\`\`json
{
  "status": "ok",
  "planMarkdown": "## Analysis\\n- The task requires adding a new REST endpoint\\n\\n## Files to modify\\n- src/routes/api.js (add GET /users endpoint)\\n- src/models/user.js (add findAll method)\\n\\n## Implementation Steps\\n1. Add findAll() to User model\\n2. Add GET /users route handler\\n3. Add input validation\\n\\n## Testing\\n- Unit test for findAll()\\n- Integration test for GET /users\\n\\n## Risks\\n- Large result sets may need pagination"
}
\`\`\`

Rules:
- The response MUST be valid JSON inside a \`\`\`json code block
- Do NOT include any text outside the code block
- The planMarkdown field must contain the full plan in markdown
- Do NOT write any files yourself. The system will persist the plan`;

export async function runPlan(ctx) {
  const { task, project, cpbRoot, pool, sourcePath, jobId } = ctx;

  // Build prompt — reuse existing prompt-builder if available, else minimal
  const prompt = await buildPlanPrompt(ctx) + JSON_INSTRUCTION;

  const agentResult = await runAgent({
    role: "planner",
    ...resolveAgent(ctx, "codex"),
    project,
    prompt,
    cwd: sourcePath || cpbRoot,
    pool,
    timeoutMs: ctx.timeouts?.plan ?? 0,
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

  const { task, project } = ctx;
  const agent = resolveAgent(ctx, "codex").agent;
  const isBrowserAgent = agent === "browser-agent";

  let repoSection = "";
  if (isBrowserAgent && ctx.sourcePath) {
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const { stdout } = await promisify(execFile)("git", ["remote", "get-url", "origin"], {
        cwd: ctx.sourcePath,
        encoding: "utf8",
        timeout: 5000,
      });
      const remoteUrl = stdout.trim();
      const ghUrl = remoteUrl.replace(/\.git$/, "").replace("git@github.com:", "https://github.com/");
      repoSection = `

## Repository
The source code is at: ${ghUrl}
Browse the repository to understand the codebase before planning.`;
    } catch {}
  }

  let filesSection = "";
  const contextPack = ctx.sourceContext?.contextPack || ctx.sourceContext;
  if (contextPack?.files?.length) {
    filesSection = `

## Relevant Files
${contextPack.files.map((f) => `- ${f}`).join("\n")}`;
  }

  return `You are a software planning agent. Create a detailed implementation plan for the following task:
${repoSection}${filesSection}

## Task
${task}

## Project
${project}

The plan should include:
- Analysis of the task requirements
- Files that need to be modified or created
- Implementation steps in order
- Testing strategy
- Potential risks and mitigations`;
}

function resolveAgent(ctx, fallback) {
  const raw = ctx.agents?.planner || ctx.agent || fallback;
  if (typeof raw === "object" && raw !== null) return { agent: raw.agent || fallback, variant: raw.variant || null };
  return { agent: raw, variant: null };
}
