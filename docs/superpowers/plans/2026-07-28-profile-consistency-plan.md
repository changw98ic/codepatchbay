# Profile 一致性子计划(A5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清理 5 个 role profile 的内部不一致(语言、疑似 vestigial 字段、skills 重复、无 schema),且**不改运行时权限语义**——对 `deny_tools` 这类被 `permission-matrix` 强制执行的字段,改动必须 audit-first + 测试 gated。

**Architecture:** 核实发现(纠正父 RFC A5 的"补齐 deny_tools"预设):`profiles/*/config.json` **被运行时消费**——`loadProfile`(`prompt-resources.ts:254`)只取 `permissions.{write_paths,deny_tools,deny_commands}` 并喂 soul.md 作系统提示;`permission-matrix.ts:570-580` 强制执行 deny_tools/deny_commands,且 `write_paths:["**/*"]` 被过滤除非 `CPB_DANGEROUS=1`。故:(a)`agent`/`acp` 块疑似 vestigial(无消费点);(b)`deny_tools` 不能盲目"补齐"——executor/remediator 必须能写代码,只有 read-only 角色才适合 deny 变更工具。本计划 audit-first、保守。

**Tech Stack:** TypeScript(strict, ESM);Node 内置 test runner;profile = `soul.md` + `config.json` + `skills/*.md`(纯文本/JSON,无编译)。

**父 RFC:** `docs/superpowers/plans/2026-07-28-cpb-agent-platform-maturity-rfc.md` §5 A5(注:父 RFC"补齐 deny_tools"与"config.command 引用 descriptor"两条据实修正——见本计划 Task 1/2/4)。

## Global Constraints

- **权限零回归**:任何 `deny_tools`/`write_paths`/`deny_commands` 改动须先确认 `permission-matrix.ts:570-580` 的执行语义,并补测试。executor/remediator 不得新增 deny 变更工具。
- **soul.md 是系统提示**:其改动直接影响 agent 行为;英化 reviewer 仅改语言不改语义。
- **分层不变量**:profile 加载在 `server/services/prompt/`,permission 执行在 `server/services/permission-matrix.ts`。
- **测试编译**:`npm run build:tests` 后跑。

## File Structure

- **Audit(只读)** `server/services/prompt/prompt-resources.ts`(:254 `loadProfile`)、`server/services/permission-matrix.ts`(:570-580)。
- **Modify** `profiles/{planner,executor,verifier,reviewer,remediator}/config.json`——清 vestigial 字段。
- **Modify** `profiles/reviewer/soul.md`——英化。
- **Modify** `profiles/{planner,reviewer}/config.json`——(audit 后,仅 read-only 角色)对齐 deny_tools。
- **Create** `schemas/agent-profile.schema.json` + 在 `loadProfile` 加可选校验。
- **Create** `tests/profile-config.test.ts`——profile 一致性 + schema 校验测试。

---

### Task 1: audit——确认 config.json 哪些字段被消费、deny_tools 词汇表

**Files:**
- Audit(只读):`server/services/prompt/prompt-resources.ts`、`server/services/permission-matrix.ts`

- [ ] **Step 1: 跑审计 grep**

```bash
# 1) config.json 的 agent/acp 块有没有被消费
grep -rnE "profileConfig\.agent|profile\.config\.agent|\.acp\.profile|config\.acp" server/ core/ | grep -v test
# 2) deny_tools 的词汇表与执行点
grep -rnE "denyTools|deny_tools" server/services/permission-matrix.ts
# 3) loadProfile 实际从 config.json 取了哪些字段
sed -n '254,300p' server/services/prompt/prompt-resources.ts
```

- [ ] **Step 2: 记录结论(写入本 Task 末尾,供后续 Task 引用)**

预期结论(须由 Step 1 输出确认):
- `loadProfile` 仅消费 `permissions.{write_paths,deny_tools,deny_commands}` + `soul.md`;`agent{command,args}` 与 `acp{profile}` **无消费点 → vestigial**。
- `deny_tools` 经 `permission-matrix.ts:570` 进 `merged.denyTools`;其匹配的目标工具名词汇表 = `<Step 1 第 2 条输出>`,作为后续对齐的基准。

(若审计发现 `agent`/`acp` 块其实被某处消费,Task 2 改为"保留并文档化其来源",不删。)

---

### Task 2: 清除 config.json 的 vestigial `agent`/`acp` 块(以 Task 1 审计为前置)

**Files:**
- Modify: `profiles/{planner,executor,verifier,reviewer,remediator}/config.json`

**Interfaces:**
- Consumes: Task 1 结论(确认 `agent`/`acp` 块无消费点)。

- [ ] **Step 1: 先加守护测试(锁住 loadProfile 只读 permissions)**

`tests/profile-config.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

test("every role config.json has the consumed permissions block", async () => {
  const root = path.resolve(import.meta.dirname, "..", "profiles");
  for (const role of ["planner", "executor", "verifier", "reviewer", "remediator"]) {
    const raw = JSON.parse(await readFile(path.join(root, role, "config.json"), "utf8"));
    assert.ok(raw.permissions, `${role} missing permissions`);
    assert.ok(Array.isArray(raw.permissions.write_paths), `${role} write_paths`);
    assert.ok(Array.isArray(raw.permissions.deny_tools), `${role} deny_tools`);
  }
});
```

- [ ] **Step 2: 跑确认通过(现状即满足)**

Run: `npm run build:tests && node dist-tests/scripts/run-node-tests.js tests/profile-config.test.ts`
Expected: PASS(证明 permissions 块在各 role 都在)。

- [ ] **Step 3: 删除每个 config.json 的 `agent`/`acp` 块(仅当 Task 1 确认 vestigial)**

例(planner/config.json 改后形如):
```json
{
  "permissions": {
    "write_paths": ["wiki/projects/*/inbox/*"],
    "deny_tools": [],
    "deny_commands": false
  }
}
```
5 个文件同样去掉 `agent`/`acp` 顶层键。`deny_tools` 的具体值由 Task 4 决定,本 Task 保持现状。

- [ ] **Step 4: 回归 profile 加载 + engine 严格门禁**

Run: `npm run build:tests && npm run typecheck:strict:engine && node dist-tests/scripts/run-node-tests.js --unit`
Expected: 全绿(loadProfile 不读 agent/acp,删除无影响)。

- [ ] **Step 5: Commit**

```bash
git add profiles/*/config.json tests/profile-config.test.ts
git commit -m "chore(profiles): drop vestigial agent/acp blocks from role configs"
```

---

### Task 3: reviewer/soul.md 英化(不改语义)

**Files:**
- Modify: `profiles/reviewer/soul.md`

- [ ] **Step 1: 英化**

把 `profiles/reviewer/soul.md` 的中文翻译为英文,与另外四个 role 一致。**保留全部结构与语义**:Identity / Responsibilities(4 条:code quality / architecture consistency / issue identification / improvement suggestions)/ Constraints(3 条:no code / no self-review / no skipping)/ Verdict 分级(Critical/Major/Minor/Suggestion)/ 输出结构(`## Verdict / Summary / Blocking Findings / Non-Blocking Findings`)。

- [ ] **Step 2: 校验结构未变**

Run: `grep -nE "^#|Verdict|Blocking|Critical|Major|Minor" profiles/reviewer/soul.md`
Expected: 上述小节标题与分级词仍在。

- [ ] **Step 3: Commit**

```bash
git add profiles/reviewer/soul.md
git commit -m "docs(profiles): English reviewer soul.md for cross-role consistency"
```

---

### Task 4: 对齐 read-only 角色的 deny_tools(以 Task 1 词汇表为准;gated)

**Files:**
- Modify: `profiles/planner/config.json`、`profiles/reviewer/config.json`(两个 read-only 角色)
- Test: `tests/profile-config.test.ts`(追加)

**Interfaces:**
- Consumes: Task 1 的 deny_tools 词汇表 + 执行点。
- 约束:**executor/remediator 不动**(它们必须写代码);verifier 已有 deny_tools,保持。

- [ ] **Step 1: 据 Task 1 词汇表,给 planner/reviewer 配 deny_tools**

若 Task 1 确认词汇表为变更类工具名(如 `text_edit`/`text-edit` 或与 verifier 一致的集合),则给 planner、reviewer 的 `deny_tools` 填**与 verifier 同集合**(read-only 角色统一拒绝变更工具)。例:
```json
"deny_tools": ["text_edit", "text-edit"]
```
若审计显示词汇表与 verifier 现值不一致,先统一 verifier 到正确词汇表,再同步 planner/reviewer。

- [ ] **Step 2: 追加测试(锁住 read-only 角色的 deny_tools 非空)**

```ts
test("read-only roles (planner, verifier, reviewer) deny mutating tools; executor/remediator do not", async () => {
  const root = path.resolve(import.meta.dirname, "..", "profiles");
  const read = async (role: string) => JSON.parse(await readFile(path.join(root, role, "config.json"), "utf8"));
  for (const role of ["planner", "verifier", "reviewer"]) {
    const cfg = await read(role);
    assert.ok(cfg.permissions.deny_tools.length > 0, `${role} should deny mutating tools`);
  }
  for (const role of ["executor", "remediator"]) {
    const cfg = await read(role);
    assert.equal(cfg.permissions.deny_tools.length, 0, `${role} must keep write capability`);
  }
});
```

- [ ] **Step 3: 编译 + 跑 + permission-matrix 回归**

Run: `npm run build:tests && node dist-tests/scripts/run-node-tests.js tests/profile-config.test.ts && node dist-tests/scripts/run-node-tests.js --unit`
Expected: 新用例 PASS;既有 permission-matrix 相关测试全绿。

- [ ] **Step 4: Commit**

```bash
git add profiles/planner/config.json profiles/reviewer/config.json tests/profile-config.test.ts
git commit -m "feat(profiles): align read-only role deny_tools with phase contract"
```

---

### Task 5: executor/remediator skills 重复——文档化为有意(不强制去重)

**Files:**
- Modify: `docs/agent-developer-guide.md`(角色期望节加一句)

- [ ] **Step 1: 核实仍是相同集合**

Run: `diff profiles/executor/skills profiles/remediator/skills`
Expected: 无差异(两者都含 debug/lint/review-feedback/tdd/test)。

- [ ] **Step 2: 文档化为有意(每个 role 独立副本以保持独立性,不共享/symlink)**

在 `docs/agent-developer-guide.md` 角色期望节注明:"executor 与 remediator 共用同一组 remediation skills(debug/lint/review-feedback/tdd/test),各自保留独立副本以维持 role 隔离,不共享目录。" —— 不做物理去重(去重会引入耦合,违背 role 独立性)。

- [ ] **Step 3: Commit**

```bash
git add docs/agent-developer-guide.md
git commit -m "docs(profiles): note executor/remediator skill copies are intentionally independent"
```

---

### Task 6: profile JSON Schema + loadProfile 可选校验

**Files:**
- Create: `schemas/agent-profile.schema.json`
- Modify: `server/services/prompt/prompt-resources.ts`(`loadProfile`,可选校验,失败仅 warning 不 fail)

- [ ] **Step 1: 写 schema**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://codepatchbay/schemas/agent-profile.schema.json",
  "title": "CPB Role Profile config.json",
  "type": "object",
  "required": ["permissions"],
  "additionalProperties": false,
  "properties": {
    "permissions": {
      "type": "object",
      "required": ["write_paths", "deny_tools", "deny_commands"],
      "properties": {
        "write_paths": { "type": "array", "items": { "type": "string" } },
        "deny_tools": { "type": "array", "items": { "type": "string" } },
        "deny_commands": { "type": "boolean" }
      }
    }
  }
}
```
> `additionalProperties:false` 与 Task 2(删 vestigial 块)一致;若 Task 1 审计发现还需保留字段,放宽此处。

- [ ] **Step 2: 追加 schema 校验测试**

```ts
test("every role config.json conforms to the profile schema shape", async () => {
  const root = path.resolve(import.meta.dirname, "..", "profiles");
  for (const role of ["planner", "executor", "verifier", "reviewer", "remediator"]) {
    const cfg = JSON.parse(await readFile(path.join(root, role, "config.json"), "utf8"));
    assert.ok(cfg.permissions && Array.isArray(cfg.permissions.write_paths), `${role}`);
    assert.equal(typeof cfg.permissions.deny_commands, "boolean", `${role} deny_commands boolean`);
    // additionalProperties: 拒绝 vestigial agent/acp 块
    for (const banned of ["agent", "acp"]) {
      assert.equal(cfg[banned], undefined, `${role} still carries vestigial '${banned}'`);
    }
  }
});
```

- [ ] **Step 3: 编译 + 跑**

Run: `npm run build:tests && node dist-tests/scripts/run-node-tests.js tests/profile-config.test.ts`
Expected: 全部 PASS。

- [ ] **Step 4: Commit**

```bash
git add schemas/agent-profile.schema.json tests/profile-config.test.ts
git commit -m "feat(profiles): add profile config schema + shape guard test"
```

---

## Self-Review

**1. RFC §5 A5 覆盖**:reviewer 英化 ✓(Task 3)、skills 去重(改为文档化有意)✓(Task 5)、deny_tools ✓(Task 4,据实改为"仅 read-only 角色对齐")、profiles schema ✓(Task 6)、config.command(改为删 vestigial)✓(Task 2)。
**2. 据实修正父 RFC**:父 RFC 说"补齐 deny_tools""config.command 引用 descriptor";核实发现 config.json 仅 permissions 被消费、deny_tools 是运行时权限 → 改为 audit-first + 仅 read-only 对齐 + 删 vestigial。**修复 Pass 须回填父 RFC §5 A5。**
**3. 权限零回归**:Task 4 显式不动 executor/remediator;Task 2 删字段以 loadProfile 守护测试 + unit 回归为前置。
**4. 无占位符**:测试代码、JSON、命令均为完整内容;Task 1 audit 与 Task 4 词汇表依赖以"Step 1 grep 输出确认"为 gate,非内容占位。

## Execution Handoff

子计划已保存。Subagent-Driven(推荐)/ Inline Execution。Phase A、冻结期安全(权限改动 gated + 测试守护)。
