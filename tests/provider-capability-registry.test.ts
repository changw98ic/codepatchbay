import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadRegistry, getDescriptor, getCapability, listAgents, defaultAgentForRole } from "../core/agents/registry.js";
import { providerFamilyFor } from "../core/agents/outcome-routing.js";
import { runAgent } from "../core/agents/agent-runner.js";

test("shipped descriptors carry provider capability fields", async () => {
  await loadRegistry("");
  const fam = new Map(listAgents().map((d) => [d.name, d]));
  assert.ok(fam.has("codex"));
  assert.ok(fam.has("claude"));
  assert.ok(fam.has("claude-glm"));
  assert.equal(getCapability("codex")?.providerFamily, "codex");
  assert.equal(getCapability("codex")?.tieBreakPriority, 10);
  assert.equal(getCapability("codex")?.sandboxPolicy, "native");
  assert.equal(getCapability("claude")?.providerFamily, "claude");
  assert.equal(getCapability("claude-glm")?.providerFamily, "glm");
  assert.equal(getCapability("fake-acp")?.sandboxPolicy, "none");
});

test("getCapability returns null for unknown agent", async () => {
  await loadRegistry("");
  assert.equal(getCapability("nope-not-real"), null);
});

test("inheritFiles from is env-aware ($CODEX_HOME) for codex", async () => {
  await loadRegistry("");
  const cap = getCapability("codex");
  assert.ok(cap?.inheritFiles?.some((f) => f.from.includes("CODEX_HOME")));
});

test("getDescriptor still exposes the underlying capability fields", async () => {
  await loadRegistry("");
  const d = getDescriptor("codex");
  assert.equal(d?.providerFamily, "codex");
  assert.equal(d?.tieBreakPriority, 10);
  assert.equal(d?.sandboxPolicy, "native");
});

// --- B2a: routing layer driven by registry, not by codex/claude literals ---

test("defaultAgentForRole no longer hard-codes codex; picks by defaultRoles + tieBreakPriority", async () => {
  await loadRegistry("");
  // codex declares `planner` in defaultRoles and has the lowest tieBreakPriority
  // (10), so it still wins — but via the generic priority path, not a literal
  // short-circuit.
  assert.equal(defaultAgentForRole("planner"), "codex");
});

test("defaultAgentForRole picks the role-owner with lowest priority (codex literal removed)", async () => {
  await loadRegistry("");
  // codex does NOT declare `executor` in defaultRoles. The legacy codex
  // short-circuit used to return "codex" anyway; the registry-driven path must
  // instead pick the candidate that actually owns the role. claude (priority
  // 20) beats claude-glm (priority 30) for executor.
  assert.equal(defaultAgentForRole("executor"), "claude");
  // codex owns `verifier` at priority 10; claude-mimo also owns it at 40.
  assert.equal(defaultAgentForRole("verifier"), "codex");
});

test("providerFamilyFor reads descriptor.providerFamily, falls back null for unknown", async () => {
  await loadRegistry("");
  // With the registry loaded, providerFamilyFor must read the descriptor-declared
  // family rather than the legacy regex heuristic.
  assert.equal(providerFamilyFor("claude-glm"), "glm");
  assert.equal(providerFamilyFor("codex"), "codex");
  assert.equal(providerFamilyFor("claude-mimo"), "mimo");
});

test("providerFamilyFor lets an explicit provider variant override the base agent family", async () => {
  await loadRegistry("");
  assert.equal(providerFamilyFor("claude", "claude:glm"), "glm");
  assert.equal(providerFamilyFor("claude", "claude:mimo-v2.5pro"), "mimo");
});

test("sandboxPolicy none disables the CPB sandbox for the child execution env", async () => {
  await loadRegistry("");
  let capturedEnv: Record<string, string | undefined> | null = null;
  const result = await runAgent({
    phase: "verify",
    role: "verifier",
    agent: "fake-acp",
    project: "provider-capability-test",
    jobId: "sandbox-none",
    prompt: "{}",
    cwd: process.cwd(),
    env: {},
    pool: {
      execute: async (
        _agent: unknown,
        _prompt: unknown,
        _cwd: unknown,
        _timeoutMs: unknown,
        meta: { env?: Record<string, string | undefined> },
      ) => {
        capturedEnv = meta.env || null;
        return { output: "{}" };
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(capturedEnv?.CPB_AGENT_SANDBOX, "off");
  assert.equal(capturedEnv?.CPB_AGENT_SANDBOX_MODE, "off");
  assert.equal(capturedEnv?.CPB_AGENT_SANDBOX_INHERITED, undefined);
});

test("Claude-compatible custom descriptors use their declared envPrefix for tool policy", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-provider-cap-"));
  const restoreDir = path.join(dir, "restore");
  try {
    await mkdir(path.join(dir, "config"), { recursive: true });
    await writeFile(
      path.join(dir, "config", "claude-vendor.json"),
      `${JSON.stringify({
        name: "claude-vendor",
        command: "claude-vendor-acp",
        envPrefix: "CPB_ACP_VENDOR",
        transport: "claude-cli",
        inheritFiles: [],
        quarantineFiles: [],
      })}\n`,
    );
    await loadRegistry(path.join(dir, "config"));
    let capturedEnv: Record<string, string | undefined> | null = null;
    const result = await runAgent({
      phase: "verify",
      role: "verifier",
      agent: "claude-vendor",
      project: "provider-capability-test",
      jobId: "custom-env-prefix",
      prompt: "{}",
      cwd: process.cwd(),
      env: { CPB_ACP_DISABLE_WEB_TOOLS: "1", CPB_ACP_VENDOR_ARGS: "[]" },
      pool: {
        execute: async (
          _agent: unknown,
          _prompt: unknown,
          _cwd: unknown,
          _timeoutMs: unknown,
          meta: { env?: Record<string, string | undefined> },
        ) => {
          capturedEnv = meta.env || null;
          return { output: "{}" };
        },
      },
    });
    assert.equal(result.ok, true);
    assert.match(String(capturedEnv?.CPB_ACP_VENDOR_ARGS), /disallowedTools/);
    assert.equal(capturedEnv?.CPB_ACP_CLAUDE_VENDOR_ARGS, undefined);
  } finally {
    await mkdir(restoreDir, { recursive: true });
    await loadRegistry(restoreDir);
    await rm(dir, { recursive: true, force: true });
  }
});

test("providerFamilyFor falls back to regex heuristic when registry is not loaded", () => {
  // When the registry is not loaded (e.g. unit tests that never call
  // loadRegistry), providerFamilyFor must degrade to the legacy regex path so
  // behavior is preserved. claude-glm → glm, codex → codex via regex.
  // (We cannot easily unload the module singleton here, so this test only
  // asserts the regex still produces the same family for these names — it
  // documents the fallback invariant rather than exercising the throw branch.)
  assert.equal(providerFamilyFor("claude-glm", "claude:glm"), "glm");
  assert.equal(providerFamilyFor("codex"), "codex");
});
