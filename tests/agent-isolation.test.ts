import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentHome } from "../core/agents/isolation.js";

const clean = (dir) => rm(dir, { recursive: true, force: true });

test("createAgentHome builds 0o700 HOME under dataRoot with git-neutral env", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-iso-"));
  try {
    const dataRoot = path.join(dir, "runtime");
    const env = await createAgentHome(dir, "codex", "job-1", { dataRoot });
    assert.ok(env.HOME.startsWith(path.join(dataRoot, "agent-homes", "codex", "job-1")));
    assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(typeof env.PATH, "string");
    const st = await stat(env.HOME);
    assert.equal(st.mode & 0o777, 0o700);
    for (const sub of [".config", ".local/share", ".cache", ".tmp"]) {
      await stat(path.join(env.HOME, sub)); // 存在即通过
    }
  } finally { await clean(dir); }
});

test("safeSegment rejects path-traversing agentName", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-iso-"));
  try {
    const dataRoot = path.join(dir, "runtime");
    await assert.rejects(
      () => createAgentHome(dir, "../evil", "job-1", { dataRoot }),
      (err: unknown) => (err as { code?: string }).code === "CPB_AGENT_HOME_INVALID_SEGMENT",
    );
  } finally { await clean(dir); }
});

test("codex (no CODEX_HOME): copies auth.json from $HOME/.codex", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-iso-"));
  try {
    const dataRoot = path.join(dir, "runtime");
    const fakeHome = path.join(dir, "userhome");
    await mkdir(path.join(fakeHome, ".codex"), { recursive: true });
    await writeFile(path.join(fakeHome, ".codex", "auth.json"), '{"token":"x"}');
    const env = await createAgentHome(dir, "codex", "job-2", { dataRoot, parentEnv: { HOME: fakeHome } });
    const copied = await readFile(path.join(env.HOME, ".codex", "auth.json"), "utf8");
    assert.equal(copied, '{"token":"x"}');
  } finally { await clean(dir); }
});

test("codex: stale config.toml in target home is quarantined on re-run", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-iso-"));
  try {
    const dataRoot = path.join(dir, "runtime");
    const fakeHome = path.join(dir, "userhome");
    await mkdir(path.join(fakeHome, ".codex"), { recursive: true });
    await writeFile(path.join(fakeHome, ".codex", "auth.json"), "{}");
    const env1 = await createAgentHome(dir, "codex", "job-3", { dataRoot, parentEnv: { HOME: fakeHome } });
    // 模拟旧 CPB run 留下的 config.toml
    await writeFile(path.join(env1.HOME, ".codex", "config.toml"), 'model = "old"');
    // 同一 home 再跑一次 → inheritCodexConfig 应把它 quarantine
    await createAgentHome(dir, "codex", "job-3", { dataRoot, parentEnv: { HOME: fakeHome } });
    const entries = await readdir(path.join(env1.HOME, ".codex"));
    assert.ok(entries.some((e) => e.startsWith("config.toml.quarantine-")), entries.join(","));
  } finally { await clean(dir); }
});

test("characterize: parentEnv.CODEX_HOME set → inherit skipped (auth NOT copied) [pins review P2 behavior]", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-iso-"));
  try {
    const dataRoot = path.join(dir, "runtime");
    const customCodexHome = path.join(dir, "custom-codex");
    await mkdir(customCodexHome, { recursive: true });
    await writeFile(path.join(customCodexHome, "auth.json"), '{"token":"y"}');
    const env = await createAgentHome(dir, "codex", "job-4", { dataRoot, parentEnv: { CODEX_HOME: customCodexHome } });
    // 当前行为:codex 分支 gated on !CODEX_HOME → inheritCodexConfig 不执行 → auth 未拷贝。
    // Phase B 若改为"始终从 CODEX_HOME 继承",本测试须同步更新。
    await assert.rejects(() => readFile(path.join(env.HOME, ".codex", "auth.json")));
  } finally { await clean(dir); }
});
