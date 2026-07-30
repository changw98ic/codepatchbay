import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  getProviderConfig,
  loadRegistry,
  providerEnvironmentKeysForAgent,
} from "../core/agents/registry.js";
import { providerFamilyFor } from "../core/agents/outcome-routing.js";
import { buildChildEnv } from "../core/policy/child-env.js";
import { resolveProviderKey } from "../core/engine/provider-handoff.js";
import { envForAgent, providerKeyForAgent } from "../server/services/acp/acp-pool.js";
import { getProviderAdapter } from "../server/services/provider-adapters.js";

test("a user descriptor fully defines provider mapping without runtime provider code", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-provider-config-"));
  const configDir = path.join(root, "agents");
  const restoreDir = path.join(root, "restore");
  const agent = "vendor-cli";
  try {
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, `${agent}.json`),
      `${JSON.stringify({
        name: agent,
        command: "vendor-acp",
        envPrefix: "CPB_ACP_VENDOR_CLI",
        transport: "claude-cli",
        provider: {
          keyTemplate: "vendor:\${variant}",
          variant: "small",
          family: "vendor",
          credentialEnv: ["VENDOR_BASE_URL", "VENDOR_TOKEN", "VENDOR_MODEL", "CPB_VENDOR_CLI_COMMAND"],
          environment: {
            ANTHROPIC_BASE_URL: ["VENDOR_BASE_URL"],
            ANTHROPIC_API_KEY: ["VENDOR_TOKEN"],
            ANTHROPIC_AUTH_TOKEN: ["VENDOR_TOKEN"],
            ANTHROPIC_MODEL: ["VENDOR_MODEL"],
          },
          derived: {
            CLAUDE_CODE_SUBAGENT_MODEL: "ANTHROPIC_MODEL",
          },
          required: ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL"],
          normalizers: {
            ANTHROPIC_MODEL: "strip-trailing-bracket-suffix",
            CLAUDE_CODE_SUBAGENT_MODEL: "strip-trailing-bracket-suffix",
          },
          values: {
            CPB_ACTIVE_VENDOR_VARIANT: "\${variant}",
          },
          cli: {
            command: "vendor-cli",
            commandEnv: "CPB_VENDOR_CLI_COMMAND",
            modelEnv: "ANTHROPIC_MODEL",
            modelArg: "--model",
          },
          quota: {
            region: "vendor-region",
            timezone: "UTC",
            policy: { type: "per-minute" },
            rules: [{ pattern: "vendor limit", status: "rate_limited", confidence: 0.7 }],
          },
        },
        inheritFiles: [],
        quarantineFiles: [],
      }, null, 2)}\n`,
      "utf8",
    );

    await loadRegistry(configDir);
    const provider = getProviderConfig(agent);
    assert.equal(provider?.family, "vendor");
    assert.equal(providerKeyForAgent(agent), "vendor:small");
    assert.equal(providerFamilyFor(agent, "vendor:small"), "vendor");
    assert.equal(resolveProviderKey(null, { agent, variant: "small" }, null), "vendor:small");
    const adapter = getProviderAdapter("vendor:small") as Record<string, unknown>;
    assert.equal(adapter.timezone, "UTC");
    assert.equal((adapter.parseLimitError as Function)({ error: { message: "vendor limit" }, stderr: "" }).status, "rate_limited");

    const translated = envForAgent(agent, {
      VENDOR_BASE_URL: "https://vendor.example.invalid/api",
      VENDOR_TOKEN: "test-token",
      VENDOR_MODEL: "vendor-small[1m]",
      CPB_VENDOR_CLI_COMMAND: "/opt/vendor-cli",
    });
    const child = buildChildEnv(translated, {}, { agent });

    assert.equal(child.ANTHROPIC_BASE_URL, "https://vendor.example.invalid/api");
    assert.equal(child.ANTHROPIC_API_KEY, "test-token");
    assert.equal(child.ANTHROPIC_AUTH_TOKEN, "test-token");
    assert.equal(child.ANTHROPIC_MODEL, "vendor-small");
    assert.equal(child.CLAUDE_CODE_SUBAGENT_MODEL, "vendor-small");
    assert.equal(child.CPB_ACTIVE_VENDOR_VARIANT, "small");
    assert.equal(child.CPB_VENDOR_CLI_COMMAND, "/opt/vendor-cli");
    assert.deepEqual(
      [...providerEnvironmentKeysForAgent(agent)].sort(),
      [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL",
        "CPB_ACTIVE_VENDOR_VARIANT",
        "CPB_VENDOR_CLI_COMMAND",
        "VENDOR_BASE_URL",
        "VENDOR_MODEL",
        "VENDOR_TOKEN",
      ].sort(),
    );
  } finally {
    await loadRegistry(restoreDir);
    await rm(root, { recursive: true, force: true });
  }
});
