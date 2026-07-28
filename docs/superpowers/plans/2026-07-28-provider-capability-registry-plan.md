# Provider Capability Registry 子计划(Phase B / B1–B5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **⚠️ 解冻前置**:本计划属 Phase B,**执行前必须获得稳定化周期解冻 sign-off**(见父 RFC §4)。计划本身现在就能写;但落到 `core/**/*.ts` 的任务(B2 起)只能在解冻后开干,且每个 PR 须说明触及发布门禁 + 跑 `npm run verify:release-gate`。

**Goal:** 引入唯一的 **Provider Capability Registry**——把 provider family 归类、HOME 继承文件、sandbox 策略、默认角色、tie-break 优先级全部下沉为 descriptor 声明字段,删除所有 `==="codex"` / `==="claude"` 字面量特判。验收:写一个 `descriptors/gemini.json`、**不改任何 `core/**/*.ts`**,即可全链路接入。

**Architecture:** 先加字段、新旧并存(B1);再逐点把选择/隔离层改成读 registry,每点以 A3 直接单测为前置(B2);然后补 mutation API + CLI(B3)、对齐两套 catalog(B4);最后 gemini dogfood 验收(B5)。全程 env `CPB_PROVIDER_REGISTRY=0` 作 kill switch,旧 helper 保留至 B5 通过。

**Tech Stack:** TypeScript(strict, ESM)→ `dist/`;Node 内置 test runner;文件系统持久化(JSON descriptor)。

**父 RFC:** `docs/superpowers/plans/2026-07-28-cpb-agent-platform-maturity-rfc.md` §6(架构 + §6.2 字段/迁移表/安全约束 + §6.3 删除清单 + §6.4 序列 + §6.5 DoD)。

## Global Constraints

- **解冻门禁**:B2 起的代码改动需解冻 sign-off;PR 说明触及门禁 + 跑 `verify:release-gate`。
- **A3 前置**:B2 删每个特判点前,确认对应 A3 直接单测在场且通过(A3 子计划已交付)。
- **kill switch**:每个 B2 任务保留 `CPB_PROVIDER_REGISTRY=0` 回退旧字面量路径;旧 `inheritCodexConfig`/`inheritClaudeConfig` 保留至 B5 通过。
- **安全约束**:`inheritFiles` 泛化必须满足 §6.2 安全块(source 白名单 / `to` containment / 1 MiB 全局上限 / fail-closed / `from` 环境感知)。
- **分层不变量**:`core/` 禁 import `server/`。
- **编译先行**:改 `.ts` 后 `npm run build:tests` 再跑测试;import 用相对 `.js`。

## File Structure

- **Modify** `core/agents/registry.ts`——`validateDescriptor` 接受新字段;新增 `getCapability(name)` 查询 + `registerDescriptor()`(B3)。
- **Modify** `core/agents/descriptors/*.json`——6 个 descriptor 加新字段(B1 迁移表)。
- **Modify** `core/agents/outcome-routing.ts`、`core/agents/isolation.ts`、`core/agents/agent-runner.ts`、`core/agents/dynamic-agent-plan.ts`、`core/policy/high-assurance.ts`、`core/engine/{provider-handoff,phase-retry}.ts`、`core/agents/registry.ts`——删字面量、读 registry(B2)。
- **Modify** `core/setup/manifests/*.json` + `core/agents/descriptors/*.json`——对齐条目来源、定义 `defaultRoles ⊆ roles` 不变式(B4)。
- **Modify** `cli/commands/agents.ts`——`cpb agents add` / `register`(B3)。
- **Create** `descriptors/gemini.json`——dogfood(B5)。
- **Create** `tests/provider-capability-registry.test.ts`、`tests/agent-register-cli.test.ts`、`tests/gemini-dogfood.test.ts`——各任务测试。

---

### Task B1: descriptor schema 扩展 + registry 读取(新旧并存)

**Files:**
- Modify: `core/agents/registry.ts`(`validateDescriptor` :39-49;新增 `getCapability`)
- Modify: `core/agents/descriptors/{codex,claude,claude-glm,claude-mimo,browser-agent,fake-acp}.json`
- Test: `tests/provider-capability-registry.test.ts`

**Interfaces:**
- Produces:`getCapability(name) → { providerFamily, tieBreakPriority, sandboxPolicy, inheritFiles, quarantineFiles } | null`;descriptor 新字段可选,`validateDescriptor` 不因新字段失败。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRegistry, getDescriptor, getCapability, listAgents } from "../core/agents/registry.js";

test("shipped descriptors carry provider capability fields", async () => {
  await loadRegistry("");
  const fam = new Map(listAgents().map((d) => [d.name, d]));
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
```

- [ ] **Step 2: 跑确认失败**

Run: `npm run build:tests && node dist-tests/scripts/run-node-tests.js tests/provider-capability-registry.test.ts`
Expected: FAIL(`getCapability` 未导出 / 字段缺失)。

- [ ] **Step 3: 扩 validateDescriptor + 加 getCapability**

`registry.ts`:
- `validateDescriptor`(39-49)对新字段**只做类型宽容校验**(可选;`providerFamily`/`sandboxPolicy` 为 string、`tieBreakPriority` 为非负数、`inheritFiles`/`quarantineFiles` 为数组),不要求必填,旧 descriptor 不受影响。
- 新增导出:
```ts
export type AgentCapability = {
  providerFamily: string | null;
  tieBreakPriority: number;
  sandboxPolicy: "native" | "cpb-required" | "none";
  inheritFiles: Array<{ from: string; to: string; maxBytes?: number }>;
  quarantineFiles: string[];
};
export function getCapability(name: string): AgentCapability | null {
  ensureLoaded();
  const d = _registry.get(name) || _discovered.get(name);
  if (!d) return null;
  return {
    providerFamily: typeof d.providerFamily === "string" ? d.providerFamily : null,
    tieBreakPriority: Number.isFinite(d.tieBreakPriority) ? d.tieBreakPriority : 1000,
    sandboxPolicy: ["native", "cpb-required", "none"].includes(d.sandboxPolicy) ? d.sandboxPolicy : "cpb-required",
    inheritFiles: Array.isArray(d.inheritFiles) ? d.inheritFiles : [],
    quarantineFiles: Array.isArray(d.quarantineFiles) ? d.quarantineFiles : [],
  };
}
```

- [ ] **Step 4: 6 个 descriptor 按迁移表加字段**

按 RFC §6.2 迁移表给 `codex.json` / `claude.json` / `claude-glm.json` / `claude-mimo.json` / `browser-agent.json` / `fake-acp.json` 加 `providerFamily` / `tieBreakPriority` / `sandboxPolicy` / `inheritFiles` / `quarantineFiles`。例(codex.json 追加):
```json
  "providerFamily": "codex",
  "tieBreakPriority": 10,
  "sandboxPolicy": "native",
  "inheritFiles": [{ "from": "$CODEX_HOME/auth.json", "to": "$HOME/.codex/auth.json", "maxBytes": 1048576 }],
  "quarantineFiles": ["config.toml"],
```
claude 系 `inheritFiles`:`[{from:"$HOME/.claude.json",to:"$HOME/.claude.json"},{from:"$HOME/.claude/.credentials.json",to:"$HOME/.claude/.credentials.json"},{from:"$HOME/.claude/credentials.json",to:"$HOME/.claude/credentials.json"},{from:"$HOME/.claude/auth.json",to:"$HOME/.claude/auth.json"}`。

- [ ] **Step 5: 跑确认通过 + 回归**

Run: `npm run build:tests && node dist-tests/scripts/run-node-tests.js tests/provider-capability-registry.test.ts && npm run typecheck:strict:engine`
Expected: 新测试 PASS;strict 门禁绿(新字段可选,零行为变更)。

- [ ] **Step 6: Commit**

```bash
git add core/agents/registry.ts core/agents/descriptors/*.json tests/provider-capability-registry.test.ts
git commit -m "feat(agents): add provider capability descriptor fields + getCapability (new/old coexist)"
```

---

### Task B2a: 删路由层特判(defaultAgentForRole + outcome-routing)

**前置**:A3 的 outcome-routing / routing 直测在场;`CPB_PROVIDER_REGISTRY=0` kill switch 就位。

**Files:**
- Modify: `core/agents/registry.ts:208-225`(`defaultAgentForRole`)、`core/agents/outcome-routing.ts:113-114`(tie-break)、`:119-127`(`providerFamilyFor`)
- Test: `tests/provider-capability-registry.test.ts`(追加)

**Interfaces:**
- Consumes:`getCapability(name).tieBreakPriority` / `.providerFamily`(B1)。

- [ ] **Step 1: 写失败测试(tie-break 与 family 由 descriptor 驱动)**

```ts
test("defaultAgentForRole no longer hard-codes codex; picks by defaultRoles + tieBreakPriority", async () => {
  await loadRegistry("");
  // codex 有 defaultRoles planner,且 tieBreakPriority=10(最低=最高优先)。仍选 codex,
  // 但理由是优先级而非字面量。注入一个 tieBreakPriority 更低的测试 descriptor 验证可超 codex。
  // (用 registerDescriptor 注入,见 B3;此处先断言 codex 因优先级胜出)
  assert.equal(defaultAgentForRole("planner"), "codex");
});

test("providerFamilyFor reads descriptor.providerFamily, falls back null for unknown", async () => {
  await loadRegistry("");
  // 假设 providerFamilyFor 改为读 registry:
  assert.equal(providerFamilyFor("claude-glm"), "glm");
  assert.equal(providerFamilyFor("codex"), "codex");
});
```
> 注:`defaultAgentForRole`、`providerFamilyFor` 须从各自模块 import;若 `providerFamilyFor` 当前不导出,在 B2a 一并导出。

- [ ] **Step 2: 改实现**

- `registry.ts:208-225` `defaultAgentForRole`:删 codex 短路;改为在 `defaultRoles` 含 role 的候选中,取 `getCapability(name).tieBreakPriority` 最小者(codex 仍因 priority=10 胜出,但走通用路径)。保留 `CPB_PROVIDER_REGISTRY=0` 时回退旧短路。
- `outcome-routing.ts:113-114` tie-break:`agent === "codex" ? -1 : 1` → 改为读 `getCapability(a).tieBreakPriority - getCapability(b).tieBreakPriority`。
- `outcome-routing.ts:119-127` `providerFamilyFor`:正则表 → `getCapability(name)?.providerFamily ?? <旧正则 fallback>(name)`(保留旧 fallback 作 kill-switch 路径)。

- [ ] **Step 3: 跑测试 + outcome-routing 回归**

Run: `npm run build:tests && node dist-tests/scripts/run-node-tests.js tests/provider-capability-registry.test.ts tests/outcome-routing.test.ts`
Expected: 全绿。

- [ ] **Step 4: Commit**

```bash
git add core/agents/registry.ts core/agents/outcome-routing.ts tests/provider-capability-registry.test.ts
git commit -m "refactor(agents): drive defaultAgentForRole + outcome tie-break/family from registry"
```

---

### Task B2b: 删隔离/继承层特判(isolation + agent-runner sandbox)

**前置**:A3 的 `tests/agent-isolation.test.ts` 在场(它是安全网)。

**Files:**
- Modify: `core/agents/isolation.ts:680-684` + `inheritCodexConfig`(:577)/`inheritClaudeConfig`(:594);`core/agents/agent-runner.ts:114`、`:354`

**Interfaces:**
- Consumes:`getCapability(name).inheritFiles` / `.quarantineFiles` / `.sandboxPolicy`。

- [ ] **Step 1: 写失败测试(通用 inheritFiles 循环)**

```ts
test("isolation inherits files per descriptor.inheritFiles (generic, no agent-name branch)", async () => {
  // 用 registerDescriptor(B3)注入一个伪 codex 兼容 descriptor,inheritFiles 指向受信根下的 auth 文件,
  // 断言它被拷到 $HOME 下对应 to。验证通用循环不再只认 codex/claude。
  // (B3 未落地前,此测试可先用现有 codex/claude descriptor 验证行为不变。)
});
```

- [ ] **Step 2: 抽通用 inherit 循环 + 容器校验**

- 新增 `inheritFilesIntoHome(targetHome, parentEnv, descriptor, { trusted })`:遍历 `descriptor.inheritFiles`,对每条做 §6.2 安全约束(canonicalize `to` 在 `$HOME` 内、`from` 解析自受信环境根 + credential 白名单、`maxBytes` ≤ `MAX_INHERITED_AUTH_BYTES`、拒 symlink),违反 → fail-closed。builtin descriptor `trusted=true`、user 级 `trusted=false`。
- `isolation.ts:680-684`:删 `if (agentName === "codex") ... else if (agentName === "claude")`;改为 `const cap = getCapability(agentName); if (cap?.inheritFiles?.length) await inheritFilesIntoHome(baseDir, parentEnv, cap, { trusted: isBuiltinDescriptor(agentName) });`,并对 `cap.quarantineFiles` 逐个 `isolateOwnedRegularFileNoFollow`。
- `agent-runner.ts:354` `if (agentName === "codex")` sandbox 跳过 → 读 `getCapability(agentName)?.sandboxPolicy === "native"`。`:114` `claudeArgsEnvKey` → 复用 `resolveAgentEnvPrefix(name)` 推 `${prefix}_ARGS`。
- 保留旧 `inheritCodexConfig`/`inheritClaudeConfig`,仅在 `CPB_PROVIDER_REGISTRY=0` 时调用。

- [ ] **Step 3: 跑 isolation 直测 + agent-sandbox 回归**

Run: `npm run build:tests && node dist-tests/scripts/run-node-tests.js tests/agent-isolation.test.ts tests/agent-sandbox.test.ts tests/agent-isolation-runtime-root.test.ts`
Expected: 全绿(行为等价)。

- [ ] **Step 4: Commit**

```bash
git add core/agents/isolation.ts core/agents/agent-runner.ts tests/agent-isolation.test.ts
git commit -m "refactor(agents): generic descriptor-driven inheritFiles + sandbox policy"
```

---

### Task B2c: 删剩余字面量(dynamic-agent-plan + high-assurance + handoff + retry)

**Files:**
- Modify: `core/agents/dynamic-agent-plan.ts:2`、`core/policy/high-assurance.ts:74-91`、`core/engine/provider-handoff.ts:171`、`core/engine/phase-retry.ts:299`

**Interfaces:**
- Consumes:`getCapability` / `defaultAgentForRole`。

- [ ] **Step 1: 改实现(逐点)**

- `dynamic-agent-plan.ts:2`:`DEFAULT_DYNAMIC_VERIFIER_AGENT = "codex"` → 改为函数 `defaultDynamicVerifierAgent()` = `defaultRoles` 含 verifier 的 agent 中 `tieBreakPriority` 最小者(运行时解析,codex 仍胜出)。
- `high-assurance.ts:74-91`:**保留显式 assurance 结构**(candidates/arbiter/verification{blind,independent});仅把 fallback 字面量 `"codex"`/`"claude-glm"` 改为 registry 解析(每槽取合格 agent 中优先级最高者);新增 fail-closed——`verification.independent=true` 时,若 registry 找不到与 execution 不同 `providerFamily` 的 verifier → throw/拒绝进入 high 模式。
- `provider-handoff.ts:171`:`selectedAgent === "claude"` variant → 通用 `getCapability(agent)?.providerKey ?? agent`。
- `phase-retry.ts:299`:`return "codex"` → `return defaultAgentForRole(role)`。

- [ ] **Step 2: 跑 high-assurance + dynamic-agent-plan 测试**

Run: `npm run build:tests && node dist-tests/scripts/run-node-tests.js tests/high-assurance-policy.test.ts tests/dynamic-agent-plan.test.ts`
Expected: 全绿。

- [ ] **Step 3: grep 验证字面量已清(选择/隔离/继承路径)**

Run: `grep -rn '==="codex"\|==="claude"\|"@zed-industries/codex-acp"' core/ server/ cli/ | grep -vE '\.test\.|//|/\*|descriptors/|setup/manifests|policy\.ts:[0-9]*\s*"@zed'`
Expected: 选择/隔离/继承路径零命中(测试 fixture、注释、双认检测集、descriptor/manifest 除外)。

- [ ] **Step 4: Commit**

```bash
git add core/agents/dynamic-agent-plan.ts core/policy/high-assurance.ts core/engine/provider-handoff.ts core/engine/phase-retry.ts
git commit -m "refactor(agents): remove remaining codex/claude literals from policy/retry/handoff"
```

---

### Task B3: mutation API + `cpb agents add` CLI

**Files:**
- Modify: `core/agents/registry.ts`(`registerDescriptor`)、`cli/commands/agents.ts`(加 `add`)
- Test: `tests/agent-register-cli.test.ts`

**Interfaces:**
- Produces:`registerDescriptor(descriptor, { trusted })` 校验 + 写 `CPB_AGENTS_CONFIG_DIR`;`cpb agents add <file> [--name]`。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadRegistry, registerDescriptor, hasAgent, getCapability } from "../core/agents/registry.js";

test("registerDescriptor writes a user descriptor and loads it (untrusted → inheritFiles constrained)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-agents-"));
  try {
    process.env.CPB_AGENTS_CONFIG_DIR = dir;
    const desc = {
      name: "gemini-test",
      command: "gemini-acp",
      envPrefix: "CPB_ACP_GEMINI_TEST",
      providerFamily: "gemini",
      tieBreakPriority: 50,
      sandboxPolicy: "cpb-required",
      inheritFiles: [{ from: "$HOME/.gemini/auth.json", to: "$HOME/.gemini/auth.json" }],
    };
    await registerDescriptor(desc, { trusted: false });
    await loadRegistry(dir);
    assert.equal(hasAgent("gemini-test"), true);
    assert.equal(getCapability("gemini-test")?.providerFamily, "gemini");
  } finally {
    delete process.env.CPB_AGENTS_CONFIG_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

test("registerDescriptor rejects untrusted descriptor with non-credential inherit from", async () => {
  // from 不在受信根/非 credential 白名单 → fail-closed
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-agents-"));
  try {
    process.env.CPB_AGENTS_CONFIG_DIR = dir;
    await assert.rejects(() => registerDescriptor({
      name: "evil", command: "x", envPrefix: "CPB_ACP_EVIL",
      inheritFiles: [{ from: "/etc/passwd", to: "$HOME/leak" }],
    }, { trusted: false }));
  } finally {
    delete process.env.CPB_AGENTS_CONFIG_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 实现 registerDescriptor**

`registry.ts`:`registerDescriptor(descriptor, { trusted = false })` → 若 `!trusted`,先跑 §6.2 安全校验(`from` 受信根 + credential 白名单、`to` containment、`maxBytes` 上限),失败 throw;通过则写 `${CPB_AGENTS_CONFIG_DIR}/<name>.json` 并 reload。

- [ ] **Step 3: 加 `cpb agents add` 子命令**

`cli/commands/agents.ts`:加 `add <file>` 分支——读 JSON、`registerDescriptor(desc, { trusted: false })`、打印结果;`usage()` 加入 `add`。

- [ ] **Step 4: 构建并冒烟**

Run: `npm run build && node dist/cli/cpb.js agents add /tmp/gemini.json`(造一个合法 descriptor)
Expected: 注册成功;`cpb agents list` 可见。

- [ ] **Step 5: Commit**

```bash
git add core/agents/registry.ts cli/commands/agents.ts tests/agent-register-cli.test.ts
git commit -m "feat(agents): add registerDescriptor API + 'cpb agents add' CLI"
```

---

### Task B4: 对齐两套 catalog(不合并字段)

**Files:**
- Modify: `core/setup/manifests/*.json` + `core/agents/descriptors/*.json`(条目来源对齐)
- Modify: `core/setup/agent-catalog.ts`(校验 `defaultRoles ⊆ roles`)+ `cli/commands/setup.ts:130-144,205`(从 catalog 读)
- Test: `tests/setup-manifest-registry.test.ts`(追加)

**Interfaces:**
- Produces:每个 agent 在 descriptor(`defaultRoles`)与 manifest(`roles`)两处命名/版本一致;不变式 `defaultRoles ⊆ roles`。

- [ ] **Step 1: 追加不变式测试**

```ts
test("for every descriptor with a matching manifest, defaultRoles ⊆ roles", async () => {
  // 加载 descriptors + manifests;对同名 agent 断言每个 defaultRole 都出现在 manifest.roles
});
```

- [ ] **Step 2: 对齐 + 校验**

- 同名 agent(codex/claude/...)在 `descriptors/*.json` 与 `manifests/*.json` 的命名/版本字段一致;**保留** `defaultRoles`(路由)与 `roles`(广告)分离。
- `core/setup/manifest-schema.ts` 或 `agent-catalog.ts`:加交叉校验 `defaultRoles ⊆ roles`,违反 → 校验失败。
- `cli/commands/setup.ts:130-144`(`detectQuickAgents`)、:205(默认 `claude`):改为从 `listSetupAgents()` 读,不再硬编码 4 个 / 默认 claude。
- `setup/` 开 `CPB_SETUP_MANIFESTS_DIR` 等价物(用户可放自定义 manifest)。

- [ ] **Step 3: 跑 setup 测试 + typecheck:strict:engine**

Run: `npm run build:tests && node dist-tests/scripts/run-node-tests.js tests/setup-manifest-registry.test.ts && npm run typecheck:strict:engine`
Expected: 全绿。

- [ ] **Step 4: Commit**

```bash
git add core/setup/ cli/commands/setup.ts tests/setup-manifest-registry.test.ts
git commit -m "refactor(setup): align catalog entries, assert defaultRoles ⊆ roles, data-drive quickstart"
```

---

### Task B5: gemini dogfood(零源码改接入)

**Files:**
- Create: `core/agents/descriptors/gemini.json`(或经 `CPB_AGENTS_CONFIG_DIR`)
- Test: `tests/gemini-dogfood.test.ts`

**Interfaces:**
- Consumes:B1–B4 全部。

- [ ] **Step 1: 写 gemini descriptor**

`core/agents/descriptors/gemini.json`:
```json
{
  "name": "gemini",
  "displayName": "Gemini (dogfood)",
  "command": "gemini-acp",
  "fallbackCommand": "npx",
  "fallbackArgs": ["-y", "@agentclientprotocol/gemini-acp"],
  "envPrefix": "CPB_ACP_GEMINI",
  "protocol": "acp",
  "lifecycle": "one-shot",
  "stability": "experimental",
  "providerFamily": "gemini",
  "tieBreakPriority": 60,
  "sandboxPolicy": "cpb-required",
  "defaultRoles": ["executor"],
  "capabilities": ["plan", "execute", "verify", "review"],
  "inheritFiles": [{ "from": "$HOME/.gemini/auth.json", "to": "$HOME/.gemini/auth.json", "maxBytes": 1048576 }],
  "quarantineFiles": []
}
```

- [ ] **Step 2: 写 dogfood 测试(断言接入无需改 .ts)**

```ts
test("gemini registers via descriptor alone; routing/isolation/home all descriptor-driven", async () => {
  await loadRegistry("");
  // (1) 注册成功
  assert.equal(hasAgent("gemini"), true);
  // (2) 默认角色解析(executor)
  assert.equal(defaultAgentForRole("executor-with-gemini-only"), /* 视 fixture */ "claude" || "gemini");
  // (3) outcome family = "gemini"(新家族,非未分类)
  assert.equal(providerFamilyFor("gemini"), "gemini");
  // (4) HOME 继承走通用 inheritFiles(不需 isolation.ts 加 gemini 分支)
  const cap = getCapability("gemini");
  assert.ok(cap?.inheritFiles?.length);
});
test("grep: no core/**/*.ts mentions 'gemini' by literal (接入零源码改)", async () => {
  // 用 execFile 跑 grep,断言 core/ 下无 "gemini" 字面量(除 descriptors/*.json)
});
```
> 若无真实 gemini ACP adapter,用 `fake-acp` 改 `providerFamily:"gemini"` 变体证明"零源码改接入"机制,gemini 真实二进制为加分项(见 RFC §7 风险表)。

- [ ] **Step 3: 全量回归 + release gate**

Run: `npm run build && npm run typecheck:strict:engine && node dist-tests/scripts/run-node-tests.js --unit && npm run verify:release-gate`
Expected: 全绿。

- [ ] **Step 4: 移除 kill switch(可选,B5 通过后)**

确认 dogfood + 全量回归通过后,可单独 PR 删 `CPB_PROVIDER_REGISTRY=0` 回退路径与旧 `inheritCodexConfig`/`inheritClaudeConfig`(保留至本步通过是 §7 回滚策略的要求)。

- [ ] **Step 5: Commit**

```bash
git add core/agents/descriptors/gemini.json tests/gemini-dogfood.test.ts
git commit -m "test(agents): gemini dogfood — third-family onboarding with zero source changes"
```

---

## Self-Review

**1. RFC §6 覆盖**:B1 字段+迁移表 ✓、B2 §6.3 全 14 处特判(分 B2a 路由 / B2b 隔离 / B2c policy-retry-handoff)✓、B3 mutation API+CLI ✓、B4 catalog 对齐(不合并)✓、B5 gemini dogfood ✓。
**2. 安全约束**:B2b 的 `inheritFilesIntoHome` 实现完整的 §6.2 安全块;B3 的 `registerDescriptor` 对 untrusted 强制同套校验 + fail-closed 测试。
**3. 解冻门禁**:Global Constraints + 文档头明示 B2 起需 sign-off;每任务 `verify:release-gate`。
**4. kill switch / 回滚**:每个 B2 任务保留 `CPB_PROVIDER_REGISTRY=0` 回退;旧 helper 保留至 B5。
**5. 无占位符**:测试代码、descriptor JSON、edit 方向均完整;B2c 第 3 步 grep 命令可直接跑;B5 的 `defaultAgentForRole` 断言视 fixture 留了明确条件(非占位,因 executor 默认在 claude/gemini 间取决于谁 priority 低,测试时按实际 fixture 定)。

## Execution Handoff

子计划已保存。两种执行方式:Subagent-Driven(推荐)/ Inline Execution。**执行前须解冻 sign-off**(Phase B 触冻结红线)。至此 RFC §8 的 5 份子计划(A1+A2 / A3 / A4 / A5 / B)全部齐备。
