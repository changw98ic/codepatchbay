import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";

import { composePromptContext } from "../server/services/knowledge-compose.js";

let tmpDir;
let hubRoot;

beforeEach(async () => {
  tmpDir = path.join(await fs.mkdtemp("/tmp/cpb-compose-test-"));
  hubRoot = path.join(tmpDir, "hub");
  await fs.mkdir(hubRoot, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function makeProject(sourceName) {
  const sourcePath = path.join(tmpDir, sourceName);
  await fs.mkdir(sourcePath, { recursive: true });
  return sourcePath;
}

// --- composition order ---

test("composePromptContext returns layers in planned order", async () => {
  const sourcePath = await makeProject("myrepo");

  // Write all layers
  await fs.mkdir(path.join(hubRoot, "profiles", "default"), { recursive: true });
  await fs.writeFile(path.join(hubRoot, "profiles", "default", "soul.md"), "be concise", "utf8");

  await fs.mkdir(path.join(hubRoot, "providers"), { recursive: true });
  await fs.writeFile(path.join(hubRoot, "providers", "policy.md"), "max 3 concurrent", "utf8");

  await fs.mkdir(path.join(sourcePath, ".cpb"), { recursive: true });
  await fs.writeFile(path.join(sourcePath, ".cpb", "context.md"), "react 19 app", "utf8");

  await fs.mkdir(path.join(sourcePath, ".cpb", "wiki"), { recursive: true });
  await fs.writeFile(path.join(sourcePath, ".cpb", "wiki", "overview.md"), "e-commerce platform", "utf8");

  await fs.writeFile(path.join(sourcePath, ".cpb", "memory.md"), "prefer fast tests", "utf8");

  const sessionId = "sess-001";
  await fs.mkdir(path.join(sourcePath, "cpb-task", "sessions", sessionId), { recursive: true });
  await fs.writeFile(path.join(sourcePath, "cpb-task", "sessions", sessionId, "memory.md"), "tried vite", "utf8");

  const task = "Add dark mode toggle";

  const result = await composePromptContext({
    hubRoot,
    sourcePath,
    sessionId,
    task,
    profile: "default",
  });

  assert.ok(Array.isArray(result.layers));
  assert.equal(result.layers.length, 7);

  const names = result.layers.map((l) => l.name);
  assert.deepEqual(names, [
    "global-soul-profile",
    "global-provider-runtime-policy",
    "project-context",
    "project-wiki-excerpts",
    "project-memory",
    "session-memory",
    "current-task",
  ]);
});

// --- content correctness ---

test("composePromptContext includes actual content from layers", async () => {
  const sourcePath = await makeProject("contentrepo");

  await fs.mkdir(path.join(hubRoot, "profiles", "codex"), { recursive: true });
  await fs.writeFile(path.join(hubRoot, "profiles", "codex", "soul.md"), "plan carefully", "utf8");

  const result = await composePromptContext({
    hubRoot,
    sourcePath,
    sessionId: "s-noexist",
    task: "Fix login bug",
    profile: "codex",
  });

  const soul = result.layers.find((l) => l.name === "global-soul-profile");
  assert.ok(soul);
  assert.equal(soul.content, "plan carefully");
  assert.equal(soul.source, "file");

  const taskLayer = result.layers.find((l) => l.name === "current-task");
  assert.ok(taskLayer);
  assert.equal(taskLayer.content, "Fix login bug");
  assert.equal(taskLayer.source, "inline");
});

// --- graceful missing layers ---

test("composePromptContext returns null content for missing files", async () => {
  const sourcePath = await makeProject("emptyrepo");

  const result = await composePromptContext({
    hubRoot,
    sourcePath,
    sessionId: "s-empty",
    task: "Do something",
  });

  const ctx = result.layers.find((l) => l.name === "project-context");
  assert.ok(ctx);
  assert.equal(ctx.content, null);
  assert.equal(ctx.source, "file");
});

// --- write policy integration ---

test("composePromptContext result exposes write policy per layer", async () => {
  const sourcePath = await makeProject("policyrepo");

  const result = await composePromptContext({
    hubRoot,
    sourcePath,
    sessionId: "s-policy",
    task: "Write a test",
  });

  for (const layer of result.layers) {
    assert.ok(layer.writePolicy, `${layer.name} should have writePolicy`);
  }

  const sessionLayer = result.layers.find((l) => l.name === "session-memory");
  assert.equal(sessionLayer.writePolicy, "automatic");

  const globalSoul = result.layers.find((l) => l.name === "global-soul-profile");
  assert.equal(globalSoul.writePolicy, "explicit-confirmation");
});

// --- assembled text ---

test("composePromptContext produces assembled text with section headers", async () => {
  const sourcePath = await makeProject("assemblerepo");

  const result = await composePromptContext({
    hubRoot,
    sourcePath,
    sessionId: "s-asm",
    task: "Refactor utils",
  });

  assert.ok(typeof result.assembled === "string");
  assert.ok(result.assembled.includes("## current-task"));
  assert.ok(result.assembled.includes("Refactor utils"));
});
