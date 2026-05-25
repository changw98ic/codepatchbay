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

describe("issue triage safety lattice", () => {
  it("keeps deterministic rule output separate from effective routing", () => {
    const decision = triageIssue({
      labels: ["docs"],
      title: "Docs: update README examples",
      actor: "drive-by",
    });

    assert.equal(decision.ruleRoute.workflow, "direct");
    assert.equal(decision.ruleRoute.planMode, "none");
    assert.equal(decision.requestedRoute.workflow, "direct");
    assert.equal(decision.effectiveRoute.workflow, "direct");
    assert.equal(decision.effectiveRoute.planMode, "none");
    assert.equal(decision.actorTrust.trusted, false);
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
