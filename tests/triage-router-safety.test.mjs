import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyRoute } from "../core/workflow/triage.js";
import { actualDiffRiskGuard } from "../core/triage/rules.js";
import { parseAcpTriagerResponse, triageIssue } from "../server/services/issue-triage.js";
import { parseChannelCommand } from "../server/services/channel-commands.js";
import { createChannelQueueJob } from "../server/services/event-source.js";
import { normalizeGithubWebhookEvent } from "../server/services/github-events.js";
import { matchGithubTrigger } from "../server/services/github-triggers.js";
import { DEFAULT_GITHUB_TRIGGERS } from "../server/services/hub-registry.js";
import { createGithubIssueQueueJob } from "../server/services/event-source.js";
import { verifySddProject } from "../server/services/sdd.js";
import { resolveParentPlanCache, writeParentPlanCache } from "../server/services/plan-cache.js";
import { buildExecutorJobPrompt, buildPlannerPrompt } from "../server/services/prompt-builder.js";

describe("issue triage safety lattice", () => {
  it("treats deterministic docs/test rules as requested downgrades, not base authority", () => {
    const decision = triageIssue({
      labels: ["docs"],
      title: "Docs: update README examples",
      actor: "drive-by",
    });

    assert.equal(decision.ruleRoute.workflow, "direct");
    assert.equal(decision.ruleRoute.planMode, "none");
    assert.equal(decision.requestedRoute.workflow, "direct");
    assert.equal(decision.effectiveRoute.workflow, "standard");
    assert.equal(decision.effectiveRoute.planMode, "light");
    assert.equal(decision.actorTrust.trusted, false);
    assert.equal(decision.downgradeAllowed, false);
  });

  it("allows trusted actors to take low-risk docs/test downgrades", () => {
    const decision = triageIssue({
      labels: ["docs"],
      title: "Docs: update README examples",
      actor: "maintainer",
      authorAssociation: "OWNER",
    });

    assert.equal(decision.ruleRoute.workflow, "direct");
    assert.equal(decision.effectiveRoute.workflow, "direct");
    assert.equal(decision.effectiveRoute.planMode, "none");
    assert.equal(decision.actorTrust.trusted, true);
  });

  it("prevents untrusted downgrade when protected scopes are present", () => {
    const decision = triageIssue({
      labels: ["docs"],
      title: "Docs: fix auth token rotation",
      actor: "unknown-user",
      requestedRoute: { workflow: "direct", planMode: "none", source: "label" },
    });

    assert.equal(decision.requestedRoute.workflow, "direct");
    assert.equal(decision.effectiveRoute.workflow, "complex");
    assert.equal(decision.effectiveRoute.planMode, "full");
    assert.equal(decision.effectiveRoute.reviewer, true);
    assert.equal(decision.downgradeAllowed, false);
    assert.ok(decision.protectedScopes.some((scope) => scope.scope === "auth"));
    assert.ok(decision.protectedScopes.some((scope) => scope.scope === "security"));
  });

  it("merges ACP triager upgrades as requested routes before policy evaluation", () => {
    const parsed = parseAcpTriagerResponse(JSON.stringify({
      requestedRoute: {
        workflow: "complex",
        planMode: "full",
        reviewer: true,
        reason: "ACP saw cross-service data migration risk",
      },
    }));
    const decision = triageIssue({
      labels: ["feature"],
      title: "Refactor report exporting",
      actor: "maintainer",
      authorAssociation: "MEMBER",
    }, { acpRoute: parsed.requestedRoute });

    assert.equal(decision.acpRoute.workflow, "complex");
    assert.equal(decision.effectiveRoute.workflow, "complex");
    assert.equal(decision.effectiveRoute.planMode, "full");
    assert.equal(decision.effectiveRoute.reviewer, true);
  });

  it("raises actual diff risk from protected file paths", () => {
    const guard = actualDiffRiskGuard({
      files: ["server/auth/session.js", "docs/README.md"],
    });

    assert.equal(guard.actualDiffRisk.protected, true);
    assert.ok(guard.protectedScopes.some((scope) => scope.scope === "auth"));

    const decision = triageIssue({
      labels: ["docs"],
      title: "Docs cleanup",
      actor: "maintainer",
      authorAssociation: "MEMBER",
      requestedRoute: { workflow: "direct", planMode: "none", source: "command" },
      changedFiles: ["server/auth/session.js"],
    });
    assert.equal(decision.effectiveRoute.workflow, "complex");
    assert.equal(decision.effectiveRoute.planMode, "full");
  });

  it("preserves the legacy classifyRoute compatibility shape", () => {
    const route = classifyRoute({ labels: ["sdd"], title: "Add checkout flow spec" });

    assert.deepEqual(route.effective, { workflow: "sdd-standard", planMode: "parent" });
    assert.equal(route.effectiveRoute.workflow, "sdd-standard");
    assert.equal(route.planMode, "parent");
  });
});

describe("channel command triage", () => {
  it("parses plan-mode and triage parameters then queues the effective route", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-channel-triage-"));
    const hubRoot = path.join(cpbRoot, "hub");
    try {
      const command = parseChannelCommand('/cpb run frontend --workflow direct --plan-mode none --triage rules "fix auth token docs"');
      assert.equal(command.ok, true);

      const result = await createChannelQueueJob(
        cpbRoot,
        command,
        { channel: "slack", actor: "U123", commandText: "/cpb run ..." },
        { hubRoot },
      );

      assert.equal(result.queueEntry.metadata.requestedRoute.workflow, "direct");
      assert.equal(result.queueEntry.metadata.requestedRoute.planMode, "none");
      assert.equal(result.queueEntry.metadata.workflow, "complex");
      assert.equal(result.queueEntry.metadata.planMode, "full");
      assert.equal(result.queueEntry.metadata.routing.effective.workflow, "complex");
      assert.equal(result.queueEntry.metadata.routing.downgradeAllowed, false);
    } finally {
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  it("keeps --triage none as safety-policy-only, not a policy bypass", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-channel-triage-none-"));
    const hubRoot = path.join(cpbRoot, "hub");
    try {
      const command = parseChannelCommand('/cpb run frontend --workflow direct --plan-mode none --triage none "fix auth token docs"');
      const result = await createChannelQueueJob(
        cpbRoot,
        command,
        { channel: "slack", actor: "U123", commandText: "/cpb run ..." },
        { hubRoot },
      );

      assert.equal(result.queueEntry.metadata.triage, "none");
      assert.equal(result.queueEntry.metadata.requestedRoute.workflow, "direct");
      assert.equal(result.queueEntry.metadata.workflow, "complex");
      assert.equal(result.queueEntry.metadata.planMode, "full");
      assert.equal(result.queueEntry.metadata.routing.triageMode, "none");
      assert.equal(result.queueEntry.metadata.routing.effective.workflow, "complex");
    } finally {
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });
});

describe("ACP triage entry wiring", () => {
  it("uses the ACP triager at GitHub ingress when requested", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-github-acp-triage-"));
    let acpCalls = 0;
    try {
      const event = normalizeGithubWebhookEvent({
        event: "issues",
        delivery: "delivery-acp-triage-1",
        projectId: "frontend",
        payload: {
          action: "labeled",
          repository: { full_name: "my-org/frontend" },
          label: { name: "cpb" },
          issue: {
            number: 445,
            title: "Improve report export",
            body: "Touches multiple service boundaries.",
            html_url: "https://github.com/my-org/frontend/issues/445",
            labels: [{ name: "cpb" }],
          },
          sender: { login: "octocat" },
        },
      });
      const match = matchGithubTrigger(event);
      const acpPool = {
        execute: async (_agent, prompt) => {
          acpCalls += 1;
          assert.match(prompt, /CodePatchBay issue routing triager/);
          return JSON.stringify({
            requestedRoute: {
              workflow: "complex",
              planMode: "full",
              reviewer: true,
              reason: "ACP saw cross-service risk",
            },
          });
        },
      };

      const result = await createGithubIssueQueueJob(cpbRoot, event, match, {
        triageMode: "acp",
        acpPool,
      });

      assert.equal(acpCalls, 1);
      assert.equal(result.queueEntry.metadata.workflow, "complex");
      assert.equal(result.queueEntry.metadata.planMode, "full");
      assert.equal(result.queueEntry.metadata.routing.triageMode, "acp");
      assert.equal(result.queueEntry.metadata.routing.acpRoute.workflow, "complex");
      assert.equal(result.queueEntry.metadata.routing.acpTriager.agent, "claude");
    } finally {
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });
});

describe("GitHub actor trust", () => {
  it("preserves issue author association for routing trust decisions", async () => {
    const event = normalizeGithubWebhookEvent({
      event: "issues",
      delivery: "delivery-trust-1",
      projectId: "frontend",
      payload: {
        action: "labeled",
        repository: { full_name: "my-org/frontend" },
        label: { name: "cpb" },
        issue: {
          number: 446,
          title: "Docs: update owner guide",
          body: "README stale.",
          html_url: "https://github.com/my-org/frontend/issues/446",
          author_association: "OWNER",
          labels: [{ name: "cpb" }, { name: "docs" }],
        },
        sender: { login: "maintainer" },
      },
    });

    assert.equal(event.authorAssociation, "OWNER");

    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-github-trust-"));
    try {
      const result = await createGithubIssueQueueJob(cpbRoot, event, matchGithubTrigger(event));
      assert.equal(result.queueEntry.metadata.workflow, "direct");
      assert.equal(result.queueEntry.metadata.planMode, "none");
      assert.equal(result.queueEntry.metadata.routing.actorTrust.trusted, true);
    } finally {
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });
});

describe("SDD automatic GitHub entry", () => {
  it("routes sdd label issues into SDD bootstrap metadata and files", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-sdd-auto-"));
    try {
      assert.ok(DEFAULT_GITHUB_TRIGGERS.some((trigger) => trigger.label === "sdd"));
      const event = normalizeGithubWebhookEvent({
        event: "issues",
        delivery: "delivery-sdd-1",
        projectId: "frontend",
        payload: {
          action: "labeled",
          repository: { full_name: "my-org/frontend" },
          label: { name: "sdd" },
          issue: {
            number: 444,
            title: "Checkout redesign",
            body: "Spec seed from issue body.\n\nAcceptance: checkout must keep saved cards.",
            html_url: "https://github.com/my-org/frontend/issues/444",
            labels: [{ name: "sdd" }],
          },
          sender: { login: "product-owner" },
        },
      });
      const match = matchGithubTrigger(event);
      assert.equal(match.matched, true);

      const result = await createGithubIssueQueueJob(cpbRoot, event, match);

      assert.equal(result.queueEntry.metadata.workflow, "sdd-standard");
      assert.equal(result.queueEntry.metadata.planMode, "parent");
      assert.equal(result.queueEntry.metadata.sddBootstrap.source, "github_issue");
      assert.equal(result.queueEntry.metadata.sddBootstrap.issueNumber, 444);
      assert.equal(result.queueEntry.metadata.sddTasks.length, 1);
      assert.equal(result.queueEntry.metadata.sddTasks[0].workflow, "sdd-standard");
      assert.equal(result.sddTaskQueueEntries.length, 1);
      assert.equal(result.sddTaskQueueEntries[0].type, "sdd_task");
      assert.equal(result.sddTaskQueueEntries[0].metadata.parentQueueEntryId, result.queueEntry.id);

      const verification = await verifySddProject(cpbRoot, "frontend");
      assert.equal(verification.status, "pass");
      const spec = await readFile(path.join(cpbRoot, "wiki", "projects", "frontend", "sdd", "spec.md"), "utf8");
      assert.match(spec, /Checkout redesign/);
      assert.match(spec, /Spec seed from issue body/);
    } finally {
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });
});

describe("parent plan cache", () => {
  it("creates stable parent plan groups and reuses existing cached plans", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-plan-cache-"));
    try {
      const first = await resolveParentPlanCache(cpbRoot, {
        project: "frontend",
        task: "Add checkout SDD tasks",
        sourceContext: { issueNumber: 444, repo: "my-org/frontend" },
      });
      assert.equal(first.cacheHit, false);
      assert.match(first.planGroupId, /^plan-group-/);
      assert.match(first.planCacheKey, /^[a-f0-9]{16}$/);

      const planFile = path.join(cpbRoot, "wiki", "projects", "frontend", "inbox", "plan-777.md");
      await mkdir(path.dirname(planFile), { recursive: true });
      await writeFile(planFile, "# Plan\n\nReusable parent plan.\n", "utf8");
      await writeParentPlanCache(cpbRoot, {
        ...first,
        project: "frontend",
        planId: "777",
        planArtifact: "plan-777",
      });

      const second = await resolveParentPlanCache(cpbRoot, {
        project: "frontend",
        task: "Add checkout SDD tasks",
        sourceContext: { issueNumber: 444, repo: "my-org/frontend" },
      });
      assert.equal(second.cacheHit, true);
      assert.equal(second.reusedPlanId, "777");
      assert.deepEqual(second.mergedPlanIds, ["777"]);
    } finally {
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });
});

describe("planner and executor context guidance", () => {
  it("differentiates light and parent plan modes in planner prompts", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-planmode-prompt-"));
    const executorRoot = path.resolve(import.meta.dirname, "..");
    const wikiDir = path.join(cpbRoot, "wiki", "projects", "frontend");
    const saved = {
      CPB_PLAN_MODE: process.env.CPB_PLAN_MODE,
      CPB_PARENT_PLAN_CACHE_JSON: process.env.CPB_PARENT_PLAN_CACHE_JSON,
    };
    try {
      await mkdir(wikiDir, { recursive: true });
      await writeFile(path.join(wikiDir, "context.md"), "# Context\n", "utf8");
      await writeFile(path.join(wikiDir, "decisions.md"), "# Decisions\n", "utf8");

      process.env.CPB_PLAN_MODE = "light";
      let prompt = await buildPlannerPrompt(executorRoot, cpbRoot, "frontend", "update copy", path.join(wikiDir, "inbox", "plan-1.md"));
      assert.match(prompt, /Light Plan Mode/);
      assert.match(prompt, /concise/i);

      process.env.CPB_PLAN_MODE = "parent";
      process.env.CPB_PARENT_PLAN_CACHE_JSON = JSON.stringify({ planGroupId: "plan-group-abc", planCacheKey: "abc123" });
      prompt = await buildPlannerPrompt(executorRoot, cpbRoot, "frontend", "split SDD tasks", path.join(wikiDir, "inbox", "plan-2.md"));
      assert.match(prompt, /Parent Plan Mode/);
      assert.match(prompt, /plan-group-abc/);
      assert.match(prompt, /abc123/);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  it("surfaces the latest context pack locator in executor job prompts", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-executor-context-pack-"));
    const executorRoot = path.resolve(import.meta.dirname, "..");
    const runtimeRoot = path.join(cpbRoot, "runtime");
    const wikiDir = path.join(cpbRoot, "wiki", "projects", "frontend");
    const contextPack = path.join(runtimeRoot, "context-packs", "context-pack-2026.md");
    const saved = {
      CPB_PROJECT_RUNTIME_ROOT: process.env.CPB_PROJECT_RUNTIME_ROOT,
      CPB_PLAN_MODE: process.env.CPB_PLAN_MODE,
    };
    try {
      await mkdir(wikiDir, { recursive: true });
      await mkdir(path.dirname(contextPack), { recursive: true });
      await writeFile(path.join(wikiDir, "context.md"), "# Context\n", "utf8");
      await writeFile(path.join(wikiDir, "decisions.md"), "# Decisions\n", "utf8");
      await writeFile(path.join(wikiDir, "project.json"), "{}", "utf8");
      await writeFile(contextPack, "# Context Pack\n", "utf8");
      process.env.CPB_PROJECT_RUNTIME_ROOT = runtimeRoot;
      process.env.CPB_PLAN_MODE = "light";

      const prompt = await buildExecutorJobPrompt(
        executorRoot,
        cpbRoot,
        "frontend",
        "job-context-pack",
        path.join(wikiDir, "outputs", "deliverable-1.md"),
      );

      assert.match(prompt, /Latest context pack/);
      assert.match(prompt, /context-pack-2026\.md/);
      assert.match(prompt, /Read the latest context pack/);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });
});
