# Agent 可观测性子计划(A4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 agent 可观测性的**唯一真实缺口**——把已实现但未暴露的 routing/usage metrics 通过 `cpb agents stats` 暴露出来;并核验 trace 人类摘要,必要时加一行 routing 结论。零生产行为改动,冻结期安全。

**Architecture:** 核实发现(纠正父 RFC 低估):`cpb jobs trace [--replay]` **已**richly surface routing decision(`trace-log.ts:229-246` 把 `agent_routing_decision` 转成 span 属性:selected_agent / selection_source / outcome_applied / independence_applied / excluded_provider_family / thresholds / candidates);`readAgentRoutingMetrics`(`provider-usage.ts:1081`)+ `readProviderUsageRollup`(`:952`)**已**算 per-agent successes/retries,但仅被 engine 内部消费(`engine-runner.ts:117`),**cli/ 零引用**。故本计划 = 加 stats CLI + 核验 trace 摘要 + 文档。

**Tech Stack:** TypeScript(strict, ESM)→ `dist/`;Node 内置 test runner;纯函数 formatter 可单测。

**父 RFC:** `docs/superpowers/plans/2026-07-28-cpb-agent-platform-maturity-rfc.md` §5 A4(注:父 RFC 低估了现状,本计划据实收敛;修复 Pass 会回填 RFC §3/§5 A4 评分)。

## Global Constraints

- **不重造轮子**:trace / replay / metric 计算均已存在,只做"暴露"与"核验",不改其内部。
- **分层不变量**:formatter 放 `server/services/`(可读 `core/`),CLI 放 `cli/commands/`。
- **编译先行**:`npm run build:tests` 后跑测试。
- **import 路径**:相对 `.js` import 编译产物。

## File Structure

- **Create** `server/services/trace/agent-stats-format.ts`——纯函数 `formatAgentStatsHuman` + `summarizeAgentStats`(可单测)。
- **Create** `tests/agent-stats-format.test.ts`——formatter 单测。
- **Modify** `cli/commands/agents.ts`——加 `cpb agents stats [--json]` 子命令,调 `readAgentRoutingMetrics` + `readProviderUsageRollup`。
- **Modify** `docs/agent-developer-guide.md`——加"可观测性"节(Task 5 of A1+A2 指南的补充,或本计划独立小节)。

---

### Task 1: agent stats formatter(TDD)

**Files:**
- Create: `server/services/trace/agent-stats-format.ts`
- Test: `tests/agent-stats-format.test.ts`

**Interfaces:**
- Consumes:`readAgentRoutingMetrics(hubRoot, query)` 返回条目数组(每条含 `agent`/`role?`/`successes`/`retries`/`total?` 等,见 `provider-usage.ts:1081-1151`);`readProviderUsageRollup(hubRoot)` 返回 `Record<string, ProviderRollup>`(`:952`)。
- Produces:`summarizeAgentStats({ routingMetrics, usageRollup })` → 结构化摘要;`formatAgentStatsHuman(summary)` → 多行字符串。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeAgentStats, formatAgentStatsHuman } from "../server/services/trace/agent-stats-format.js";

test("summarizeAgentStats rolls up per-agent success rate from routing metrics", () => {
  const routingMetrics = [
    { agent: "codex", role: "verifier", successes: 18, retries: 2 },
    { agent: "codex", role: "planner", successes: 9, retries: 1 },
    { agent: "claude", role: "executor", successes: 7, retries: 3 },
  ];
  const summary = summarizeAgentStats({ routingMetrics, usageRollup: {} });
  // 按 agent 聚合:codex 27 成功/3 重试;claude 7/3
  const codex = summary.agents.find((a) => a.agent === "codex");
  assert.equal(codex.successes, 27);
  assert.equal(codex.retries, 3);
  const claude = summary.agents.find((a) => a.agent === "claude");
  assert.equal(claude.successes, 7);
});

test("formatAgentStatsHuman emits one line per agent with success rate", () => {
  const summary = summarizeAgentStats({
    routingMetrics: [{ agent: "codex", successes: 9, retries: 1 }],
    usageRollup: {},
  });
  const text = formatAgentStatsHuman(summary);
  assert.match(text, /codex/);
  assert.match(text, /9/); // successes 出现
});

test("empty metrics → empty summary, no throw", () => {
  const summary = summarizeAgentStats({ routingMetrics: [], usageRollup: {} });
  assert.deepEqual(summary.agents, []);
  assert.equal(formatAgentStatsHuman(summary).trim(), "");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build:tests && node dist-tests/scripts/run-node-tests.js tests/agent-stats-format.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现 formatter(纯函数,防御式)**

```ts
import { recordValue, type LooseRecord } from "../../../core/contracts/types.js";

export type AgentStatRow = { agent: string; successes: number; retries: number; byRole?: LooseRecord };
export type AgentStatsSummary = { agents: AgentStatRow[]; usageRollup: LooseRecord };

function finiteNumber(value: unknown): number {
  return Number.isFinite(value as number) ? (value as number) : 0;
}

export function summarizeAgentStats({ routingMetrics, usageRollup }: {
  routingMetrics: unknown[];
  usageRollup: LooseRecord;
}): AgentStatsSummary {
  const byAgent = new Map<string, AgentStatRow>();
  for (const entry of Array.isArray(routingMetrics) ? routingMetrics : []) {
    const r = recordValue(entry);
    const agent = String(r.agent ?? r.providerKey ?? "unknown");
    const row = byAgent.get(agent) ?? { agent, successes: 0, retries: 0, byRole: {} };
    row.successes += finiteNumber(r.successes);
    row.retries += finiteNumber(r.retries);
    if (r.role) {
      const roleKey = String(r.role);
      const roleRow = (row.byRole![roleKey] ??= { successes: 0, retries: 0 });
      roleRow.successes += finiteNumber(r.successes);
      roleRow.retries += finiteNumber(r.retries);
    }
    byAgent.set(agent, row);
  }
  return { agents: [...byAgent.values()], usageRollup };
}

export function formatAgentStatsHuman(summary: AgentStatsSummary): string {
  if (!summary.agents.length) return "";
  return summary.agents
    .map((row) => {
      const total = row.successes + row.retries;
      const rate = total > 0 ? `${Math.round((row.successes / total) * 100)}%` : "n/a";
      return `${row.agent}\tsuccesses=${row.successes}\tretries=${row.retries}\tsuccess_rate=${rate}`;
    })
    .join("\n") + "\n";
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run build:tests && node dist-tests/scripts/run-node-tests.js tests/agent-stats-format.test.ts`
Expected: 3 用例 PASS。

- [ ] **Step 5: Commit**

```bash
git add server/services/trace/agent-stats-format.ts tests/agent-stats-format.test.ts
git commit -m "feat(trace): add agent stats summarizer/formatter for routing metrics"
```

---

### Task 2: `cpb agents stats [--json]` CLI 子命令

**Files:**
- Modify: `cli/commands/agents.ts`(在现有 `list|detect|install|upgrade|test` 旁加 `stats`)

**Interfaces:**
- Consumes:`readAgentRoutingMetrics(hubRoot, query?)` 与 `readProviderUsageRollup(hubRoot)`(from `server/services/provider-usage.js`);`summarizeAgentStats` / `formatAgentStatsHuman`(Task 1)。
- Produces:`cpb agents stats [--json]` 人类/JSON 输出。

- [ ] **Step 1: 加 stats 分支**

在 `cli/commands/agents.ts` 的子命令派发处(参照现有 `list`/`detect` 结构),加:

```ts
  } else if (sub === "stats") {
    const { resolveHubRoot } = await import("../../core/paths.js");
    const { readAgentRoutingMetrics, readProviderUsageRollup } = await import("../../server/services/provider-usage.js");
    const { summarizeAgentStats, formatAgentStatsHuman } = await import("../../server/services/trace/agent-stats-format.js");
    const hubRoot = resolveHubRoot(); // 与其它命令一致的 hub root 解析;若该助手名不同,核对 cli/commands/agents.ts 顶部既有 import
    const routingMetrics = await readAgentRoutingMetrics(hubRoot, {});
    const usageRollup = await readProviderUsageRollup(hubRoot);
    const summary = summarizeAgentStats({ routingMetrics, usageRollup });
    if (args.includes("--json")) console.log(JSON.stringify(summary, null, 2));
    else process.stdout.write(formatAgentStatsHuman(summary));
    return;
```

> 注:`resolveHubRoot` 的真实助手名/来源以 `cli/commands/agents.ts` 既有 import 为准(该文件已解析 hub root 跑 `listSetupAgents`);复用同一解析路径,勿新造。

- [ ] **Step 2: 更新 usage 文本**

在 `agents.ts` 的 `usage()` 里把 `stats` 加入合法子命令列表与帮助行。

- [ ] **Step 3: 构建并冒烟**

Run: `npm run build && node dist/cli/cpb.js agents stats --json | head -20`
Expected: 输出 JSON(空 hub 时 `{"agents":[],"usageRollup":{}}`);非空 hub 时含 per-agent successes/retries。

- [ ] **Step 4: Commit**

```bash
git add cli/commands/agents.ts
git commit -m "feat(cli): add 'cpb agents stats' to surface routing/usage metrics"
```

---

### Task 3: 核验 trace 人类摘要的 routing 结论行(可选润色)

**Files:**
- Possibly Modify: `server/services/trace/trace-log.ts`(`formatTraceHuman`,若 routing 仅以 attrs 平铺、缺一行结论)

- [ ] **Step 1: 核验现状**

Run: `grep -nE "function formatTraceHuman|attrs|\\$\\{|join" server/services/trace/trace-log.ts | sed -n '1,40p'`
判断:routing 信息是否已在一行内呈现 `selected X (source: outcome, beat Y)` 之类的结论。若 `formatTraceHuman` 已把 `routing.*` attrs 渲染成可读行 → 本 Task 无需改动,仅记一笔。

- [ ] **Step 2: (仅当 attrs 平铺不可读) 加 routing 结论行**

在 routing span 的渲染处,组合 `routing.selection_source` + `routing.selected_agent` + `routing.preferred_agent` + `routing.outcome_reason` 成一行,例如:
`routing verify → codex (source=outcome; preferred=claude; reason=…)`

具体改动以 `formatTraceHuman` 实际结构为准;改后补一个 `tests/trace-log.test.ts` 用例(若该测试文件已存在则追加)断言含 `routing` 与 selected agent。

- [ ] **Step 3: Commit(若有改动)**

```bash
git add server/services/trace/trace-log.ts tests/trace-log.test.ts
git commit -m "feat(trace): render routing decision as a one-line conclusion"
```

---

### Task 4: 指南补"可观测性"节

**Files:**
- Modify: `docs/agent-developer-guide.md`

- [ ] **Step 1: 加节**

在指南中补"可观测性"小节,列出三件事(均含真实命令):
1. `cpb jobs trace <project> <jobId> [--replay] [--json]`——看 phase/span,含 routing decision span(routing.selected_agent / selection_source / outcome_applied / independence_applied / excluded_provider_family / thresholds)。
2. `cpb jobs trace --replay`——重放 phase 产物 + acp audit。
3. `cpb agents stats [--json]`——per-agent successes/retries/success_rate(Task 2 新增)。

- [ ] **Step 2: Commit**

```bash
git add docs/agent-developer-guide.md
git commit -m "docs(agents): document observability (trace, replay, agents stats)"
```

---

## Self-Review

**1. RFC §5 A4 覆盖**:stats 查询 ✓(Task 1+2,真实缺口)、trace 核验 ✓(Task 3)、文档 ✓(Task 4)。
**2. 据实收敛**:父 RFC 把 A4 列为"trace 未暴露 + 指标未可查 + replay"三件;核实发现 trace+replay 已存在、metrics 已计算,仅缺 CLI 暴露 → 本计划收敛为 1 个真实缺口 + 2 个润色。**修复 Pass 须回填父 RFC §3 可观测性评分(7→8)与 §5 A4 描述。**
**3. 无占位符**:formatter/测试/CLI 片段均为完整可 apply 内容;Task 2/3 的"以既有 import 为准"是真实核对步骤(命名待核),非内容占位。
**4. 类型一致**:`summarizeAgentStats`/`formatAgentStatsHuman`/`AgentStatsSummary` 跨 Task 一致。

## Execution Handoff

子计划已保存。Subagent-Driven(推荐)/ Inline Execution。Phase A、冻结期安全。
