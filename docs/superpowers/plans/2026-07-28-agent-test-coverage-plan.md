# Agent 测试覆盖子计划(A3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 agent 子系统的四个盲区(dynamic-agent-plan / session-cache lifecycle / session-pin / agent-isolation)补齐直接单测,并加一条 agent 子系统测试门禁——作为 RFC §4 中 Phase B 重构"删除 codex/claude 特判"的安全网。

**Architecture:** 纯加测试,零生产代码改动,冻结期安全。测试为** characterization 风格**:固化当前正确行为(含 `CODEX_HOME` 跳过继承、handoff 开新会话等"反直觉但有意"的语义),使 Phase B 重构不会静默改变它们。用 Node 内置 `node:test` + `node:assert/strict`,编译到 `dist-tests/`,经 `node dist-tests/scripts/run-node-tests.js` 执行。

**Tech Stack:** TypeScript(strict, ESM)→ `dist-tests/`;Node ≥ 20 内置 test runner;`node:fs/promises` + `node:os` `mkdtemp` 做临时隔离。

**父 RFC:** `docs/superpowers/plans/2026-07-28-cpb-agent-platform-maturity-rfc.md` §5 A3。

## Global Constraints

- **分层不变量**:测试可 import `core/**`,禁止 import `server/**`(与生产代码同一约束)。
- **编译先行**:改/加 `.ts` 测试后须 `npm run build:tests` 再跑(runner 跑的是 `dist-tests/*.js`)。
- **测试环境隔离**:runner 启动时清所有 `CPB_*` 环境变量并强制 `CPB_CHECKLIST_DECOMPOSE=0` / `CPB_WORKER_DISPATCH_ENABLED=0`;单测内**显式传**所需 env(如 `parentEnv.HOME`),不依赖宿主 `process.env`。
- **import 路径**:测试用相对 `.js` 路径 import 编译产物(如 `../core/agents/session-cache.js`),与现有 `tests/setup-manifest-registry.test.ts` 一致。
- **临时目录**:每个用例 `mkdtemp` 自建根,结束 `rm -rf` 清理,避免跨用例污染。

## File Structure

- **Create** `tests/dynamic-agent-plan.test.ts`——`generateDynamicAgentPlan` 风险分支 + `validateDynamicAgentPlan` 缺角色判定。
- **Create** `tests/session-cache-lifecycle.test.ts`——save/load/clear/recycle + **agent-scoped 语义**(handoff→null、过期→null)。
- **Create** `tests/session-pin.test.ts`——`pinSessionToJob` 写入 + best-effort 吞错。
- **Create** `tests/agent-isolation.test.ts`——`createAgentHome` HOME 布局/权限/git 中立 env、`safeSegment` 拒绝穿越、codex `auth.json` 继承、`config.toml` quarantine、`CODEX_HOME` 跳过分支 pin。
- **Modify** `package.json`——加 `test:agent-subsystem` 脚本(聚合上述 4 文件)。

---

### Task 1: dynamic-agent-plan 直接单测

**Files:**
- Create: `tests/dynamic-agent-plan.test.ts`
- Test target: `core/agents/dynamic-agent-plan.ts`(`generateDynamicAgentPlan` :127、`validateDynamicAgentPlan` :78、`highRisk` :13、`DEFAULT_DYNAMIC_VERIFIER_AGENT` :2)

**Interfaces:**
- Consumes: `generateDynamicAgentPlan(options)` where `options = { riskMap?, workflowDag?, verifierAgent?, adversarialVerifierAgent?, independentVerifierRequired? }` → `{ schemaVersion, source, independentVerifierRequired, agentConfig: { verifier?, adversarial_verifier? }, nodeConfig, roleToNodeIds, ... }`;`validateDynamicAgentPlan(plan, workflowDag)` → `{ valid: true } | { valid: false, reason, missingRoles }`。
- Produces: 无下游依赖。

- [ ] **Step 1: 写测试文件**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateDynamicAgentPlan, validateDynamicAgentPlan } from "../core/agents/dynamic-agent-plan.js";

test("low-risk plan: no required verifier, schemaVersion=1, source=riskmap", () => {
  const plan = generateDynamicAgentPlan({ riskMap: { riskLevel: "low" }, workflowDag: { nodes: [] } });
  assert.equal(plan.independentVerifierRequired, false);
  assert.equal(plan.agentConfig.verifier, undefined);
  assert.equal(plan.agentConfig.adversarial_verifier, undefined);
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.source, "riskmap");
});

test("high-risk plan forces required independent verifier + adversarial_verifier", () => {
  const plan = generateDynamicAgentPlan({ riskMap: { riskLevel: "high" }, workflowDag: { nodes: [] } });
  assert.equal(plan.independentVerifierRequired, true);
  assert.equal(plan.agentConfig.verifier.required, true);
  assert.equal(plan.agentConfig.verifier.independent, true);
  assert.equal(plan.agentConfig.adversarial_verifier.required, true);
});

test("critical risk and adversarialRequired both trigger independent verifier", () => {
  for (const riskMap of [{ riskLevel: "critical" }, { adversarialRequired: true }]) {
    const plan = generateDynamicAgentPlan({ riskMap, workflowDag: { nodes: [] } });
    assert.equal(plan.independentVerifierRequired, true, JSON.stringify(riskMap));
  }
});

test("verifier agent defaults to codex; overridable via options", () => {
  const a = generateDynamicAgentPlan({ riskMap: { riskLevel: "high" }, workflowDag: { nodes: [] } });
  assert.equal(a.agentConfig.verifier.agent, "codex");
  const b = generateDynamicAgentPlan({
    riskMap: { riskLevel: "high" },
    workflowDag: { nodes: [] },
    verifierAgent: "claude",
    adversarialVerifierAgent: "claude-glm",
  });
  assert.equal(b.agentConfig.verifier.agent, "claude");
  assert.equal(b.agentConfig.adversarial_verifier.agent, "claude-glm");
});

test("validateDynamicAgentPlan: required verifier with bound verify node is valid", () => {
  const workflowDag = { nodes: [{ id: "v1", phase: "verify" }] };
  const plan = generateDynamicAgentPlan({ riskMap: { riskLevel: "high" }, workflowDag });
  const result = validateDynamicAgentPlan(plan, workflowDag);
  assert.equal(result.valid, true);
});

test("validateDynamicAgentPlan: required verifier with verify node but no id binding is invalid", () => {
  // node has phase=verify but no id → nodeConfigForDag skips it → computed binding empty
  const workflowDag = { nodes: [{ phase: "verify" }] };
  const plan = { agentConfig: { verifier: { required: true } }, roleToNodeIds: {} };
  const result = validateDynamicAgentPlan(plan, workflowDag);
  assert.equal(result.valid, false);
  assert.deepEqual(result.missingRoles, ["verifier"]);
});
```

- [ ] **Step 2: 编译**

Run: `npm run build:tests`
Expected: 退出 0,`dist-tests/tests/dynamic-agent-plan.test.js` 生成。

- [ ] **Step 3: 跑测试,确认通过**

Run: `node dist-tests/scripts/run-node-tests.js tests/dynamic-agent-plan.test.ts`
Expected: 6 个用例 PASS。

- [ ] **Step 4: Commit**

```bash
git add tests/dynamic-agent-plan.test.ts
git commit -m "test(agents): cover dynamic-agent-plan risk branches and validation"
```

---

### Task 2: session-cache lifecycle + agent-scoped 语义(固化 RFC D1)

**Files:**
- Create: `tests/session-cache-lifecycle.test.ts`
- Test target: `core/agents/session-cache.ts`(`saveSessionId` :1237、`loadSessionId` :1261、`clearSessionId` :1298、`cacheEntryName` :118、`assertSessionRecordBinding` :1200)

**Interfaces:**
- Consumes: `saveSessionId(cpbRoot, agent, sessionId, { dataRoot, conversationKey })`;`loadSessionId(cpbRoot, agent, { dataRoot, conversationKey, maxAgeMs?, now? })` → record | null;`clearSessionId(cpbRoot, agent, { dataRoot, conversationKey })`。
- Produces: 固化 RFC §5 D1——"缓存键含 agent,handoff→null"。

- [ ] **Step 1: 写测试文件**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveSessionId, loadSessionId, clearSessionId } from "../core/agents/session-cache.js";

async function freshRoot() {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-sess-"));
  return { cpbRoot, dataRoot: path.join(cpbRoot, "data") };
}
const cleanup = (dir) => rm(dir, { recursive: true, force: true });

test("save→load round-trips sessionId for same agent+conversation", async () => {
  const { cpbRoot, dataRoot } = await freshRoot();
  try {
    await saveSessionId(cpbRoot, "claude-glm", "sess-1", { dataRoot, conversationKey: "proj|job1|att0|executor" });
    const loaded = await loadSessionId(cpbRoot, "claude-glm", { dataRoot, conversationKey: "proj|job1|att0|executor" });
    assert.equal(loaded?.sessionId, "sess-1");
  } finally { await cleanup(cpbRoot); }
});

test("cache key includes agent: same conversation, different agent → null (handoff = new session)", async () => {
  const { cpbRoot, dataRoot } = await freshRoot();
  try {
    await saveSessionId(cpbRoot, "claude-glm", "sess-1", { dataRoot, conversationKey: "k1" });
    const miss = await loadSessionId(cpbRoot, "claude-mimo", { dataRoot, conversationKey: "k1" });
    assert.equal(miss, null);
  } finally { await cleanup(cpbRoot); }
});

test("expiry: record older than maxAgeMs returns null", async () => {
  const { cpbRoot, dataRoot } = await freshRoot();
  try {
    await saveSessionId(cpbRoot, "codex", "sess-old", { dataRoot, conversationKey: "k2" });
    const loaded = await loadSessionId(cpbRoot, "codex", {
      dataRoot, conversationKey: "k2", maxAgeMs: 1000, now: Date.now() + 60_000,
    });
    assert.equal(loaded, null);
  } finally { await cleanup(cpbRoot); }
});

test("clear removes the record", async () => {
  const { cpbRoot, dataRoot } = await freshRoot();
  try {
    await saveSessionId(cpbRoot, "codex", "sess-3", { dataRoot, conversationKey: "k3" });
    await clearSessionId(cpbRoot, "codex", { dataRoot, conversationKey: "k3" });
    const loaded = await loadSessionId(cpbRoot, "codex", { dataRoot, conversationKey: "k3" });
    assert.equal(loaded, null);
  } finally { await cleanup(cpbRoot); }
});
```

- [ ] **Step 2: 编译**

Run: `npm run build:tests`
Expected: 退出 0。

- [ ] **Step 3: 跑测试,确认通过**

Run: `node dist-tests/scripts/run-node-tests.js tests/session-cache-lifecycle.test.ts`
Expected: 4 用例 PASS。若 `saveSessionId` 第 4 参签名不符(报错指 `dataRoot`/`conversationKey`),核对 `core/agents/session-cache.ts:1237` 的 options 形参名并修正测试,再跑。

- [ ] **Step 4: Commit**

```bash
git add tests/session-cache-lifecycle.test.ts
git commit -m "test(agents): cover session-cache lifecycle and agent-scoped handoff semantics"
```

---

### Task 3: session-pin 直接单测

**Files:**
- Create: `tests/session-pin.test.ts`
- Test target: `core/engine/session-pin.ts`(`pinSessionToJob` :22)

**Interfaces:**
- Consumes: `pinSessionToJob(cpbRoot, project, jobId, { phase, sessionId, agentPid, dataRoot })` → `Promise<void>`;写入 `<dataRoot>/processes/<jobId>.json` 的 `sessionPin` 字段;进程文件不存在 → 直接 return;任何异常 → 吞掉。

- [ ] **Step 1: 写测试文件**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pinSessionToJob } from "../core/engine/session-pin.js";

test("pin writes sessionPin into the job process file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-pin-"));
  try {
    const dataRoot = path.join(dir, "data");
    const processesDir = path.join(dataRoot, "processes");
    await mkdir(processesDir, { recursive: true });
    const file = path.join(processesDir, "job-1.json");
    await writeFile(file, `${JSON.stringify({ jobId: "job-1", status: "running" }, null, 2)}\n`, "utf8");

    await pinSessionToJob(dir, "proj", "job-1", {
      phase: "verify", sessionId: "sess-9", agentPid: 4242, dataRoot,
    });

    const after = JSON.parse(await readFile(file, "utf8"));
    assert.equal(after.status, "running");           // 原字段保留
    assert.equal(after.sessionPin.sessionId, "sess-9");
    assert.equal(after.sessionPin.agentPid, 4242);
    assert.equal(after.sessionPin.phase, "verify");
    assert.match(after.sessionPin.pinnedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("pin is best-effort: missing process file → noop, no throw", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-pin-"));
  try {
    const dataRoot = path.join(dir, "data");
    await assert.doesNotReject(() =>
      pinSessionToJob(dir, "proj", "never-existed", {
        phase: "verify", sessionId: "s", agentPid: 1, dataRoot,
      }),
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 编译 + 跑**

Run: `npm run build:tests && node dist-tests/scripts/run-node-tests.js tests/session-pin.test.ts`
Expected: 2 用例 PASS。

- [ ] **Step 3: Commit**

```bash
git add tests/session-pin.test.ts
git commit -m "test(engine): cover session-pin best-effort write"
```

---

### Task 4: agent-isolation 直接单测(含 CODEX_HOME 分支 pin)

**Files:**
- Create: `tests/agent-isolation.test.ts`
- Test target: `core/agents/isolation.ts`(`createAgentHome` :638、`safeSegment` :163、`assertContained` :205、`inheritCodexConfig` :577、`resolveSourceCodexHome` :97)

**Interfaces:**
- Consumes: `createAgentHome(cpbRoot, agentName, jobId, { parentEnv?, dataRoot?, isolateTemp?, instanceId? })` → env record(`HOME` / `XDG_*` / `GIT_CONFIG_GLOBAL="/dev/null"` / `GIT_CONFIG_NOSYSTEM="1"` / `PATH`)。codex 分支条件 `agentName === "codex" && !parentEnv.CODEX_HOME`(`:680`)→ 调 `inheritCodexConfig`(拷 `auth.json`、quarantine `config.toml`)。`safeSegment` 对非法段抛 `CPB_AGENT_HOME_INVALID_SEGMENT`。

- [ ] **Step 1: 写测试文件**

```ts
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
      (err) => err.code === "CPB_AGENT_HOME_INVALID_SEGMENT",
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
```

- [ ] **Step 2: 编译 + 跑**

Run: `npm run build:tests && node dist-tests/scripts/run-node-tests.js tests/agent-isolation.test.ts`
Expected: 5 用例 PASS。若 `config.toml` quarantine 用例失败(目录已存在导致 mkdir 行为差异),核对 `inheritCodexConfig` :584 的 quarantine 触发条件后调整。

- [ ] **Step 3: Commit**

```bash
git add tests/agent-isolation.test.ts
git commit -m "test(agents): cover createAgentHome layout, auth inheritance, config.toml quarantine"
```

---

### Task 5: agent 子系统测试门禁

**Files:**
- Modify: `package.json`(`scripts` 块)

**Interfaces:**
- Consumes: 上述 4 个新测试文件。
- Produces: `npm run test:agent-subsystem` 一键跑全部新测试,供 CI / `verify:release-gate` 引用。

- [ ] **Step 1: 加脚本**

在 `package.json` 的 `"scripts"` 中加入(位置紧跟现有 `test:unit` / `test:integration`):

```json
"test:agent-subsystem": "node dist-tests/scripts/run-node-tests.js tests/dynamic-agent-plan.test.ts tests/session-cache-lifecycle.test.ts tests/session-pin.test.ts tests/agent-isolation.test.ts"
```

- [ ] **Step 2: 跑门禁**

Run: `npm run build:tests && npm run test:agent-subsystem`
Expected: 4 文件全部 PASS(共 17 用例)。

- [ ] **Step 3: 确认未破坏既有测试**

Run: `npm run typecheck:strict:engine && node dist-tests/scripts/run-node-tests.js --unit`
Expected: typecheck 退出 0;unit 全绿。

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore(test): add test:agent-subsystem gate for agent blind-spot coverage"
```

---

## Self-Review(写计划后自查)

**1. RFC §5 A3 覆盖**:`dynamic-agent-plan` 直测 ✓(Task 1)、`session-cache` e2e ✓(Task 2)、`session-pin` 直测 ✓(Task 3)、`isolation` 直测 ✓(Task 4)、coverage 门禁 ✓(Task 5)。
**2. D1 语义固化**:Task 2 的"handoff→null"用例 + Task 4 的"CODEX_HOME 跳过继承"用例分别 pin 住两处反直觉语义。
**3. 无占位符**:所有测试代码基于已核实签名(见各 Task 的 Interfaces 与 file:line);Task 5 的 package.json 片段为可直接 apply 的 JSON。
**4. 类型一致**:`generateDynamicAgentPlan` 返回字段(`independentVerifierRequired`/`agentConfig.verifier.required`)、`loadSessionId` 返回 `record | null`、`createAgentHome` 返回 env——各 Task 间引用一致。
**5. 覆盖率 % 门槛**:本计划只做"盲区文件直测 + 聚合门禁";真正的 line-coverage % 门槛(类比 `typecheck:strict:engine`)留作后续小步迭代(先有直测,再谈阈值),避免在未观测实际覆盖率前硬设数字。

## Execution Handoff

子计划已保存。两种执行方式:

1. **Subagent-Driven(推荐)** — 每个 Task 派一个 fresh subagent,task 间 review。
2. **Inline Execution** — 本会话按 executing-plans 批量执行 + 检查点。

(本计划属 Phase A、冻结期安全、零生产代码改动,执行无解冻风险。)
