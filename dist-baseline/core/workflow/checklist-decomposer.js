import { runAgent } from "../agents/agent-runner.js";
import { parseAgentJson } from "../agents/response-parser.js";
import { validateDecomposedItems } from "./acceptance-checklist.js";
function resolvePlanner(ctx) {
    const raw = ctx.agents?.planner || ctx.agent || "codex";
    if (typeof raw === "object" && raw !== null)
        return { agent: raw.agent || "codex", variant: raw.variant || null };
    return { agent: raw, variant: null };
}
export function buildDecomposePrompt(task, documents = []) {
    const docSection = documents.length > 0
        ? `\n\n## Reference documents\n${documents.map((d) => `- ${d.locator || d.path}`).join("\n")}`
        : "";
    return `You are decomposing a task into structured acceptance-checklist items for a coding-agent pipeline.

## Task
${task}${docSection}

## Your job
Inspect the local code (read-only commands only) and break this task into one or more acceptance items. Each item states ONE verifiable requirement, the files its implementation is allowed to touch (allowedFiles), and how it should be verified (verificationMethod).

## verificationMethod (pick one per item)
- "static": a file-scope change — the probe checks the declared files were modified. Use for most code changes.
- "command": verified by a shell command with exit code 0 (build/lint). Put the command in expectedEvidence.
- "test": verified by a test run.
- "manual": requires human approval (rare).

## Rules
- allowedFiles MUST be non-empty repo-relative POSIX paths (e.g. "src/auth.ts") for every item — this is the scope the probe runner checks. List ONLY files this item's implementation is expected to touch.
- predicateId MUST be a short unique id per item (e.g. "auth-token-expiry", "status-json-flag").
- sourceRefs should cite { "kind": "task_text", "locator": "task:0" } (the task) or a document locator.
- Inspect the repo first; do NOT invent unrelated files.

## Output — a single JSON code block, nothing outside it
\`\`\`json
{
  "status": "ok",
  "decomposedItems": [
    {
      "requirement": "<one verifiable requirement>",
      "predicateId": "<unique-id>",
      "verificationMethod": "static",
      "allowedFiles": ["src/path/file.ts"],
      "sourceRefs": [{ "kind": "task_text", "locator": "task:0" }],
      "expectedEvidence": "<optional, for command/test methods>"
    }
  ]
}
\`\`\``;
}
/**
 * Decompose a task into structured acceptance items via the planner agent.
 * Fail-closed: any agent / parse / validation failure -> { ok:false, reason }.
 * The caller (freezeChecklistAndMaterializeDag) must block the job
 * ARTIFACT_INVALID on failure — it must NOT silently fall through to the
 * deterministic []-scope builder, otherwise production stays broken.
 */
export async function decomposeTaskToChecklistItems({ task, documents = [], ctx, }) {
    const { agent, variant } = resolvePlanner(ctx);
    const prompt = buildDecomposePrompt(task, documents);
    const agentResult = await runAgent({
        role: "planner",
        agent,
        variant,
        project: ctx.project,
        jobId: ctx.jobId,
        prompt,
        cwd: ctx.sourcePath || ctx.cpbRoot,
        pool: ctx.pool || ctx.getPool?.(),
        timeoutMs: ctx.timeouts?.decompose ?? ctx.timeouts?.plan ?? 0,
        scope: ctx.scope,
        env: ctx.env,
        dataRoot: ctx.dataRoot,
    });
    if (!agentResult.ok) {
        return { ok: false, reason: `decompose agent failed: ${agentResult.kind || agentResult.error || "unknown"}` };
    }
    const parsed = parseAgentJson(agentResult.output);
    if (!parsed.ok) {
        return { ok: false, reason: `decompose output is not valid JSON: ${parsed.reason}` };
    }
    const items = parsed.data?.decomposedItems;
    const validation = validateDecomposedItems(items);
    if (!validation.ok) {
        return { ok: false, reason: `decomposed items invalid: ${validation.reason}` };
    }
    return { ok: true, items: items };
}
