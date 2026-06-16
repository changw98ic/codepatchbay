import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { phasePassed, phaseFailed } from "../contracts/phase-result.js";
import { FailureKind, failure } from "../contracts/failure.js";
import { runAgent } from "../agents/agent-runner.js";
import { parseExecutorJson } from "../agents/response-parser.js";
import { writeArtifact } from "../artifacts/artifact-store.js";
import { writePromptArtifact, withPromptArtifactDiagnostics } from "../artifacts/prompt-artifact.js";
import { validateDeliverable } from "../artifacts/validators.js";
import { phaseExecutionContract } from "./prompt-contract.js";
import { normalizeRepoRelativePaths } from "../workflow/acceptance-checklist.js";

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

export async function runExecute(ctx: Record<string, any>) {
  const { project, cpbRoot, pool, sourcePath, jobId } = ctx;
  const { dataRoot } = ctx;
  const role = ctx.role || "executor";
  const planArtifact = getRequiredArtifact(ctx.previousResults, "plan");
  const cwd = sourcePath || cpbRoot;

  // P1-8 fix: capture git snapshot before agent run
  let changedFilesBefore = [];
  try {
    const { stdout } = await execFile("git", ["status", "--porcelain"], { cwd });
    changedFilesBefore = stdout.trim().split("\n").filter(Boolean);
  } catch { /* not a git repo — skip */ }

  const prompt = await buildExecutePrompt(ctx, planArtifact) + JSON_INSTRUCTION;
  const resolvedAgent = resolveAgent(ctx, "claude");
  const promptArtifact = await writePromptArtifact(cpbRoot, {
    project,
    jobId,
    phase: "execute",
    role,
    agent: resolvedAgent.agent,
    prompt,
    dataRoot,
  });

  const agentResult: Record<string, any> = await runAgent({
    role,
    ...resolvedAgent,
    project,
    jobId,
    prompt,
    cwd,
    pool,
    timeoutMs: ctx.timeouts?.execute ?? 0,
    scope: ctx.scope,
    env: ctx.env,
    dataRoot,
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
      diagnostics: withPromptArtifactDiagnostics(agentResult.diagnostics, promptArtifact),
    });
  }

  const parsed: Record<string, any> = parseExecutorJson(agentResult.output) as any;
  if (!parsed.ok) {
    return phaseFailed({
      phase: "execute",
      failure: failure({
        kind: FailureKind.AGENT_CONTRACT_INVALID,
        phase: "execute",
        reason: parsed.reason,
        retryable: true,
        stderrSnippet: agentResult.output.slice(-500),
        cause: { rawOutput: agentResult.output.slice(0, 2000) },
      }),
      diagnostics: withPromptArtifactDiagnostics(agentResult.diagnostics, promptArtifact),
    });
  }

  // P1-8 fix: capture git snapshot after agent run, compute changed files
  const changedFiles = await computeChangedFiles(cwd, changedFilesBefore);

  // Build execution map connecting changed files to checklist items
  const normalizedChangedFiles = normalizeRepoRelativePaths(changedFiles);
  const mappedFiles = normalizeRepoRelativePaths(
    (parsed.checklistMapping || []).flatMap((entry: Record<string, any>) => entry.changedFiles || []),
  );
  const executionMap = {
    schemaVersion: 1,
    jobId,
    project,
    mappings: parsed.checklistMapping || [],
    changedFiles: normalizedChangedFiles,
    unmappedChangedFiles: normalizedChangedFiles.filter(
      (file: string) => !mappedFiles.includes(file),
    ),
  };
  const executionMapArtifact = await writeArtifact(cpbRoot, {
    project,
    jobId,
    kind: "execution-map",
    content: JSON.stringify(executionMap, null, 2),
    dataRoot,
    metadata: executionMap,
  });

  const deliverable = renderDeliverableMarkdown(ctx, planArtifact, parsed, changedFiles);

  const validation: Record<string, any> = validateDeliverable(deliverable, { ...ctx, changedFiles }) as any;
  if (!validation.ok) {
    return phaseFailed({
      phase: "execute",
      failure: failure({
        kind: validation.kind || FailureKind.ARTIFACT_INVALID,
        phase: "execute",
        reason: validation.reason,
        retryable: validation.retryable ?? false,
        cause: { rawOutput: deliverable.slice(0, 2000) },
      }),
      diagnostics: withPromptArtifactDiagnostics({ ...agentResult.diagnostics, executionMapArtifact }, promptArtifact),
    });
  }

  const artifact = await writeArtifact(cpbRoot, {
    project,
    jobId,
    kind: "deliverable",
    content: deliverable,
    dataRoot,
    metadata: { agent: agentResult.agent, changedFiles },
  });

  return phasePassed({
    phase: "execute",
    artifact,
    diagnostics: withPromptArtifactDiagnostics({ ...agentResult.diagnostics, executionMapArtifact }, promptArtifact),
  });
}

async function computeChangedFiles(cwd: string, before: string[]) {
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

function getRequiredArtifact(previousResults: any[], kind: string) {
  for (let i = previousResults.length - 1; i >= 0; i--) {
    if (previousResults[i].artifact?.kind === kind) {
      return previousResults[i].artifact;
    }
  }
  return null;
}

function renderDeliverableMarkdown(ctx: Record<string, any>, planArtifact: Record<string, any> | null, parsed: Record<string, any>, changedFiles: string[]) {
  const changedSection = changedFiles.length > 0
    ? changedFiles.map((f: string) => `- ${f}`).join("\n")
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
${parsed.tests.map((t: string) => `- ${t}`).join("\n") || "- No test descriptions provided"}

## Risks
${parsed.risks.map((r: string) => `- ${r}`).join("\n") || "- None identified"}
`;
}

async function buildExecutePrompt(ctx: Record<string, any>, planArtifact: Record<string, any> | null) {
  if (typeof ctx.buildPrompt === "function") {
    return ctx.buildPrompt("execute", ctx, { planArtifact });
  }
  const retry = ctx.sourceContext?.retry;
  const retrySection = retry && typeof retry === "object"
    ? `

## Previous Attempt Failed
Your previous execution was rejected. Fix the issue and provide a corrected response.

Error type: ${retry.failureKind}
Error: ${retry.failureReason}
${retry.previousOutput ? `\nPrevious output for reference:\n\`\`\`\n${retry.previousOutput}\n\`\`\`` : ""}`
    : "";
  return `You are a software execution agent. Implement the following task:

${phaseExecutionContract("execute")}

Task: ${ctx.task}
Project: ${ctx.project}
${planArtifact ? `\nPlan reference: ${planArtifact.name}\n` : ""}
Execute the implementation. Make code changes as needed.${retrySection}`;
}

function resolveAgent(ctx: Record<string, any>, fallback: string) {
  const role = ctx.role || "executor";
  const raw = ctx.agents?.[role] || ctx.agents?.executor || ctx.agent || fallback;
  if (typeof raw === "object" && raw !== null) return { agent: raw.agent || fallback, variant: raw.variant || null };
  return { agent: raw, variant: null };
}

export { getRequiredArtifact };
