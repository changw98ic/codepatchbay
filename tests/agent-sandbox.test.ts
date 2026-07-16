import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildAgentSandboxLaunch, resolveAgentSandboxPolicy } from "../core/policy/agent-sandbox.js";
import { resolveLinkedGitMetadataReadRoots } from "../core/policy/filesystem-boundary.js";

test("linked worktree Git metadata is readable only after bidirectional validation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-linked-git-boundary-"));
  const commonDir = path.join(root, "source", ".git");
  const gitDir = path.join(commonDir, "worktrees", "job-1");
  const worktree = path.join(root, "runtime", "worktree");
  const controlPath = path.join(worktree, ".git");
  await mkdir(gitDir, { recursive: true });
  await mkdir(worktree, { recursive: true });
  await writeFile(controlPath, `gitdir: ${gitDir}\n`, "utf8");
  await writeFile(path.join(gitDir, "gitdir"), `${controlPath}\n`, "utf8");
  await writeFile(path.join(gitDir, "commondir"), "../..\n", "utf8");

  assert.deepEqual(
    await resolveLinkedGitMetadataReadRoots(worktree),
    [commonDir, gitDir].sort(),
  );

  await writeFile(path.join(gitDir, "gitdir"), `${path.join(root, "different", ".git")}\n`, "utf8");
  assert.deepEqual(await resolveLinkedGitMetadataReadRoots(worktree), []);
});

test("ordinary checkout exposes only its in-checkout Git directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-ordinary-git-boundary-"));
  const gitDir = path.join(root, ".git");
  await mkdir(gitDir, { recursive: true });
  assert.deepEqual(await resolveLinkedGitMetadataReadRoots(root), [gitDir]);
});

test("agent sandbox defaults to fail-closed required while preserving explicit off", () => {
  const unavailable = () => false;
  const defaultPolicy = resolveAgentSandboxPolicy({}, {
    cwd: process.cwd(),
    platform: "linux",
    probe: unavailable,
  });
  const disabledPolicy = resolveAgentSandboxPolicy({ CPB_AGENT_SANDBOX: "off" }, {
    cwd: process.cwd(),
    platform: "linux",
    probe: unavailable,
  });

  assert.equal(defaultPolicy.mode, "required");
  assert.equal(defaultPolicy.enabled, false);
  assert.equal(defaultPolicy.network, "allow");
  assert.equal(disabledPolicy.mode, "off");
});

test("strict sandbox remains offline unless network is explicitly allowed", () => {
  const strict = resolveAgentSandboxPolicy({ CPB_AGENT_SANDBOX: "strict" }, {
    cwd: process.cwd(),
    platform: "darwin",
    probe: (command) => command === "sandbox-exec",
  });
  const explicit = resolveAgentSandboxPolicy({
    CPB_AGENT_SANDBOX: "strict",
    CPB_AGENT_SANDBOX_NETWORK: "allow",
  }, {
    cwd: process.cwd(),
    platform: "darwin",
    probe: (command) => command === "sandbox-exec",
  });

  assert.equal(strict.network, "deny");
  assert.equal(explicit.network, "allow");
});

test("agent sandbox rejects invalid modes and unavailable required providers", () => {
  assert.throws(
    () => resolveAgentSandboxPolicy({ CPB_AGENT_SANDBOX: "typo" }, { platform: "linux", probe: () => false }),
    /CPB_AGENT_SANDBOX_INVALID_MODE/,
  );
  assert.throws(
    () => buildAgentSandboxLaunch("node", ["-e", "0"], { platform: "linux", probe: () => false, env: {} }),
    /CPB_AGENT_SANDBOX_REQUIRED/,
  );
});

test("read-only ACP write allow narrows sandbox write roots away from the worktree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-agent-sandbox-readonly-"));
  const worktree = path.join(root, "worktree");
  const dataRoot = path.join(root, "runtime");
  const phaseOutput = path.join(dataRoot, "phase-io", "verify");
  const agentHome = path.join(dataRoot, "agent-homes", "claude-mimo", "job-1");
  await mkdir(worktree, { recursive: true });
  await mkdir(phaseOutput, { recursive: true });
  await mkdir(agentHome, { recursive: true });

  const policy = resolveAgentSandboxPolicy({
    CPB_AGENT_SANDBOX: "best-effort",
    CPB_ACP_WRITE_ALLOW: `${phaseOutput}/*`,
    HOME: agentHome,
    TMPDIR: path.join(root, "tmp"),
  }, {
    cwd: worktree,
    platform: "darwin",
    probe: (command) => command === "sandbox-exec",
  });

  const realWorktree = realpathSync(worktree);
  const realPhaseOutput = realpathSync(phaseOutput);
  const realAgentHome = realpathSync(agentHome);
  const realAgentHomesRoot = realpathSync(path.join(dataRoot, "agent-homes"));

  assert.equal(policy.enabled, true);
  assert.equal(policy.provider, "sandbox-exec");
  assert.ok(policy.readRoots.includes(realWorktree), "worktree remains readable");
  assert.ok(!policy.writeRoots.includes(realWorktree), "worktree must not be writable");
  assert.ok(policy.writeRoots.includes(realPhaseOutput), "phase output remains writable");
  assert.ok(policy.writeRoots.includes(realAgentHomesRoot), "agent-homes root remains writable");
  assert.ok(policy.writeRoots.includes(realAgentHome), "isolated agent home remains writable");
});

test("read-only ACP sandbox allows creating missing isolated agent home descendants", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-agent-sandbox-home-root-"));
  const worktree = path.join(root, "worktree");
  const dataRoot = path.join(root, "runtime");
  const agentHomesRoot = path.join(dataRoot, "agent-homes");
  const phaseOutput = path.join(dataRoot, "phase-io", "verify");
  const agentHome = path.join(agentHomesRoot, "claude-mimo", "job-1");
  await mkdir(worktree, { recursive: true });
  await mkdir(agentHomesRoot, { recursive: true });
  await mkdir(phaseOutput, { recursive: true });

  const policy = resolveAgentSandboxPolicy({
    CPB_AGENT_SANDBOX: "best-effort",
    CPB_ACP_WRITE_ALLOW: `${phaseOutput}/*`,
    HOME: agentHome,
    XDG_CONFIG_HOME: path.join(agentHome, ".config"),
    TMPDIR: path.join(root, "tmp"),
  }, {
    cwd: worktree,
    platform: "darwin",
    probe: (command) => command === "sandbox-exec",
  });

  assert.ok(policy.writeRoots.includes(realpathSync(agentHomesRoot)), "agent-homes parent must be writable");
  assert.ok(policy.writeRoots.includes(path.resolve(agentHome)), "missing agent home path is still an allowed target");
  assert.ok(!policy.writeRoots.includes(realpathSync(worktree)), "worktree remains read-only");
});

test("read-only ACP sandbox allows outer client to create project agent homes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-agent-sandbox-runtime-root-"));
  const worktree = path.join(root, "worktree");
  const runtimeRoot = path.join(root, "runtime");
  const agentHomesRoot = path.join(runtimeRoot, "agent-homes");
  const auditRoot = path.join(runtimeRoot, "acp-audit");
  const phaseOutput = path.join(runtimeRoot, "phase-io", "verify");
  await mkdir(worktree, { recursive: true });
  await mkdir(agentHomesRoot, { recursive: true });
  await mkdir(auditRoot, { recursive: true });
  await mkdir(phaseOutput, { recursive: true });

  const policy = resolveAgentSandboxPolicy({
    CPB_AGENT_SANDBOX: "best-effort",
    CPB_ACP_WRITE_ALLOW: `${phaseOutput}/*`,
    CPB_PROJECT_RUNTIME_ROOT: runtimeRoot,
    TMPDIR: path.join(root, "tmp"),
  }, {
    cwd: worktree,
    platform: "darwin",
    probe: (command) => command === "sandbox-exec",
  });

  assert.ok(policy.writeRoots.includes(realpathSync(agentHomesRoot)), "outer ACP client can create agent-specific homes");
  assert.ok(policy.writeRoots.includes(realpathSync(auditRoot)), "outer ACP client can write audit logs");
  assert.ok(!policy.writeRoots.includes(realpathSync(worktree)), "worktree remains read-only");
});

test("sandboxed node wrapper can read script path passed as an argument", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-agent-sandbox-args-"));
  const worktree = path.join(root, "worktree");
  const scriptsDir = path.join(root, "scripts");
  const scriptPath = path.join(scriptsDir, "agent-wrapper.js");
  await mkdir(worktree, { recursive: true });
  await mkdir(scriptsDir, { recursive: true });
  await writeFile(scriptPath, "console.log('ok')\n", "utf8");

  const launch = buildAgentSandboxLaunch(process.execPath, [scriptPath], {
    cwd: worktree,
    platform: "darwin",
    probe: (command) => command === "sandbox-exec",
    env: {
      CPB_AGENT_SANDBOX: "best-effort",
      CPB_ACP_WRITE_ALLOW: `${path.join(root, "phase-io")}/*`,
    },
  });

  const readRoots = launch.sandbox.readRoots;
  assert.ok(readRoots.includes(realpathSync(scriptsDir)), "wrapper script directory is readable");
});

test("sandboxed global Node launcher can read exact optional native dependency packages", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-agent-sandbox-node-cli-"));
  const globalRoot = path.join(root, "lib", "node_modules");
  const packageRoot = path.join(globalRoot, "@zed-industries", "codex-acp");
  const nativeRoot = path.join(globalRoot, "@zed-industries", "codex-acp-darwin-arm64");
  const binDir = path.join(root, "bin");
  const entrypoint = path.join(packageRoot, "bin", "codex-acp.js");
  const command = path.join(binDir, "codex-acp");
  await mkdir(path.dirname(entrypoint), { recursive: true });
  await mkdir(nativeRoot, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
    name: "@zed-industries/codex-acp",
    optionalDependencies: { "@zed-industries/codex-acp-darwin-arm64": "1.0.0" },
  }), "utf8");
  await writeFile(path.join(nativeRoot, "package.json"), JSON.stringify({
    name: "@zed-industries/codex-acp-darwin-arm64",
  }), "utf8");
  await writeFile(entrypoint, "console.log('ok')\n", "utf8");
  await symlink(entrypoint, command);

  const launch = buildAgentSandboxLaunch(command, [], {
    cwd: root,
    platform: "darwin",
    probe: (name) => name === "sandbox-exec",
    env: { CPB_AGENT_SANDBOX: "required", PATH: binDir },
  });

  assert.ok(launch.sandbox.readRoots.includes(realpathSync(packageRoot)));
  assert.ok(launch.sandbox.readRoots.includes(realpathSync(nativeRoot)));
  assert.ok(!launch.sandbox.readRoots.includes(realpathSync(globalRoot)), "global node_modules root stays unavailable");
});

test("macOS sandbox permits ignored child stdio without broad device writes", () => {
  const launch = buildAgentSandboxLaunch(process.execPath, ["-e", "0"], {
    cwd: process.cwd(),
    platform: "darwin",
    probe: (command) => command === "sandbox-exec",
    env: {
      CPB_AGENT_SANDBOX: "best-effort",
    },
  });

  const profile = String(launch.args[1]);
  assert.match(profile, /\(allow file-write\* \(literal "\/dev\/null"\)\)/);
  assert.doesNotMatch(profile, /\(allow file-write\* \(subpath "\/dev"\)\)/);
  assert.doesNotMatch(profile, /^\(allow file-read\*\)$/m);
  assert.match(profile, /\(allow file-read\* .*\(subpath /);
  assert.match(profile, /\(subpath "\/etc\/codex\/requirements\.toml"\)/);
  assert.match(profile, /\(subpath "\/private\/etc\/resolv\.conf"\)/);
  assert.match(profile, /\(subpath "\/etc\/ssl\/openssl\.cnf"\)/);
  assert.match(profile, /\(subpath "\/private\/etc\/ssl\/openssl\.cnf"\)/);
  assert.match(profile, /\(subpath "\/private\/var\/run\/mDNSResponder"\)/);
  assert.doesNotMatch(profile, /\(subpath "\/etc"\)/);
  assert.doesNotMatch(profile, /\(subpath "\/private\/etc"\)/);
  assert.match(profile, /com\.apple\.trustd\.agent/);
  assert.match(profile, /com\.apple\.securityd/);
  assert.match(profile, /com\.apple\.mDNSResponder/);
  assert.match(profile, /com\.apple\.SystemConfiguration\.configd/);
  assert.doesNotMatch(profile, /^\(allow mach\*\)$/m);
});

test("Linux bwrap omits read binds already covered by system or writable roots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-agent-sandbox-bwrap-roots-"));
  const launch = buildAgentSandboxLaunch("/bin/zsh", ["-c", "true"], {
    cwd: root,
    platform: "linux",
    probe: (command) => command === "bwrap",
    env: {
      CPB_AGENT_SANDBOX: "required",
      CPB_AGENT_SANDBOX_ALLOW_READ: "/usr/bin",
    },
  });

  const readBindDestinations: string[] = [];
  const writeBindDestinations: string[] = [];
  for (let index = 0; index < launch.args.length; index += 1) {
    if (launch.args[index] === "--ro-bind-try") readBindDestinations.push(launch.args[index + 2]);
    if (launch.args[index] === "--bind-try") writeBindDestinations.push(launch.args[index + 2]);
  }

  assert.equal(launch.command, "bwrap");
  assert.equal(readBindDestinations.filter((destination) => destination === "/bin").length, 1);
  assert.equal(readBindDestinations.filter((destination) => destination === "/usr").length, 1);
  assert.equal(readBindDestinations.includes("/usr/bin"), false);
  assert.equal(readBindDestinations.includes(root), false);
  assert.equal(writeBindDestinations.filter((destination) => destination === root).length, 1);
});

test("inherited sandbox marker prevents nested sandbox launch", () => {
  const launch = buildAgentSandboxLaunch(process.execPath, ["-e", "0"], {
    cwd: process.cwd(),
    platform: "darwin",
    probe: (command) => command === "sandbox-exec",
    env: {
      CPB_AGENT_SANDBOX: "best-effort",
      CPB_AGENT_SANDBOX_INHERITED: "1",
    },
  });

  assert.equal(launch.command, process.execPath);
  assert.equal(launch.sandbox.enabled, false);
});
