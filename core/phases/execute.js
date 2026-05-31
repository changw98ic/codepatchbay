import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { phasePassed, phaseFailed } from "../contracts/phase-result.js";
import { FailureKind, failure } from "../contracts/failure.js";
import { runAgent } from "../agents/agent-runner.js";
import { parseExecutorJson } from "../agents/response-parser.js";
import { writeArtifact } from "../artifacts/artifact-store.js";
import { validateDeliverable } from "../artifacts/validators.js";

const execFile = promisify(execFileCb);

const JSON_INSTRUCTION = `

You MUST respond with ONLY a JSON envelope inside a code block. No text before or after.

Example response:
\`\`\`json
{
  "status": "ok",
  "summary": "Added GET /users endpoint with pagination support and input validation",
  "tests": ["src/routes/api.test.js: returns paginated users", "src/models/user.test.js: findAll respects limit param"],
  "risks": ["No rate limiting on the new endpoint", "Default page size may be too large for big datasets"]
}
\`\`\`

Rules:
- The response MUST be valid JSON inside a \`\`\`json code block
- Do NOT include any text outside the code block
- Do NOT write any artifact files yourself. The system will persist the deliverable.`;

export async function runExecute(ctx) {
  const { project, cpbRoot, pool, sourcePath, jobId } = ctx;
  const planArtifact = getRequiredArtifact(ctx.previousResults, "plan");
  const cwd = sourcePath || cpbRoot;

  // P1-8 fix: capture git snapshot before agent run
  let changedFilesBefore = [];
  try {
    const { stdout } = await execFile("git", ["status", "--porcelain"], { cwd });
    changedFilesBefore = stdout.trim().split("\n").filter(Boolean);
  } catch { /* not a git repo — skip */ }

  const prompt = await buildExecutePrompt(ctx, planArtifact) + JSON_INSTRUCTION;

  const agentResult = await runAgent({
    role: "executor",
    ...resolveAgent(ctx, "claude"),
    project,
    prompt,
    cwd,
    pool,
    timeoutMs: ctx.timeouts?.execute ?? 0,
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

  // P1-8 fix: capture git snapshot after agent run, compute changed files
  const changedFiles = await computeChangedFiles(cwd, changedFilesBefore);

  const deliverable = renderDeliverableMarkdown(ctx, planArtifact, parsed, changedFiles);

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
    metadata: { agent: agentResult.agent, changedFiles },
  });

  return phasePassed({
    phase: "execute",
    artifact,
    diagnostics: agentResult.diagnostics,
  });
}

async function computeChangedFiles(cwd, before) {
  try {
    const { stdout } = await execFile("git", ["status", "--porcelain"], { cwd });
    const after = stdout.trim().split("\n").filter(Boolean);
    // Files that are new or modified compared to before
    const beforeSet = new Set(before);
    return after.filter(line => !beforeSet.has(line));
  } catch {
    return [];
  }
}

function getRequiredArtifact(previousResults, kind) {
  for (let i = previousResults.length - 1; i >= 0; i--) {
    if (previousResults[i].artifact?.kind === kind) {
      return previousResults[i].artifact;
    }
  }
  return null;
}

function renderDeliverableMarkdown(ctx, planArtifact, parsed, changedFiles) {
  const changedSection = changedFiles.length > 0
    ? changedFiles.map((f) => `- ${f}`).join("\n")
    : "- No file changes detected";
  return `# Deliverable

## Task
${ctx.task}

## Plan
${planArtifact ? `See ${planArtifact.name}` : "No plan artifact"}

## Summary
${parsed.summary}

## Changed Files
${changedSection}

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
  const raw = ctx.agents?.executor || ctx.agent || fallback;
  if (typeof raw === "object" && raw !== null) return { agent: raw.agent || fallback, variant: raw.variant || null };
  return { agent: raw, variant: null };
}

export { getRequiredArtifact };
