import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { phasePassed, phaseFailed } from "../contracts/phase-result.js";
import { FailureKind, failure } from "../contracts/failure.js";
import { runAgent } from "../agents/agent-runner.js";
import { writeArtifact } from "../artifacts/artifact-store.js";
import { parseAgentJson } from "../agents/response-parser.js";

const execFileAsync = promisify(execFile);

const JSON_INSTRUCTION = `

You MUST respond with ONLY a JSON envelope inside a code block. No text before or after.

Example response:
\`\`\`json
{
  "status": "ok",
  "summary": "PR adds user authentication with JWT tokens. Implementation is mostly sound with a few concerns.",
  "verdict": "changes_requested",
  "comments": [
    { "file": "src/auth/handler.go", "line": 42, "body": "SQL injection risk: user input is interpolated directly into the query string. Use parameterized queries." },
    { "file": "src/middleware/auth.go", "line": 15, "body": "Token expiry check is missing. Add exp claim validation." }
  ],
  "risks": ["No rate limiting on login endpoint", "JWT secret loaded from env without validation"]
}
\`\`\`

Rules:
- The response MUST be valid JSON inside a \`\`\`json code block
- Do NOT include any text outside the code block
- verdict MUST be exactly "approved", "changes_requested", or "needs_discussion"
- Do NOT write any artifact files yourself. The system will persist the review.`;

async function fetchPrDiff(repo, prNumber, { cwd } = {}) {
  try {
    const { stdout } = await execFileAsync("gh", [
      "pr", "diff", String(prNumber),
      "--repo", repo,
    ], { cwd, maxBuffer: 10 * 1024 * 1024 });
    return { ok: true, diff: stdout };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function fetchPrMeta(repo, prNumber, { cwd } = {}) {
  try {
    const { stdout } = await execFileAsync("gh", [
      "pr", "view", String(prNumber),
      "--repo", repo,
      "--json", "title,body,author,baseRefName,headRefName,additions,deletions,changedFiles",
    ], { cwd, maxBuffer: 1024 * 1024 });
    return { ok: true, meta: JSON.parse(stdout) };
  } catch {
    return { ok: true, meta: {} };
  }
}

function buildPrReviewPrompt(diff, meta, context = {}) {
  const metaLines = [];
  if (meta.title) metaLines.push(`Title: ${meta.title}`);
  if (meta.author?.login) metaLines.push(`Author: ${meta.author.login}`);
  if (meta.baseRefName) metaLines.push(`Base: ${meta.baseRefName} → Head: ${meta.headRefName || "unknown"}`);
  if (meta.additions != null) metaLines.push(`+${meta.additions}/-${meta.deletions} across ${meta.changedFiles} files`);
  if (meta.body) metaLines.push(`\nDescription:\n${meta.body.slice(0, 2000)}`);

  return `You are performing a **read-only code review** of a GitHub pull request. Do NOT suggest writing any code or making changes. Only analyze and report findings.

## PR Metadata
${metaLines.join("\n") || "Not available"}

${context.task ? `## Review Focus\n${context.task}\n` : ""}

## Diff (truncated to 8000 lines)
\`\`\`diff
${diff.split("\n").slice(0, 8000).join("\n")}
\`\`\`

Review the diff above and report:
1. Critical issues (security vulnerabilities, data loss risks, logic errors)
2. Important issues (missing error handling, performance problems, incorrect behavior)
3. Minor issues (naming, style, minor improvements)
4. Overall assessment and recommendation`;
}

export async function runPrReview(ctx) {
  const { project, cpbRoot, pool, sourcePath } = ctx;
  const repo = ctx.repo || ctx.metadata?.repo;
  const prNumber = ctx.prNumber || ctx.metadata?.prNumber;

  if (!repo || !prNumber) {
    return phaseFailed({
      phase: "pr-review",
      failure: failure({
        kind: FailureKind.ISSUE_MISMATCH,
        phase: "pr-review",
        reason: "repo and prNumber are required for PR review",
        retryable: false,
      }),
    });
  }

  const cwd = sourcePath || cpbRoot;

  const diffResult = await fetchPrDiff(repo, prNumber, { cwd });
  if (!diffResult.ok) {
    return phaseFailed({
      phase: "pr-review",
      failure: failure({
        kind: FailureKind.AGENT_SPAWN_ERROR,
        phase: "pr-review",
        reason: `failed to fetch PR diff: ${diffResult.error}`,
        retryable: true,
      }),
    });
  }

  if (!diffResult.diff.trim()) {
    return phaseFailed({
      phase: "pr-review",
      failure: failure({
        kind: FailureKind.ARTIFACT_INVALID,
        phase: "pr-review",
        reason: "PR diff is empty",
        retryable: false,
      }),
    });
  }

  const metaResult = await fetchPrMeta(repo, prNumber, { cwd });
  const prompt = buildPrReviewPrompt(diffResult.diff, metaResult.meta || {}, ctx) + JSON_INSTRUCTION;

  const agentResult = await runAgent({
    role: "reviewer",
    agent: ctx.agents?.reviewer || ctx.agent || "codex",
    project,
    prompt,
    cwd,
    pool,
    timeoutMs: ctx.timeouts?.prReview || ctx.timeouts?.review || 600_000,
  });

  if (!agentResult.ok) {
    return phaseFailed({
      phase: "pr-review",
      failure: failure({
        kind: agentResult.kind,
        phase: "pr-review",
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
      phase: "pr-review",
      failure: failure({
        kind: FailureKind.AGENT_CONTRACT_INVALID,
        phase: "pr-review",
        reason: parsed.reason,
        retryable: true,
      }),
      diagnostics: agentResult.diagnostics,
    });
  }

  const content = renderPrReviewMarkdown(parsed.data, repo, prNumber);
  const artifact = await writeArtifact(cpbRoot, {
    project,
    jobId: ctx.jobId,
    kind: "review",
    content,
    metadata: { ...parsed.data, repo, prNumber, reviewType: "pr-review" },
  });

  return phasePassed({
    phase: "pr-review",
    artifact,
    diagnostics: agentResult.diagnostics,
  });
}

function renderPrReviewMarkdown(data, repo, prNumber) {
  const verdictEmoji = data.verdict === "approved" ? "PASS" : data.verdict === "changes_requested" ? "CHANGES REQUESTED" : "NEEDS DISCUSSION";
  return `# PR Review: ${repo}#${prNumber}

## Verdict
${verdictEmoji}

## Summary
${data.summary || "N/A"}

## Comments
${(data.comments || []).map((c) => `- **${c.file}${c.line ? `:${c.line}` : ""}**: ${c.body || c.comment || ""}`).join("\n") || "- None"}

## Risks
${(data.risks || []).map((r) => `- ${r}`).join("\n") || "- None identified"}
`;
}

export { fetchPrDiff, fetchPrMeta, buildPrReviewPrompt };
