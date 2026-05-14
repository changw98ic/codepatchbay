#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { createSession, getSession, updateSession, parseIssues } from "../server/services/review-session.js";

const FLOW_ROOT = path.resolve(".");
const ACP_CLIENT = path.join(FLOW_ROOT, "bridges/acp-client.mjs");

const ACP_STUCK_MS = parseInt(process.env.ACP_STUCK_MS || "300000", 10);

function acpRun(agent, prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [ACP_CLIENT, "--agent", agent], {
      cwd: FLOW_ROOT,
      env: { ...process.env, FLOW_ROOT },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let lastActivity = Date.now();
    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      fn(arg);
    };

    child.stdout.on("data", (chunk) => { lastActivity = Date.now(); stdout += chunk; });
    child.stderr.on("data", (chunk) => { lastActivity = Date.now(); stderr += chunk; });

    child.on("exit", (code) => {
      if (code === 0) settle(resolve, stdout.trim());
      else settle(reject, new Error(`${agent} exited ${code}: ${stderr.slice(-200)}`));
    });
    child.on("error", (err) => settle(reject, err));

    child.stdin.write(prompt);
    child.stdin.end();

    const watchdog = setInterval(() => {
      if (Date.now() - lastActivity > ACP_STUCK_MS) {
        child.kill("SIGKILL");
        settle(reject, new Error(`${agent} heartbeat timeout: no activity for ${ACP_STUCK_MS}ms`));
      }
    }, 10000);
  });
}

function researchPrompt(intent, project) {
  return `You are Flow Research Agent. Analyze this task intent for project "${project}":

**Task**: ${intent}

Provide:
1. Feasibility assessment (technical complexity, estimated effort)
2. Key risks and dependencies
3. Suggested approach (high-level)
4. Questions or ambiguities that need clarification

Be concise and structured.`;
}

function planPrompt(intent, codexResearch, claudeResearch) {
  return `You are Flow Planner. Based on the research below, create an implementation plan.

**Task**: ${intent}

**Codex Research**:
${codexResearch || "N/A"}

**Claude Research**:
${claudeResearch || "N/A"}

Create a structured plan with:
1. Clear phases with deliverables
2. File-by-file changes
3. Risk mitigation strategies
4. Acceptance criteria

Output the plan as markdown.`;
}

function reviewPrompt(plan, reviewer) {
  return `You are Flow ${reviewer === "codex" ? "Architecture" : "Security & Quality"} Reviewer.
Review this plan critically. For each issue found, use severity tags [P0] [P1] [P2] [P3]:

- [P0] Critical: Will cause system failure or data loss
- [P1] High: Major functional defect or security vulnerability
- [P2] Medium: Performance issue, poor design, or missing edge case
- [P3] Low: Style, naming, or minor improvement

If the plan has no P2+ issues, respond with: "REVIEW: PASS"

**Plan to review**:
${plan}`;
}

function revisePrompt(plan, codexIssues, claudeIssues) {
  const allIssues = [...codexIssues, ...claudeIssues]
    .filter(i => i.severity >= 2)
    .map(i => `[P${i.severity}] ${i.description}`)
    .join("\n");

  return `You are Flow Plan Reviser. Revise this plan to address the issues below.

**Issues found by reviewers**:
${allIssues}

**Original plan**:
${plan}

Provide the revised plan as markdown, addressing each issue.`;
}

async function runReview(flowRoot, sessionId) {
  const session = await getSession(flowRoot, sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);

  try {
    // Phase 1: Research (parallel)
    await updateSession(flowRoot, sessionId, { status: "researching" });
    const [codexResearch, claudeResearch] = await Promise.all([
      acpRun("codex", researchPrompt(session.intent, session.project)),
      acpRun("claude", researchPrompt(session.intent, session.project)),
    ]);
    await updateSession(flowRoot, sessionId, {
      research: { codex: codexResearch, claude: claudeResearch },
    });

    // Phase 2: Plan
    await updateSession(flowRoot, sessionId, { status: "planning" });
    const plan = await acpRun("codex", planPrompt(session.intent, codexResearch, claudeResearch));
    await updateSession(flowRoot, sessionId, { plan });

    // Phase 3: Review Loop (max 5 rounds)
    let currentPlan = plan;
    for (let round = 1; round <= 5; round++) {
      await updateSession(flowRoot, sessionId, { status: "reviewing", round });

      const [codexReview, claudeReview] = await Promise.all([
        acpRun("codex", reviewPrompt(currentPlan, "codex")),
        acpRun("claude", reviewPrompt(currentPlan, "claude")),
      ]);

      const codexIssues = parseIssues(codexReview);
      const claudeIssues = parseIssues(claudeReview);

      const reviews = (await getSession(flowRoot, sessionId)).reviews;
      await updateSession(flowRoot, sessionId, {
        reviews: [...reviews, { round, codex: codexReview, claude: claudeReview, codexIssues, claudeIssues }],
      });

      const hasP2 = [...codexIssues, ...claudeIssues].some((i) => i.severity >= 2);
      if (!hasP2) {
        await updateSession(flowRoot, sessionId, { status: "user_review" });
        console.log(`[review] session ${sessionId} passed review at round ${round}`);
        return;
      }

      if (round < 5) {
        await updateSession(flowRoot, sessionId, { status: "revising" });
        const revised = await acpRun("codex", revisePrompt(currentPlan, codexIssues, claudeIssues));
        currentPlan = revised;
        await updateSession(flowRoot, sessionId, { plan: revised });
      }
    }

    // Exhausted rounds
    await updateSession(flowRoot, sessionId, { status: "expired" });
    console.log(`[review] session ${sessionId} expired after 5 rounds`);
  } catch (err) {
    console.error(`[review] session ${sessionId} error: ${err.message}`);
    try { await updateSession(flowRoot, sessionId, { status: "expired" }); } catch {}
  }
}

// CLI entry: review-dispatch.mjs <flowRoot> <sessionId>
const flowRoot = process.argv[2];
const sessionId = process.argv[3];
if (!flowRoot || !sessionId) {
  console.error("Usage: review-dispatch.mjs <flowRoot> <sessionId>");
  process.exit(1);
}

runReview(flowRoot, sessionId);
