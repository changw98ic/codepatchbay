import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  createArtifact,
  allocateArtifactId,
  ARTIFACT_SCHEMA_VERSION,
  ArtifactKind,
  KNOWN_KINDS,
} from "../core/artifacts/canonical-artifact.js";
import { validateContextPack } from "../core/artifacts/validators.js";
import { createContextPack } from "../core/artifacts/context-pack.js";

describe("canonical-artifact", () => {
  it("createArtifact returns all required fields", () => {
    const artifact = createArtifact({
      kind: "plan",
      id: "001",
      path: "/tmp/plan-001.md",
      content: "## Plan content",
      project: "my-project",
      jobId: "job-001",
      producerAgent: "codex",
      phase: "plan",
      metadata: { foo: "bar" },
    });

    assert.equal(artifact.schemaVersion, ARTIFACT_SCHEMA_VERSION);
    assert.equal(artifact.kind, "plan");
    assert.equal(artifact.id, "001");
    assert.equal(artifact.name, "plan-001");
    assert.equal(artifact.path, "/tmp/plan-001.md");
    assert.equal(artifact.bytes, Buffer.byteLength("## Plan content", "utf8"));
    assert.ok(artifact.sha256);
    assert.equal(artifact.project, "my-project");
    assert.equal(artifact.jobId, "job-001");
    assert.equal(artifact.phase, "plan");
    assert.equal(artifact.producerAgent, "codex");
    assert.deepEqual(artifact.metadata, { foo: "bar" });
    assert.ok(artifact.createdAt);
  });

  it("createArtifact handles empty content", () => {
    const artifact = createArtifact({
      kind: "verdict",
      id: "002",
      path: "/tmp/verdict-002.md",
      content: "",
      project: "test",
      jobId: "job-002",
    });
    assert.equal(artifact.bytes, 0);
    assert.equal(artifact.sha256, null);
  });

  it("allocateArtifactId generates unique sequential IDs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cpb-artifact-test-"));
    try {
      await mkdir(dir, { recursive: true });
      // Pre-existing artifact
      await writeFile(path.join(dir, "plan-001.md"), "content", "utf8");

      const id = await allocateArtifactId(dir, "plan");
      assert.equal(id, "002");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("allocateArtifactId starts at 001 for empty dir", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cpb-artifact-test-"));
    try {
      const id = await allocateArtifactId(dir, "plan");
      assert.equal(id, "001");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ArtifactKind contains all expected kinds", () => {
    assert.equal(ArtifactKind.PLAN, "plan");
    assert.equal(ArtifactKind.DELIVERABLE, "deliverable");
    assert.equal(ArtifactKind.VERDICT, "verdict");
    assert.equal(ArtifactKind.REVIEW, "review");
    assert.equal(ArtifactKind.REPAIR, "repair");
    assert.equal(ArtifactKind.DIFF, "diff");
    assert.equal(ArtifactKind.TESTS, "tests");
    assert.equal(ArtifactKind.RISK, "risk");
    assert.equal(ArtifactKind.PR, "pr");
    assert.equal(ArtifactKind.CONTEXT_PACK, "context-pack");
  });

  it("KNOWN_KINDS includes context-pack", () => {
    assert.ok(KNOWN_KINDS.has("context-pack"));
    assert.ok(KNOWN_KINDS.has("plan"));
    assert.ok(KNOWN_KINDS.has("deliverable"));
  });
});

describe("context-pack domain model", () => {
  it("createContextPack extends canonical artifact", () => {
    const pack = createContextPack({
      id: "2026-05-31",
      path: "/tmp/context-pack-2026-05-31.md",
      project: "flow",
      jobId: "job-123",
      task: "Add feature",
      target: "src/main.js",
      files: ["src/main.js", "src/utils.js"],
      edges: [{ from: "src/main.js", to: "src/utils.js", kind: "import" }],
      graphStats: { nodeCount: 100, edgeCount: 50 },
      producerAgent: "codex",
      content: "# Context Pack",
    });

    assert.equal(pack.schemaVersion, ARTIFACT_SCHEMA_VERSION);
    assert.equal(pack.kind, "context-pack");
    assert.equal(pack.id, "2026-05-31");
    assert.equal(pack.name, "context-pack-2026-05-31");
    assert.equal(pack.task, "Add feature");
    assert.equal(pack.target, "src/main.js");
    assert.deepEqual(pack.files, ["src/main.js", "src/utils.js"]);
    assert.deepEqual(pack.graphStats, { nodeCount: 100, edgeCount: 50 });
  });
});

describe("validateContextPack", () => {
  it("rejects non-object", () => {
    const result = validateContextPack(null);
    assert.equal(result.ok, false);
    assert.match(result.reason, /not an object/);
  });

  it("rejects missing files array", () => {
    const result = validateContextPack({ graphStats: { nodeCount: 1 } });
    assert.equal(result.ok, false);
    assert.match(result.reason, /files array/);
  });

  it("rejects missing graphStats", () => {
    const result = validateContextPack({ files: [] });
    assert.equal(result.ok, false);
    assert.match(result.reason, /graphStats/);
  });

  it("accepts valid context pack", () => {
    const result = validateContextPack({
      files: ["a.js"],
      graphStats: { nodeCount: 1, edgeCount: 0 },
    });
    assert.equal(result.ok, true);
  });
});
