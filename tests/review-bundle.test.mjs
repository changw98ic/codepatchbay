import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { buildReviewBundle, writeReviewBundle, reviewBundleDir } from "../server/services/review-bundle.js";
import { buildArtifactIndex } from "../server/services/artifact-index.js";
import { appendEvent, readEventsReadOnly } from "../server/services/event-store.js";
import { finalizeSuccessfulQueueEntry } from "../server/services/auto-finalizer.js";

function mockExecFile(cmd, args, opts) {
  const cwd = opts?.cwd || "";
  if (cmd === "git") {
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
      return Promise.resolve({ stdout: "true\n", stderr: "" });
    }
    if (args[0] === "rev-parse" && args[1] === "HEAD") {
      return Promise.resolve({ stdout: "abc123def456\n", stderr: "" });
    }
    if (args[0] === "branch" && args[1] === "--show-current") {
      return Promise.resolve({ stdout: "main\n", stderr: "" });
    }
    if (args[0] === "status" && args[1] === "--porcelain") {
      return Promise.resolve({ stdout: "", stderr: "" });
    }
    if (args[0] === "diff" && args.includes("--name-only")) {
      return Promise.resolve({ stdout: "src/app.js\nsrc/util.js\n", stderr: "" });
    }
    if (args[0] === "diff" && args.includes("--stat")) {
      return Promise.resolve({ stdout: "2 files changed\n", stderr: "" });
    }
    if (args[0] === "diff" && !args.includes("--name-only") && !args.includes("--stat")) {
      return Promise.resolve({ stdout: "diff content here\n", stderr: "" });
    }
    if (args[0] === "log") {
      return Promise.resolve({ stdout: "abc123 fix bug\ndef456 add feature\n", stderr: "" });
    }
    if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    }
    if (args[0] === "stash") {
      return Promise.resolve({ stdout: "", stderr: "" });
    }
  }
  return Promise.resolve({ stdout: "", stderr: "" });
}

describe("Review Bundle Service", () => {
  let tmpDir;
  let cpbRoot;
  let hubRoot;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-review-bundle-test-"));
    cpbRoot = path.join(tmpDir, "cpb");
    hubRoot = path.join(tmpDir, "hub");
    await mkdir(cpbRoot, { recursive: true });
    await mkdir(hubRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("builds a review bundle from event log", async () => {
    const project = "test-project";
    const jobId = "job-test-001";
    const inboxDir = path.join(cpbRoot, "wiki", "projects", project, "inbox");
    const outputsDir = path.join(cpbRoot, "wiki", "projects", project, "outputs");
    await mkdir(inboxDir, { recursive: true });
    await mkdir(outputsDir, { recursive: true });
    const planPromptPath = path.join(outputsDir, "prompt-plan-audit.md");
    const executePromptPath = path.join(outputsDir, "prompt-execute-audit.md");
    const verifyPromptPath = path.join(outputsDir, "prompt-verify-audit.md");
    await writeFile(path.join(inboxDir, "plan-dark-mode.md"), "# Plan\n\nUse a persisted theme flag.\n");
    await writeFile(path.join(outputsDir, "deliverable-dark-mode.md"), "# Deliverable\n\nChanged theme toggle code.\n");
    await writeFile(
      path.join(outputsDir, "verdict-dark-mode.md"),
      JSON.stringify({ ok: true, status: "pass", confidence: 0.9, reason: "dark mode evidence is present" }),
    );
    await writeFile(planPromptPath, "PLAN PROMPT: persisted theme flag\n");
    await writeFile(executePromptPath, "EXECUTE PROMPT: changed theme toggle\n");
    await writeFile(verifyPromptPath, "VERIFY PROMPT: inspect dark mode evidence\n");

    await appendEvent(cpbRoot, project, jobId, {
      type: "job_created",
      jobId,
      project,
      task: "Add dark mode toggle",
      ts: new Date().toISOString(),
    });

    await appendEvent(cpbRoot, project, jobId, {
      type: "phase_completed",
      jobId,
      project,
      phase: "plan",
      artifact: "plan-dark-mode",
      promptArtifact: "prompt-plan-audit",
      agent: "codex",
      ts: new Date().toISOString(),
    });

    await appendEvent(cpbRoot, project, jobId, {
      type: "phase_completed",
      jobId,
      project,
      phase: "execute",
      artifact: "deliverable-dark-mode",
      promptArtifact: "prompt-execute-audit",
      agent: "claude",
      ts: new Date().toISOString(),
    });

    await appendEvent(cpbRoot, project, jobId, {
      type: "phase_completed",
      jobId,
      project,
      phase: "verify",
      artifact: "verdict-dark-mode",
      promptArtifact: "prompt-verify-audit",
      agent: "codex",
      ts: new Date().toISOString(),
    });

    await appendEvent(cpbRoot, project, jobId, {
      type: "job_completed",
      jobId,
      project,
      ts: new Date().toISOString(),
    });

    const artifactIndex = await buildArtifactIndex(cpbRoot, project, jobId);
    assert.deepEqual(artifactIndex.brokenReferences, []);
    assert.equal(artifactIndex.entries.find((entry) => entry.kind === "plan")?.path, path.join(inboxDir, "plan-dark-mode.md"));
    assert.equal(artifactIndex.entries.find((entry) => entry.kind === "deliverable")?.path, path.join(outputsDir, "deliverable-dark-mode.md"));
    assert.equal(artifactIndex.entries.find((entry) => entry.kind === "verdict")?.path, path.join(outputsDir, "verdict-dark-mode.md"));
    assert.equal(artifactIndex.entries.filter((entry) => entry.kind === "prompt").length, 3);

    const bundle = await buildReviewBundle(cpbRoot, project, jobId);

    assert.equal(bundle.schemaVersion, 1);
    assert.equal(bundle.bundleType, "local_review");
    assert.equal(bundle.project, project);
    assert.equal(bundle.jobId, jobId);
    assert.equal(bundle.request.task, "Add dark mode toggle");
    assert.equal(bundle.status.jobStatus, "completed");
    assert.deepEqual(bundle.status.completedPhases, ["plan", "execute", "verify"]);
    assert.ok(bundle.timeline.length >= 5);
    assert.ok(bundle.generatedAt);
    assert.ok(Array.isArray(bundle.links.artifacts));
    assert.match(bundle.evidence.plan.content, /persisted theme flag/);
    assert.match(bundle.evidence.deliverable.content, /Changed theme toggle code/);
    assert.equal(bundle.evidence.verdict.status, "pass");
    assert.ok(bundle.links.artifacts.every((artifact) => artifact.broken === false));
    assert.deepEqual(
      bundle.promptAudit.map((entry) => ({ phase: entry.phase, path: entry.path, broken: entry.broken })),
      [
        { phase: "plan", path: planPromptPath, broken: false },
        { phase: "execute", path: executePromptPath, broken: false },
        { phase: "verify", path: verifyPromptPath, broken: false },
      ],
    );
    assert.ok(bundle.promptAudit.every((entry) => typeof entry.sha256 === "string" && entry.sha256.length === 64));
    assert.ok(bundle.links.artifacts.some((artifact) => artifact.kind === "prompt" && artifact.phase === "plan"));
    assert.equal(JSON.stringify(bundle.evidence).includes("PLAN PROMPT"), false);
  });

  it("resolves extensionless artifact references to existing markdown files", async () => {
    const project = "artifact-index-project";
    const jobId = "job-artifact-index-001";
    const inboxDir = path.join(cpbRoot, "wiki", "projects", project, "inbox");
    await mkdir(inboxDir, { recursive: true });
    await writeFile(path.join(inboxDir, "plan-123.md"), "real plan\n");
    await appendEvent(cpbRoot, project, jobId, {
      type: "phase_completed",
      jobId,
      project,
      phase: "plan",
      artifact: "plan-123",
      ts: new Date().toISOString(),
    });

    const index = await buildArtifactIndex(cpbRoot, project, jobId);
    assert.equal(index.entries.length, 1);
    assert.equal(index.entries[0].broken, false);
    assert.equal(index.entries[0].path, path.join(inboxDir, "plan-123.md"));
  });

  it("writes review bundle to disk", async () => {
    const project = "write-test";
    const jobId = "job-write-001";
    const outDir = path.join(tmpDir, "output");

    const bundle = { schemaVersion: 1, project, jobId, generatedAt: new Date().toISOString() };
    const filePath = await writeReviewBundle(outDir, bundle);

    assert.ok(filePath.endsWith("-review-bundle.json"));
    const written = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(written.project, project);
    assert.equal(written.jobId, jobId);
  });

  it("reviewBundleDir returns correct path", () => {
    const dir = reviewBundleDir("/hub", "my-project", "job-123");
    assert.equal(dir, path.join("/hub", "review-bundles", "my-project"));
  });
});

describe("Auto-finalizer review bundle fallback", () => {
  let tmpDir;
  let cpbRoot;
  let hubRoot;
  let sourcePath;
  let worktreePath;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-finalizer-test-"));
    cpbRoot = path.join(tmpDir, "cpb");
    hubRoot = path.join(tmpDir, "hub");
    sourcePath = path.join(tmpDir, "source");
    worktreePath = path.join(tmpDir, "worktree");
    await mkdir(cpbRoot, { recursive: true });
    await mkdir(hubRoot, { recursive: true });
    await mkdir(sourcePath, { recursive: true });
    await mkdir(worktreePath, { recursive: true });

    // Init git repos
    for (const repo of [sourcePath, worktreePath]) {
      await mockExecFile("git", ["init"], { cwd: repo });
      await writeFile(path.join(repo, "README.md"), "test\n", "utf8");
    }
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("produces a review bundle when no issue link is present", async () => {
    const project = "no-github-project";
    const jobId = "job-no-github-001";

    // Create event log for the job
    await appendEvent(cpbRoot, project, jobId, {
      type: "job_created",
      jobId,
      project,
      task: "Implement local review bundle",
      ts: new Date().toISOString(),
    });
    await appendEvent(cpbRoot, project, jobId, {
      type: "phase_completed",
      jobId,
      project,
      phase: "plan",
      artifact: "plan-review.md",
      agent: "codex",
      ts: new Date().toISOString(),
    });
    await appendEvent(cpbRoot, project, jobId, {
      type: "job_completed",
      jobId,
      project,
      ts: new Date().toISOString(),
    });

    const entry = {
      id: "q-no-github-001",
      projectId: project,
      description: "Implement local review bundle",
      metadata: {
        source: "cli",
        workflow: "standard",
        planMode: "full",
        autoFinalize: true,
        // No issueNumber, issueUrl, or repo — this is the no-GitHub path
      },
    };

    const job = {
      status: "completed",
      worktree: worktreePath,
      jobId,
      project,
      sourceContext: {},
      task: "Implement local review bundle",
    };

    const result = await finalizeSuccessfulQueueEntry({
      cpbRoot,
      hubRoot,
      project,
      entry,
      job,
      sourcePath,
      mode: "pr",
      runCommand: mockExecFile,
    });

    // Should return a review bundle result, not a rejection
    assert.equal(result.ok, true);
    assert.equal(result.status, "review_bundle");
    assert.equal(result.mode, "review_bundle");
    assert.equal(result.jobId, jobId);
    assert.ok(result.bundlePath);
    assert.ok(Array.isArray(result.changedFiles));

    const events = await readEventsReadOnly(cpbRoot, project, jobId);
    assert.ok(events.some((event) => (
      event.type === "review_bundle_created"
      && event.bundlePath === result.bundlePath
      && event.jobId === jobId
    )));
  });

  it("still requires issue link for PR mode when issue metadata is present", async () => {
    const project = "with-github";
    const jobId = "job-with-github-001";

    await appendEvent(cpbRoot, project, jobId, {
      type: "job_created",
      jobId,
      project,
      task: "Fix login bug",
      ts: new Date().toISOString(),
    });
    await appendEvent(cpbRoot, project, jobId, {
      type: "job_completed",
      jobId,
      project,
      ts: new Date().toISOString(),
    });

    const entry = {
      id: "q-with-github-001",
      projectId: project,
      description: "Fix login bug",
      metadata: {
        source: "cli",
        issueNumber: 42,
        repo: "my-org/frontend",
        autoFinalize: true,
      },
    };

    const job = {
      status: "completed",
      worktree: worktreePath,
      jobId,
      project,
      sourceContext: {},
      task: "Fix login bug",
    };

    const result = await finalizeSuccessfulQueueEntry({
      cpbRoot,
      hubRoot,
      project,
      entry,
      job,
      sourcePath,
      mode: "pr",
      runCommand: mockExecFile,
    });

    // With an issue link, it should try PR path (will fail since no real git/PR setup)
    // but NOT produce a review bundle
    assert.notEqual(result.status, "review_bundle");
  });
});

describe("Managed worker finalizer writeback contract", () => {
  it("does not shadow finalizeResult before writing result.json", async () => {
    const source = await readFile(
      path.join(process.cwd(), "runtime", "worker", "managed-worker.js"),
      "utf8",
    );
    assert.doesNotMatch(source, /const\s+finalizeResult\s*=\s*await\s+finalizeSuccessfulQueueEntry/);
    assert.match(source, /await\s+finalizeAndWriteSuccessfulResult\(/);
    assert.match(source, /finalizeResult:\s*finalizeResult\s*\|\|\s*null/);
  });
});
