import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeGithubWebhookEvent } from "../server/services/github-events.js";
import { normalizeGithubLabels } from "../server/services/github-issues.js";

function issuePayload(overrides = {}) {
  const repo = overrides.repo || "owner/repo";
  const issueNumber = overrides.issueNumber || 42;
  return {
    action: overrides.action || "labeled",
    repository: { full_name: repo },
    sender: { login: overrides.actor || "octocat" },
    label: overrides.label ? { name: overrides.label } : null,
    issue: {
      number: issueNumber,
      title: overrides.title || "Bug: something broken",
      body: overrides.body || "Detailed description",
      html_url: `https://github.com/${repo}/issues/${issueNumber}`,
      labels: (overrides.labels || ["bug"]).map((name) => ({ name })),
      author_association: overrides.authorAssociation || "OWNER",
    },
  };
}

test("GitHub issues event normalization keeps issue and repo context", () => {
  const result = normalizeGithubWebhookEvent({
    event: "issues",
    delivery: "d-1",
    projectId: "proj",
    payload: issuePayload({ repo: "acme/app", issueNumber: 7, label: "cpb", labels: ["bug", "cpb"] }),
  });
  assert.equal(result.status, "ok");
  assert.equal(result.type, "github_issue");
  assert.equal(result.repo, "acme/app");
  assert.equal(result.issueNumber, 7);
  assert.equal(result.projectId, "proj");
  assert.equal(result.label, "cpb");
  assert.deepEqual(result.labels, ["bug", "cpb"]);
});

test("GitHub issue_comment normalization uses comment author association and command text", () => {
  const payload = {
    action: "created",
    repository: { full_name: "owner/repo" },
    sender: { login: "reviewer" },
    issue: {
      number: 9,
      title: "Fix it",
      body: "Issue body",
      html_url: "https://github.com/owner/repo/issues/9",
      labels: [],
      author_association: "OWNER",
    },
    comment: {
      body: "/cpb approve q-123",
      html_url: "https://github.com/owner/repo/issues/9#issuecomment-1",
      author_association: "MEMBER",
    },
  };
  const result = normalizeGithubWebhookEvent({ event: "issue_comment", delivery: "d-2", projectId: "proj", payload });
  assert.equal(result.status, "ok");
  assert.equal(result.type, "github_issue_comment");
  assert.equal(result.commandText, "/cpb approve q-123");
  assert.equal(result.authorAssociation, "MEMBER");
  assert.equal(result.raw.authorAssociation, "MEMBER");
});

test("GitHub installation and unsupported events normalize deterministically", () => {
  const installation = normalizeGithubWebhookEvent({
    event: "installation_repositories",
    delivery: "d-3",
    payload: {
      action: "added",
      sender: { login: "bot" },
      installation: { id: 111 },
      repositories_added: [{ full_name: "new/repo" }],
    },
  });
  assert.equal(installation.status, "ok");
  assert.equal(installation.type, "github_installation");
  assert.equal(installation.installationId, 111);
  assert.deepEqual(installation.repositories, ["new/repo"]);

  const ignored = normalizeGithubWebhookEvent({ event: "push", payload: {} });
  assert.equal(ignored.status, "ignored");
  assert.match(ignored.reason, /unsupported event: push/);
});

test("normalizeGithubLabels handles mixed string/object labels", () => {
  assert.deepEqual(normalizeGithubLabels(["bug", { name: "feature" }, null, { name: "" }]), ["bug", "feature"]);
  assert.deepEqual(normalizeGithubLabels(undefined), []);
});
