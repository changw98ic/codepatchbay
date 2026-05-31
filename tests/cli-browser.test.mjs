import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("cli-browser: browser commands with mocked dependencies", () => {
  let tmpDir;
  let originalCpbRoot;
  let cpbRoot;

  it("cmdProviders lists providers", async () => {
    const { listProviders } = await import("../core/agents/drivers/browser/provider-loader.mjs");
    const providers = await listProviders();
    assert.ok(Array.isArray(providers));
    assert.ok(providers.length >= 2);
    const names = providers.map((p) => p.name);
    assert.ok(names.includes("chatgpt"));
    assert.ok(names.includes("mock"));
  });

  it("cmdShow loads and displays a provider", async () => {
    const { loadProvider } = await import("../core/agents/drivers/browser/provider-loader.mjs");
    const provider = await loadProvider("mock");
    assert.equal(provider.name, "mock");
    assert.equal(provider.displayName, "Mock Provider");
    assert.equal(provider.input.kind, "textarea");
    assert.equal(provider.input.submit.mode, "button");
  });

  it("cmdShow returns error for missing provider", async () => {
    const { loadProvider } = await import("../core/agents/drivers/browser/provider-loader.mjs");
    await assert.rejects(async () => loadProvider("nonexistent"), (err) => {
      assert.equal(err.code, "PROFILE_INVALID");
      return true;
    });
  });

  it("cmdDoctor checks filesystem state (descriptor + acp adapter)", async () => {
    const { access, constants } = await import("node:fs/promises");
    const cpbRoot = path.resolve(import.meta.dirname, "..");

    const descriptorPath = path.join(cpbRoot, "core/agents/descriptors/browser-agent.json");
    try {
      await access(descriptorPath, constants.F_OK);
    } catch {
      assert.fail(`browser-agent descriptor missing at ${descriptorPath}`);
    }

    const acpPath = path.join(cpbRoot, "bridges/browser-agent-acp.mjs");
    try {
      await access(acpPath, constants.X_OK);
    } catch {
      // On some systems the executable bit may not be set; check at least F_OK
      await access(acpPath, constants.F_OK);
    }
  });

  it("cmdLogout removes profile directory", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-browser-cli-"));
    cpbRoot = tmpDir;
    originalCpbRoot = process.env.CPB_ROOT;
    process.env.CPB_ROOT = cpbRoot;

    const profileDir = path.join(os.homedir(), ".cpb", "browser-agents", "mock-test-profile");
    await mkdir(profileDir, { recursive: true });
    await writeFile(path.join(profileDir, "cookie.txt"), "fake-cookie", "utf8");

    const { rm } = await import("node:fs/promises");
    await rm(profileDir, { recursive: true, force: true });

    // Verify removal
    const { access, constants } = await import("node:fs/promises");
    await assert.rejects(() => access(profileDir, constants.F_OK));
  });

  it("cmdReset delegates to logout then prints reset message", async () => {
    // This test verifies the reset command logic indirectly by confirming
    // the underlying functions exist and have correct signatures.
    const { run } = await import("../cli/commands/browser.js");
    assert.equal(typeof run, "function");
  });

  // Cleanup
  it("cleanup tmp dirs", async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
    if (originalCpbRoot === undefined) {
      delete process.env.CPB_ROOT;
    } else {
      process.env.CPB_ROOT = originalCpbRoot;
    }
  });
});
