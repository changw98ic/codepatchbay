import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// We test autoDiscoverAgents directly, then test registry integration

describe("auto-discover", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-discover-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("autoDiscoverAgents returns array", async () => {
    const { autoDiscoverAgents } = await import("../core/agents/auto-discover.js");
    const result = await autoDiscoverAgents();
    assert.ok(Array.isArray(result));
    // Each entry has required fields
    for (const d of result) {
      assert.ok(typeof d.name === "string" && d.name, `name missing for ${JSON.stringify(d)}`);
      assert.ok(typeof d.command === "string" && d.command, `command missing for ${d.name}`);
      assert.equal(d.source, "auto-discovered");
      assert.equal(d.stability, "discovered");
    }
  });

  it("autoDiscoverAgents finds binaries in custom PATH", async () => {
    // Create a fake binary in tmpDir
    const binDir = path.join(tmpDir, "bin");
    await mkdir(binDir, { recursive: true });
    const fakeBin = path.join(binDir, "gemini");
    await writeFile(fakeBin, "#!/bin/sh\nexit 0\n");
    await chmod(fakeBin, 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = binDir;
    try {
      const { autoDiscoverAgents } = await import("../core/agents/auto-discover.js");
      const result = await autoDiscoverAgents();
      const gemini = result.find((d) => d.name === "gemini");
      assert.ok(gemini, "should find gemini in custom PATH");
      assert.equal(gemini.command, fakeBin);
      assert.equal(gemini.stability, "discovered");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("autoDiscoverAgents handles empty PATH gracefully", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const { autoDiscoverAgents } = await import("../core/agents/auto-discover.js");
      const result = await autoDiscoverAgents();
      assert.ok(Array.isArray(result));
      assert.equal(result.length, 0);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

describe("registry auto-discover integration", () => {
  it("loadRegistry merges discovered agents", async () => {
    // Create a fake binary
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-reg-"));
    const binDir = path.join(tmpDir, "bin");
    await mkdir(binDir, { recursive: true });
    const fakeBin = path.join(binDir, "goose");
    await writeFile(fakeBin, "#!/bin/sh\nexit 0\n");
    await chmod(fakeBin, 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = binDir;
    try {
      // Reset registry by reimporting
      const reg = await import("../core/agents/registry.js");
      await reg.loadRegistry();

      // goose should be discovered (not in builtin descriptors)
      const goose = reg.getDescriptor("goose");
      assert.ok(goose, "goose should be auto-discovered");
      assert.equal(goose.stability, "discovered");
      assert.equal(goose.source, "auto-discovered");

      // codex/claude/gemini should still be from builtin descriptors
      const codex = reg.getDescriptor("codex");
      assert.ok(codex, "codex should be in registry");
      assert.notEqual(codex.stability, "discovered", "codex should not be discovered");
    } finally {
      process.env.PATH = originalPath;
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("discovered agents don't override builtin descriptors", async () => {
    // Create a fake codex-acp binary
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-reg2-"));
    const binDir = path.join(tmpDir, "bin");
    await mkdir(binDir, { recursive: true });
    const fakeBin = path.join(binDir, "codex-acp");
    await writeFile(fakeBin, "#!/bin/sh\nexit 0\n");
    await chmod(fakeBin, 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = binDir;
    try {
      const reg = await import("../core/agents/registry.js");
      await reg.loadRegistry();

      const codex = reg.getDescriptor("codex");
      assert.ok(codex);
      // Should be from builtin, not discovered
      assert.ok(!codex.source || codex.source !== "auto-discovered",
        "builtin codex should not be overridden by discovered");
    } finally {
      process.env.PATH = originalPath;
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("listDiscoveredAgents returns only discovered entries", async () => {
    // This test shares module state with the previous test (goose was discovered).
    // Verify that listDiscoveredAgents works and doesn't include builtin agents.
    const reg = await import("../core/agents/registry.js");
    const discovered = reg.listDiscoveredAgents();
    assert.ok(Array.isArray(discovered));

    // All discovered entries should have stability "discovered"
    for (const d of discovered) {
      assert.equal(d.stability, "discovered", `${d.name} should have stability "discovered"`);
      assert.equal(d.source, "auto-discovered", `${d.name} should have source "auto-discovered"`);
    }

    // Builtin agents (codex, claude) should NOT be in discovered list
    const codex = discovered.find((d) => d.name === "codex");
    assert.equal(codex, undefined, "codex should not be in discovered list");
    const claude = discovered.find((d) => d.name === "claude");
    assert.equal(claude, undefined, "claude should not be in discovered list");
  });
});
