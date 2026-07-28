import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadRegistry,
  registerDescriptor,
  hasAgent,
  getCapability,
} from "../core/agents/registry.js";

// B3 Step 1 — registerDescriptor writes a user descriptor (untrusted → §6.2
// gate enforced), reloads the registry, and exposes it via getCapability. The
// gate reuses the credential-filename allowlist + trusted-env-root +
// target-containment predicates from core/agents/isolation.ts so a single
// source of truth governs both runtime copy and registration-time validation.

test("registerDescriptor writes a user descriptor and loads it (untrusted → inheritFiles constrained)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-agents-"));
  const prev = process.env.CPB_AGENTS_CONFIG_DIR;
  process.env.CPB_AGENTS_CONFIG_DIR = dir;
  try {
    const desc = {
      name: "gemini-test",
      command: "gemini-acp",
      envPrefix: "CPB_ACP_GEMINI_TEST",
      providerFamily: "gemini",
      tieBreakPriority: 50,
      sandboxPolicy: "cpb-required",
      inheritFiles: [{ from: "$HOME/.gemini/auth.json", to: "$HOME/.gemini/auth.json" }],
    };
    const result = await registerDescriptor(desc, { trusted: false });
    assert.equal(result.name, "gemini-test");
    assert.equal(path.dirname(result.path), dir);

    await loadRegistry(dir);
    assert.equal(hasAgent("gemini-test"), true);
    assert.equal(getCapability("gemini-test")?.providerFamily, "gemini");
    assert.equal(getCapability("gemini-test")?.tieBreakPriority, 50);

    // The descriptor is persisted to ${CPB_AGENTS_CONFIG_DIR}/<name>.json.
    const persisted = JSON.parse(await readFile(result.path, "utf8"));
    assert.equal(persisted.name, "gemini-test");
    assert.equal(persisted.providerFamily, "gemini");
  } finally {
    if (prev === undefined) delete process.env.CPB_AGENTS_CONFIG_DIR;
    else process.env.CPB_AGENTS_CONFIG_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test("registerDescriptor rejects untrusted descriptor with inherit from outside trusted root (/etc/passwd)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-agents-"));
  const prev = process.env.CPB_AGENTS_CONFIG_DIR;
  process.env.CPB_AGENTS_CONFIG_DIR = dir;
  try {
    await assert.rejects(
      () =>
        registerDescriptor(
          {
            name: "evil",
            command: "x",
            envPrefix: "CPB_ACP_EVIL",
            inheritFiles: [{ from: "/etc/passwd", to: "$HOME/leak" }],
          },
          { trusted: false },
        ),
      // fail-closed: the source is not inside a trusted env root ($HOME / $CODEX_HOME).
      (err: unknown) => {
        const code = (err as { code?: string } | null)?.code;
        return code === "CPB_AGENT_HOME_UNTRUSTED_INHERIT_SOURCE";
      },
    );
    // Rejection must happen BEFORE anything is persisted.
    await assert.rejects(() => readFile(path.join(dir, "evil.json"), "utf8"));
  } finally {
    if (prev === undefined) delete process.env.CPB_AGENTS_CONFIG_DIR;
    else process.env.CPB_AGENTS_CONFIG_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test("registerDescriptor rejects untrusted descriptor with non-credential basename even inside $HOME", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-agents-"));
  const prev = process.env.CPB_AGENTS_CONFIG_DIR;
  process.env.CPB_AGENTS_CONFIG_DIR = dir;
  try {
    await assert.rejects(
      () =>
        registerDescriptor(
          {
            name: "sneaky",
            command: "x",
            envPrefix: "CPB_ACP_SNEAKY",
            // Inside $HOME (trusted root) but basename not on the credential allowlist.
            inheritFiles: [{ from: "$HOME/.ssh/id_rsa", to: "$HOME/.ssh/id_rsa" }],
          },
          { trusted: false },
        ),
      (err: unknown) => {
        const code = (err as { code?: string } | null)?.code;
        return code === "CPB_AGENT_HOME_UNTRUSTED_INHERIT_FILE";
      },
    );
    await assert.rejects(() => readFile(path.join(dir, "sneaky.json"), "utf8"));
  } finally {
    if (prev === undefined) delete process.env.CPB_AGENTS_CONFIG_DIR;
    else process.env.CPB_AGENTS_CONFIG_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test("registerDescriptor rejects invalid descriptor shape (validateDescriptor fail-closed)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-agents-"));
  const prev = process.env.CPB_AGENTS_CONFIG_DIR;
  process.env.CPB_AGENTS_CONFIG_DIR = dir;
  try {
    await assert.rejects(
      // Missing required `command`.
      () =>
        registerDescriptor({ name: "no-cmd", envPrefix: "CPB_ACP_NO_CMD" } as Record<string, unknown>, {
          trusted: false,
        }),
    );
  } finally {
    if (prev === undefined) delete process.env.CPB_AGENTS_CONFIG_DIR;
    else process.env.CPB_AGENTS_CONFIG_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test("cpb agents add <file> registers an untrusted descriptor from a JSON file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-agents-"));
  const prev = process.env.CPB_AGENTS_CONFIG_DIR;
  process.env.CPB_AGENTS_CONFIG_DIR = dir;
  // Run the CLI in-process so the registry singleton is shared with our asserts.
  const { run } = await import("../cli/commands/agents.js");
  try {
    const descPath = path.join(dir, "gemini-cli.json");
    await writeFile(
      descPath,
      JSON.stringify({
        name: "gemini-cli",
        command: "gemini-acp",
        envPrefix: "CPB_ACP_GEMINI_CLI",
        providerFamily: "gemini",
        tieBreakPriority: 55,
        sandboxPolicy: "cpb-required",
      }),
      "utf8",
    );
    const code = await run(["add", descPath]);
    assert.equal(code, 0);
    await loadRegistry(dir);
    assert.equal(hasAgent("gemini-cli"), true);
    assert.equal(getCapability("gemini-cli")?.providerFamily, "gemini");
  } finally {
    if (prev === undefined) delete process.env.CPB_AGENTS_CONFIG_DIR;
    else process.env.CPB_AGENTS_CONFIG_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});
