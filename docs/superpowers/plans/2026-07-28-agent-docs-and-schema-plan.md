# Agent 文档与 I/O 契约子计划(A1+A2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 agent I/O 契约从"读源码才知道"升级为"有版本协商 + JSON Schema + 单一权威指南":(A2)给 envelope 加向后兼容的 `schemaVersion` 协商 + 每 shipped agent 的 golden round-trip 测试;(A1)发布 descriptor / envelope 两份 JSON Schema + 写 `docs/agent-developer-guide.md`。

**Architecture:** A2 改动极小——只在 `parseAgentJson` 的公共解析路径加"缺省=legacy 照常接受、存在=校验范围"的版本协商,不破坏任何存量输出。A1 是纯文档+schema 产物。零行为回归风险,冻结期安全。

**Tech Stack:** TypeScript(strict, ESM)→ `dist/`;Node 内置 test runner;JSON Schema draft 2020-12(无运行时依赖,仅 schema 文件 + 文档)。

**父 RFC:** `docs/superpowers/plans/2026-07-28-cpb-agent-platform-maturity-rfc.md` §5 A1+A2。

## Global Constraints

- **向后兼容**:任何 envelope 改动不得拒绝当前 codex/claude/fake-acp/fixture 的 `{status:"ok",...}` 无版本输出。
- **分层不变量**:`core/agents/response-parser.ts` 属 `core/`,禁 import `server/`。
- **编译先行**:改 `.ts` 后 `npm run build:tests` 再跑测试。
- **import 路径**:测试用相对 `.js` import 编译产物。
- **Schema 无依赖**:JSON Schema 文件不引入校验库(仅作文档契约 + 未来可选 ajv 校验)。

## File Structure

- **Modify** `core/agents/response-parser.ts`——`tryParseJsonObjectWithStatuses` 加 `schemaVersion` 协商。
- **Create** `tests/agent-envelope-version.test.ts`——版本协商单测。
- **Create** `tests/agent-envelope-golden.test.ts`——每 shipped agent 代表性输出的 round-trip。
- **Create** `schemas/agent-descriptor.schema.json`——descriptor 形式化契约。
- **Create** `schemas/cpb-envelope.schema.json`——envelope 形式化契约。
- **Create** `docs/agent-developer-guide.md`——单一权威接入指南。

---

### Task 1: envelope schemaVersion 版本协商(TDD)

**Files:**
- Modify: `core/agents/response-parser.ts`(在 `tryParseJsonObjectWithStatuses` 内,`status` 校验通过之后、`return {ok:true}` 之前)
- Test: `tests/agent-envelope-version.test.ts`

**Interfaces:**
- Consumes:`parseAgentJson(output)`(已 export,:1)。
- Produces:envelope 可选 `schemaVersion`;缺省=legacy 接受;存在且不在支持集=结构化失败。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAgentJson } from "../core/agents/response-parser.js";

test("legacy envelope without schemaVersion is accepted", () => {
  const r = parseAgentJson('```json\n{"status":"ok","planMarkdown":"# x"}\n```');
  assert.equal(r.ok, true);
});

test("envelope with supported schemaVersion=1 is accepted", () => {
  const r = parseAgentJson('{"status":"ok","schemaVersion":1,"planMarkdown":"# x"}');
  assert.equal(r.ok, true);
});

test("envelope with unsupported schemaVersion is rejected with structured reason", () => {
  const r = parseAgentJson('{"status":"ok","schemaVersion":99,"planMarkdown":"# x"}');
  assert.equal(r.ok, false);
  assert.match(r.reason, /unsupported envelope schemaVersion/i);
});

test("schemaVersion 0 (explicit legacy) is treated as unsupported sentinel", () => {
  // 显式 0 不在支持集 → 拒绝;legacy 必须以"缺省"表达,而非 0。
  const r = parseAgentJson('{"status":"ok","schemaVersion":0}');
  assert.equal(r.ok, false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build:tests && node dist-tests/scripts/run-node-tests.js tests/agent-envelope-version.test.ts`
Expected: 第 3、4 个用例 FAIL(当前无版本校验,`schemaVersion:99` 被接受)。

- [ ] **Step 3: 最小实现**

在 `core/agents/response-parser.ts` 顶部常量区加:

```ts
const SUPPORTED_ENVELOPE_VERSIONS = new Set([1]);
```

在 `tryParseJsonObjectWithStatuses` 中,`status` 校验通过之后、`return { ok: true, data: parsed }` 之前插入:

```ts
  if (parsed.schemaVersion !== undefined && !SUPPORTED_ENVELOPE_VERSIONS.has(parsed.schemaVersion)) {
    return {
      ok: false,
      reason: `unsupported envelope schemaVersion: ${String(parsed.schemaVersion)} (supported: ${[...SUPPORTED_ENVELOPE_VERSIONS].join(", ")})`,
    };
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run build:tests && node dist-tests/scripts/run-node-tests.js tests/agent-envelope-version.test.ts`
Expected: 4 用例 PASS。

- [ ] **Step 5: 回归既有 response-parser 测试**

Run: `node dist-tests/scripts/run-node-tests.js --unit`
Expected: 全绿(证明 legacy 输出零回归)。

- [ ] **Step 6: Commit**

```bash
git add core/agents/response-parser.ts tests/agent-envelope-version.test.ts
git commit -m "feat(agents): negotiate envelope schemaVersion (legacy-compatible)"
```

---

### Task 2: 每 shipped agent 的 golden round-trip 契约测试

**Files:**
- Create: `tests/agent-envelope-golden.test.ts`
- Test target: `parsePlannerJson` / `parseExecutorJson`(`response-parser.ts:110`/:119)

**Interfaces:**
- Consumes:`parsePlannerJson(output)` → `{ok, planMarkdown}`;`parseExecutorJson(output)` → executor 字段。

- [ ] **Step 1: 写测试(每 agent 一个代表性 envelope)**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlannerJson, parseExecutorJson } from "../core/agents/response-parser.js";

// 代表性 envelope:文档化每个角色的最小合法输出形态,而非抓取真实 provider 输出。
const fenced = (obj: unknown) => "```json\n" + JSON.stringify(obj) + "\n```";

test("planner envelope (codex-style, legacy) → planMarkdown", () => {
  const r = parsePlannerJson(fenced({ status: "ok", planMarkdown: "# Plan\n\n## Steps\n- do x" }));
  assert.equal(r.ok, true);
  assert.equal(r.planMarkdown, "# Plan\n\n## Steps\n- do x");
});

test("planner envelope with schemaVersion=1 still round-trips", () => {
  const r = parsePlannerJson(fenced({ status: "ok", schemaVersion: 1, planMarkdown: "# v1 plan" }));
  assert.equal(r.ok, true);
  assert.equal(r.planMarkdown, "# v1 plan");
});

test("planner envelope missing planMarkdown → structured failure", () => {
  const r = parsePlannerJson(fenced({ status: "ok" }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /planMarkdown/i);
});

test("executor envelope (claude-style, legacy) parses", () => {
  const r = parseExecutorJson(fenced({ status: "ok", summary: "done", deliverablePath: "outputs/d-1.md" }));
  assert.equal(r.ok, true);
});

test("agent non-success status surfaces reason", () => {
  const r = parsePlannerJson(fenced({ status: "error", reason: "context window exceeded" }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /context window exceeded/);
});
```

> 注:若 `parseExecutorJson` 要求额外必填字段(核对 `response-parser.ts:119-` 的实现),按真实字段名调整第 4 个用例的 envelope,再跑。

- [ ] **Step 2: 编译 + 跑**

Run: `npm run build:tests && node dist-tests/scripts/run-node-tests.js tests/agent-envelope-golden.test.ts`
Expected: 5 用例 PASS。

- [ ] **Step 3: Commit**

```bash
git add tests/agent-envelope-golden.test.ts
git commit -m "test(agents): golden round-trip per role envelope shape"
```

---

### Task 3: 发布 descriptor JSON Schema

**Files:**
- Create: `schemas/agent-descriptor.schema.json`

- [ ] **Step 1: 写 schema(覆盖现有 6 个 descriptor 的全部字段)**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://codepatchbay/schemas/agent-descriptor.schema.json",
  "title": "CPB Agent Descriptor",
  "type": "object",
  "required": ["name", "command", "envPrefix"],
  "additionalProperties": true,
  "properties": {
    "name": { "type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]*$" },
    "displayName": { "type": "string" },
    "command": { "type": "string", "minLength": 1 },
    "args": { "type": "array", "items": { "type": "string" } },
    "fallbackCommand": { "type": "string" },
    "fallbackArgs": { "type": "array", "items": { "type": "string" } },
    "envPrefix": { "type": "string", "pattern": "^CPB_ACP_[A-Z0-9]+(?:_[A-Z0-9]+)*$" },
    "protocol": { "type": "string", "enum": ["acp", "claude-cli", "unknown"] },
    "transport": { "type": "string" },
    "lifecycle": { "type": "string", "enum": ["one-shot", "cached"] },
    "stability": { "type": "string", "enum": ["stable", "experimental", "test", "discovered"] },
    "capabilities": { "type": "array", "items": { "type": "string" } },
    "defaultRoles": {
      "type": "array",
      "items": { "type": "string", "enum": ["planner", "executor", "verifier", "reviewer", "remediator"] }
    },
    "poolLimit": { "type": "integer", "minimum": 0 },
    "providerKey": { "type": "string" },
    "providerVariant": { "type": "string" },
    "sessionMcpServers": { "type": "boolean" },
    "resumeCommand": { "type": "string" },
    "resumeArgs": { "type": "array", "items": { "type": "string" } },
    "description": { "type": "string" }
  }
}
```

- [ ] **Step 2: 人工校验 6 个 shipped descriptor 各自合规**

Run: `for f in core/agents/descriptors/*.json; do echo "## $f"; cat "$f"; done`
Expected: codex/claude/claude-glm/claude-mimo/browser-agent/fake-acp 均含 required 三字段,字段名与 schema 一致(目检;未来可加 ajv 校验脚本)。

- [ ] **Step 3: Commit**

```bash
git add schemas/agent-descriptor.schema.json
git commit -m "docs(schemas): publish agent descriptor JSON Schema"
```

---

### Task 4: 发布 envelope JSON Schema

**Files:**
- Create: `schemas/cpb-envelope.schema.json`

- [ ] **Step 1: 写 schema**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://codepatchbay/schemas/cpb-envelope.schema.json",
  "title": "CPB Agent Output Envelope",
  "description": "Agent 在输出中吐出的 fenced JSON envelope。schemaVersion 缺省=legacy v0(照常接受)。",
  "type": "object",
  "required": ["status"],
  "properties": {
    "status": { "type": "string", "enum": ["ok", "error", "fail", "partial"] },
    "schemaVersion": { "type": "integer", "enum": [1] },
    "reason": { "type": "string" },
    "error": { "type": "string" },
    "planMarkdown": { "type": "string", "description": "planner 必填" },
    "summary": { "type": "string" },
    "deliverablePath": { "type": "string" },
    "checklistVerdict": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["itemId", "status"],
        "properties": {
          "itemId": { "type": "string" },
          "status": { "type": "string", "enum": ["pass", "fail", "partial"] },
          "reason": { "type": "string" }
        }
      }
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add schemas/cpb-envelope.schema.json
git commit -m "docs(schemas): publish agent output envelope JSON Schema"
```

---

### Task 5: agent-developer-guide.md(单一权威接入指南)

**Files:**
- Create: `docs/agent-developer-guide.md`

- [ ] **Step 1: 写指南(按下列大纲填充真实技术内容,不写占位 prose)**

大纲与每节必含事实:

1. **接入概览**:CPB 是 ACP 交付运行时;接入 = 写 descriptor(+ 可选 profile)。引用 `docs/acp-provider-validation.md` 的 `fake-acp` 作为参考实现。
2. **Descriptor schema**:逐字段说明(引用 `schemas/agent-descriptor.schema.json`),重点讲 `defaultRoles`/`capabilities`/`protocol`/`lifecycle`/`envPrefix`;给一个最小可工作 descriptor 示例(照抄 `core/agents/descriptors/fake-acp.json` 改名)。
3. **I/O 契约**:agent 必须在输出中吐 **fenced JSON envelope**(引用 `schemas/cpb-envelope.schema.json`);`status:"ok"` 必填;`schemaVersion` 可选(缺省=legacy);planner 须 `planMarkdown`,verifier 须 `checklistVerdict`;verdict 机器解析行 `VERDICT: PASS|FAIL|PARTIAL`。
4. **角色期望**:5 角色一句话 + 写入边界(planner 只读 inbox/plan-*;executor 改项目代码 + outputs/deliverable-*;verifier 只写 outputs/verdict-* 并强制 `node --check`+`npm test`)。指向 `profiles/<role>/soul.md` 为权威。
5. **Sandbox 与隔离模型**:per-agent per-job HOME;只继承 auth/credential(`auth.json`/`.credentials.json`),`config.toml` 被 quarantine;read-only phase 写越权→`READ_ONLY_MUTATION_DENIED`(引用 `core/agents/agent-runner.ts`)。
6. **如何用 fake-acp 测**:`CPB_ACP_FAKE_ACP_COMMAND`/`_ARGS` + scenario file(照搬 `docs/acp-provider-validation.md` 的例子)。
7. **如何发布**:放 `core/agents/descriptors/`(builtin)或设 `CPB_AGENTS_CONFIG_DIR`;`cpb pipeline ... --<role>-agent <name>` 指派;`cpb agents detect/test` 探测。
8. **冻结边界**:当前稳定化周期不新增 agent 类型;Phase B Provider Registry 落地后,接入第三类 agent 无需改源码(指向父 RFC §6)。

- [ ] **Step 2: 校验内部链接**

Run: `grep -nE "docs/|core/|schemas/|profiles/" docs/agent-developer-guide.md`
Expected: 引用的文件路径均存在(`docs/acp-provider-validation.md`、`schemas/*.json`、`core/agents/descriptors/fake-acp.json`、`profiles/*/soul.md`)。

- [ ] **Step 3: Commit**

```bash
git add docs/agent-developer-guide.md
git commit -m "docs(agents): add single-source agent developer guide"
```

---

## Self-Review

**1. RFC §5 A1+A2 覆盖**:schemaVersion 协商 ✓(Task 1)、golden 测试 ✓(Task 2)、descriptor schema ✓(Task 3)、envelope schema ✓(Task 4)、接入指南 ✓(Task 5)。
**2. 向后兼容**:Task 1 显式测了 legacy 无版本仍接受 + 不支持版本才拒;Task 5 回归 `--unit`。
**3. 无占位符**:parser 改动、测试代码、两份 schema 均为可直接 apply 的完整内容;Task 5 大纲每节列出必含真实事实(非 prose 占位)。
**4. 类型一致**:`SUPPORTED_ENVELOPE_VERSIONS`、`parseAgentJson`/`parsePlannerJson`/`parseExecutorJson` 跨 Task 引用一致。

## Execution Handoff

子计划已保存。两种执行方式:Subagent-Driven(推荐)/ Inline Execution。本计划属 Phase A、冻结期安全。
