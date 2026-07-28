# CPB Agent 平台成熟度提升 设计 RFC

> **文档性质**:设计层 RFC(非任务级 plan)。本文是后续按子系统拆分的实现 plan(`docs/superpowers/plans/` 下若干 `*-plan.md`)的纲领。子 plan 才包含 TDD bite-sized 任务与 `subagent-driven-development` 执行头。
>
> **状态**:Draft · 2026-07-28 · 作者:程文 + Claude

**Goal:** 把 CodePatchbay(CPB)的 9 个 agent 开发者维度全部提升到 9/10,核心是消除"声明式注册、命令式(codex/claude 特判)选择"的割裂,使接入第三类 agent 从"改源码"变为"丢 descriptor"。

**Architecture:** 引入唯一的 **Provider Capability Registry**——把 provider family 归类、HOME 继承文件、sandbox 策略、默认角色、tie-break 优先级全部下沉为 descriptor 声明字段,删除所有 `==="codex"` / `==="claude"` 字面量特判。工作分两阶段:Phase A(冻结期安全,6 维→9)、Phase B(需解冻,3 维→9)。

**Tech Stack:** TypeScript(strict, ESM)、Node ≥ 20、Node 内置 test runner、文件系统持久化(JSON descriptor / JSONL events)、ACP over stdio。

---

## 1. 背景

CPB 是 agent **交付运行时**(非 agent 框架):用 ACP 连接现成 coding agent,编排 `plan → execute → verify → deliver`,落成本地可审查产物。

当前 agent 子系统的事实(已核实):

- **注册层声明式**:`core/agents/registry.ts` 从 `descriptors/*.json` + `CPB_AGENTS_CONFIG_DIR` + `autoDiscoverAgents()` + `squads.json` 加载。shipped 6 个 descriptor:`codex` / `claude` / `claude-glm` / `claude-mimo` / `browser-agent` / `fake-acp`。
- **角色与 provider 正交**:5 个语义角色 `profiles/`(planner/executor/verifier/reviewer/remediator),由 descriptor 的 `defaultRoles` 决定映射。
- **选择层命令式特判**:多条 load-bearing 路径在字面量 `"codex"` / `"claude"` 上短路(详见 §4.2)。

## 2. 目标 / 非目标

### 目标
- 9 个维度全部达到 9/10(详见 §3 评分表与每维度 DoD)。
- 接入一个新 agent(以 `gemini` 为验收样本)只需写 descriptor + 设配置,**不改任何 `core/**/*.ts`**。
- agent 开发者有单一权威文档 + JSON Schema 可依。
- 关键安全/恢复边界(隔离、会话、poisoned)有直接单测覆盖。

### 非目标
- **不**在冻结期内新增 agent 类型(Phase B 之前)。
- **不**改动 ACP 协议本身、不替换 5 角色模型、不新增 workflow 类别 / scheduler 特性 / provider 集成(遵守 README 稳定化周期红线)。
- **不**重写 `acp-client.ts`(3083 行)/ `acp-pool.ts`(5400+ 行)的内部结构——只动其中 agent 名特判点。
- **不**追求 10 分;9 = "业内成熟、无明显短板"。

## 3. 现状评分与差距

| 维度 | 现 | 到 9 的关键差距 | 主要阶段 |
|---|---|---|---|
| 角色抽象(provider/角色正交) | 9 | 维持;可选清一致性 | A |
| agent I/O 契约 | 8 | envelope 无 `schemaVersion`、无 JSON Schema、契约分散 | A |
| 注册/扩展机制 | 5 | 无 mutation API、无 CLI、两套 catalog、被特判 | **B** |
| 路由质量 | 8 | tie-break / family 特判 | B |
| 隔离/安全边界 | 8 | 关键路径无直接单测 + 特判 | A(单测)+ B(特判) |
| 会话/恢复 | 8 | 无 e2e、pin 仅间接 | A |
| 可观测性 | 8 | trace/replay/metrics 已实现并经 engine 消费,唯一缺口是无 CLI 暴露(已落 A4 子 plan) | A |
| 开发者文档 | 6 | 无"接入指南"、无 schema 发布 | A |
| 测试覆盖 | 7 | dynamic-plan / isolation / session-cache 盲区 | A |

> **注**:"可观测性"一栏已于 v1.2 据实修正(7→8):核实发现 `cpb jobs trace [--replay]` 已存在、routing decision 已在 `trace-log.ts:229-246` richly surface、`readAgentRoutingMetrics` 已算 per-agent 成功率;唯一缺口是无 CLI 暴露(见 §5 A4)。

## 4. 关键决策:冻结边界

CPB `README` 稳定化周期明确**冻结横向扩张**(不新增 agent 类型)。本 RFC 的 Phase B(Provider Capability Registry)必然新增 agent 抽象层,**触碰该红线**。因此:

- **Phase A 必须先于 Phase B**,且 Phase A 产出 isolation/会话/路由的**直接单测**,作为 Phase B 重构特判的安全网。
- **Phase B 启动需明确解冻决策**(stakeholder sign-off),并在 PR 中说明触及发布门禁、跑 `npm run verify:release-gate`。
- Phase B 每个任务保留 fallback(env `CPB_PROVIDER_REGISTRY=0` 回退旧字面量路径),dogfood 通过前不删旧实现。

**若坚持不解冻**:注册/扩展维度上限为 8(只能补 mutation API + 文档 + 单测,删不掉特判)。本 RFC 覆盖"全 9"路径,即假设 Phase B 解冻。

## 5. Phase A — 冻结期(目标:6 维→9,另 3 维稳到 8)

Phase A 不新增 agent 类型、不动选择层特判,风险低,可在冻结期内完成。

### A1. 开发者文档与 Schema 发布(文档 6→9)
- **产出**
  - `docs/agent-developer-guide.md`:descriptor schema → envelope 契约 → 角色期望 → sandbox 模型 → 用 `fake-acp` 测试 → 发布。照搬 `docs/acp-provider-validation.md` 的 `fake-acp` 示例。
  - `schemas/agent-descriptor.schema.json`:形式化 §4.1 的 descriptor 字段。
  - `schemas/cpb-envelope.schema.json`:形式化 agent 输出 envelope + 每角色 payload(`planMarkdown`、executor result、`checklistVerdict`)。
- **DoD**:一个新读者只读这两份文档 + 两个 schema,能写出合法 descriptor 和符合契约的 agent 输出,无需读源码。

### A2. I/O 契约加固(契约 8→9)
- **现状**:`core/agents/response-parser.ts` 的 `parseAgentJson` 做 fenced-JSON 提取 + `status` 校验,但**不校验版本**,且无 schema。现有 codex / claude / fake-acp 及测试 fixture 的输出均为 `{status:"ok", ...}`,**不含** `schemaVersion`——强制版本会拒绝它们。
- **改动(向后兼容优先,零回归存量输出)**
  - envelope 增加字段 `schemaVersion`(如 `1`),但 `parseAgentJson` 采用**版本协商**:缺省 → 视为 legacy v0,**照常接受**;存在 → 校验落在支持范围,不匹配才走 `isStructuredJsonFailure`。
  - 强制启用**仅对声明 `emitsEnvelopeVersion: true` 的 descriptor** 生效;存量 descriptor 不受影响,外部 agent(codex-acp/claude-agent-acp)无需改造。
  - 为每个 shipped agent 的真实输出建立 **golden round-trip 契约测试**:固定输出(含 legacy 无版本形态)→ 经 parser → 断言字段,**确保迁移不破坏存量 agent**。
- **DoD**:envelope 有可选版本 + 协商逻辑;schema 发布;6 个 shipped descriptor 各有 golden 测试(含 legacy 形态);存量输出零回归。

### A3. 填测试盲区(测试 7→9;同时为 Phase B 铺安全网)
- **新增直接单测**:
  - `tests/dynamic-agent-plan.test.ts`——覆盖 `generateDynamicAgentPlan` 的 high/critical 分支、`validateDynamicAgentPlan`(当前无专项测试,只在 `high-assurance-policy.test.ts` 当 setup 用)。
  - `tests/agent-isolation.test.ts`——直接覆盖 `createAgentHome` / `inheritCodexConfig` / `inheritClaudeConfig` / `config.toml` quarantine / symlink 拒绝 / `MAX_INHERITED_AUTH_BYTES=1MiB` 上限 / `assertContained`+`safeSegment` 路径穿越 fuzz(当前仅 `agent-isolation-runtime-root.test.ts` 覆盖 runtime root 一条路径)。
  - `tests/session-cache-lifecycle.test.ts`——端到端:`saveSessionId` → 重载 registry → `loadSessionId` → 按 age(24h)/count recycle;并**固化当前 agent-scoped 语义**:`cacheEntryName` = `${agent}--conversation-${sha256(conversationKey)}`(`session-cache.ts:118-124`),`assertSessionRecordBinding` 校验 `record.agent`(`:1200-1207`)→ 断言"不同 agent 即便 conversationKey 相同也命中不同条目;handoff 到新 agent 返回 null(开新会话)",**而非**"会话连续"。
  - `tests/session-pin.test.ts`——直接覆盖 `pinSessionToJob`(当前仅 `job-recovery-hardening.test.ts` 间接覆盖)。
- **设计决策 D1(会话连续性)**:`conversationKey` 本身不含 agent(`buildConversationKey` 仅 project/jobId/attemptId/role),但缓存键 = `(agent, conversationKey)`。因此 provider handoff **不会**复用会话——在 high-assurance(executor=claude-glm、verifier=codex)与 outcome-routing 切换 verifier 时,这恰恰是**独立性的保证**。本 RFC 据此**不追求**跨 agent 会话连续;A3 仅以测试固化现状语义。若未来确需连续(如同一 agent 不同 variant 的 resume),须另立 Phase B 设计:agent-independent cache key + 显式跨 agent 迁移 + 独立性影响评审。
- **门禁**:在 `core/agents/` + `core/engine/` 加 coverage 门槛(类比已有 `npm run typecheck:strict:engine`),设初始底线,低于则 CI fail。
- **DoD**:上述 4 文件落地;coverage 门槛上线;盲区函数均有直接测试。

### A4. 可观测性(可观测 8→9;v1.2 据实修正)
- **核实结论**(纠正本节原"未下钻"预设):可观测性比原评 7 分更成熟——
  - `cpb jobs trace <project> <jobId> [--json] [--replay] [--include-patch]` **已存在**(`cli/commands/jobs.ts:24`);`--replay` 经 `trace-replay.ts`、默认经 `trace-log.ts:buildJobTrace`。
  - routing decision **已 richly surface**:`trace-log.ts:229-246` 把 `agent_routing_decision` 事件转成 span 属性(`routing.selected_agent` / `selection_source` / `outcome_applied` / `independence_applied` / `excluded_provider_family` / `thresholds` / `candidates`),事件由 `phase-start-events.ts:107-129` 发射。
  - per-agent 成功率**已计算**:`provider-usage.ts:1081 readAgentRoutingMetrics` + `:952 readProviderUsageRollup`,被 engine 内部消费(`engine-runner.ts:117`)。
- **唯一真实缺口**:上述 metrics **无 CLI 暴露**(`cli/` 零引用)→ 开发者无法查询"agent X 的 verifier 成功率"。
- **改动**(详见 A4 子 plan):加 `cpb agents stats [--json]`(调 `readAgentRoutingMetrics` + `readProviderUsageRollup`,新增纯函数 formatter);核验 `formatTraceHuman` 的 routing 摘要可读性,必要时加一行结论;指南补可观测性节。
- **DoD**:`cpb agents stats` 可查 per-agent successes/retries/success_rate;trace/replay 行为零回归。

### A5. profile 一致性(角色抽象守住 9;v1.2 据实修正)
- **核实结论**:`profiles/*/config.json` **被运行时消费**——`loadProfile`(`prompt-resources.ts:254`)只取 `permissions.{write_paths,deny_tools,deny_commands}` + `soul.md`;`permission-matrix.ts:570-580` **强制执行** `deny_tools`/`deny_commands`/`write_paths`(且 `write_paths:["**/*"]` 被过滤除非 `CPB_DANGEROUS=1`)。`agent`/`acp` 块**无消费点(vestigial)**。故:
- **改动**(详见 A5 子 plan,audit-first、权限零回归):
  - `reviewer/soul.md` 英化(只改语言不改语义)。
  - 删除 5 个 config.json 的 vestigial `agent`/`acp` 块(以守护测试为前置)。
  - **不**盲目"补齐 deny_tools"——executor/remediator 必须能写;仅 planner/reviewer(read-only)对齐 deny_tools 到 verifier 同集合,词汇表以 audit 为准。
  - executor/remediator skills 重复 → 文档化为有意(role 隔离),不强制去重。
  - `profiles` 加 JSON schema + 形状守护测试(`additionalProperties:false` 锁住 vestigial 块不回潮)。
- **DoD**:5 profile 结构/语言一致;config.json 仅留被消费字段;read-only 角色 deny_tools 对齐;有 schema 守护;权限零回归。

### Phase A DoD 汇总
角色抽象 9、I/O 契约 9、会话 9、可观测 9、文档 9、测试 9;隔离 8(单测到位但特判仍在)、路由 8、注册/扩展 6(补了文档/部分测试)。

---

## 6. Phase B — 解冻后(目标:注册/扩展、路由、隔离 → 9)

**前置**:Phase A 完成(尤其 A3 的 isolation/路由直接单测),且已获解冻决策。

### 6.1 架构:Provider Capability Registry

把"family / 继承文件 / sandbox / 默认角色 / tie-break"下沉为 descriptor 字段。registry 成为这些属性的**唯一查询入口**,所有子系统读 registry、不再各自特判。

### 6.2 新 descriptor 字段(扩展现有 schema)

```jsonc
{
  "name": "codex",
  "displayName": "Codex CLI",
  "command": "codex-acp",
  "fallbackCommand": "npx",
  "fallbackArgs": ["-y", "@zed-industries/codex-acp"],
  "envPrefix": "CPB_ACP_CODEX",
  "protocol": "acp",
  "lifecycle": "one-shot",
  "stability": "stable",

  // —— 新增:Provider Capability ——
  "providerFamily": "codex",            // 替代 providerFamilyFor 正则表
  "tieBreakPriority": 10,               // 替代 outcome-routing 的 codex 硬优先
  "sandboxPolicy": "native",            // native | cpb-required | none;替代 agent-runner codex 分支
  "defaultRoles": ["planner", "verifier", "reviewer"],
  "capabilities": ["plan", "execute", "verify", "review"],
  "inheritFiles": [                     // 替代 inheritCodexConfig + isolation 分支;from 环境感知,见下方安全约束
    { "from": "$CODEX_HOME/auth.json", "to": "$HOME/.codex/auth.json", "maxBytes": 1048576 }
  ],
  "quarantineFiles": ["config.toml"],   // 显式声明需隔离的现成配置

  "resumeCommand": "codex",
  "resumeArgs": ["--resume"]
}
```

现有 6 descriptor 的字段映射(迁移表):

| descriptor | providerFamily | tieBreakPriority | sandboxPolicy | inheritFiles |
|---|---|---|---|---|
| codex | `codex` | 10 | `native` | `$CODEX_HOME/auth.json`(`CODEX_HOME` ‖ `~/.codex`) |
| claude | `claude` | 20 | `cpb-required` | `~/.claude.json` + `~/.claude/{.credentials.json,credentials.json,auth.json}` |
| claude-glm | `glm` | 30 | `cpb-required` | (同 claude) |
| claude-mimo | `mimo` | 40 | `cpb-required` | (同 claude) |
| browser-agent | `browser` | 100 | `cpb-required` | [] |
| fake-acp | `test` | 1000 | `none` | [] |

**`inheritFiles` 安全约束(P1 前置门禁 — 泛化继承前必须落地)**:descriptor 分两级信任:
- **builtin**(`core/agents/descriptors/*.json`):可信,`from`/`to` 原样使用。
- **user**(`CPB_AGENTS_CONFIG_DIR` / `cpb agents add`):**不可信**,必须同时满足——
  - `from` 解析自受信环境根(`resolveSourceCodexHome` 同语义:`$CODEX_HOME` ‖ `$HOME/.codex`;其余 family 默认 `$HOME`),且文件名匹配 credential 白名单(如 `auth.json`/`.credentials.json`);**拒绝任意绝对路径宿主文件**。
  - `to` 经 canonicalize 后必须落在 `$HOME` 内;拒绝 `..`、绝对路径、符号链接逃逸。`O_NOFOLLOW`/`copyRegularFileNoFollow` 只挡 symlink 穿越,**不挡绝对路径**,故需显式 containment 校验。
  - 全局硬字节上限 `MAX_INHERITED_AUTH_BYTES`(1 MiB),单条 `maxBytes` 不得上调该上限。
  - 违反任一 → **fail-closed**(descriptor 拒绝注册)+ audit 事件。
- `from` **环境感知**:codex 真实源是 `resolveSourceCodexHome(parentEnv) = parentEnv.CODEX_HOME ?? ~/.codex`(`isolation.ts:98`),故写 `$CODEX_HOME/auth.json` 而非硬编码 `~/.codex/auth.json`——否则自定义 `CODEX_HOME` 安装会拷错文件、启动未鉴权 agent。

### 6.3 删除的特判点(file:line 清单,均经核实)

| 文件:行 | 现状 | 替换为 |
|---|---|---|
| `core/agents/registry.ts:208-225` | `defaultAgentForRole` codex 短路(codex 在场永不查别的 `defaultRoles`) | 纯 `defaultRoles` + `tieBreakPriority` 驱动;codex 仅是优先级最高者 |
| `core/agents/outcome-routing.ts:113-114` | tie-break `agent==="codex"` 无条件 `-1/1` | 读 `descriptor.tieBreakPriority` |
| `core/agents/outcome-routing.ts:119-127` `providerFamilyFor` | 正则表只认 claude/glm/codex/openai/anthropic | 读 `descriptor.providerFamily` |
| `core/agents/isolation.ts:680-684` + `inheritCodexConfig`/`inheritClaudeConfig` | 名字分支 + 两份独立继承逻辑 | 通用循环遍历 `descriptor.inheritFiles`,`maxBytes` 兜底 `MAX_INHERITED_AUTH_BYTES` |
| `core/agents/agent-runner.ts:114` `claudeArgsEnvKey` | `if(agentName==="claude")` | 复用已有 `resolveAgentEnvPrefix(name)` 推导 `${prefix}_ARGS` |
| `core/agents/agent-runner.ts:354` | `if(agentName==="codex")` sandbox 跳过 | 读 `descriptor.sandboxPolicy` |
| `core/agents/dynamic-agent-plan.ts:2` | `DEFAULT_DYNAMIC_VERIFIER_AGENT="codex"` | 读 registry:`defaultRoles` 含 verifier 的 agent 中 `tieBreakPriority` 最小者 |
| `core/policy/high-assurance.ts:74-91` | 默认 `codex` + `claude-glm` 写死(但结构已 config-driven:`planning.candidates/arbiter`、`execution`、`verification{blind,independent}`) | **保留显式 assurance 结构**(它表达 candidates / arbiter / blind-independent-verifier,`defaultRoles`+`tieBreakPriority` 表达不了);仅把**默认 fallback 字面量**改为 registry 解析(每槽取 `tieBreakPriority` 最高的合格 agent);新增 **fail-closed**:`verification.independent=true` 时,若 registry 找不到与 execution 不同 `providerFamily` 的 verifier → 拒绝进入 high 模式 |
| `core/engine/provider-handoff.ts:171` | `selectedAgent==="claude"` variant 命名 | 通用 `descriptor.providerKey`/`providerVariant`(descriptor 已有该字段) |
| `core/engine/phase-retry.ts:299` | `return "codex"` | `defaultAgentForRole(role)` |
| `core/agents/auto-discover.ts:8-24` | `KNOWN_AGENTS` 硬编码 15 名 | 保留作"已知 binary 提示",但发现源扩展为协议探测(ACP `--help`/`--version`),不再仅靠白名单 |
| `core/agents/squads.json` | 4 squad 全 `[claude,codex]` | 数据 OK;但提供按 `defaultRoles`/`capabilities` 自动成队的生成器(可选) |
| `cli/commands/setup.ts:130-144,205` | `detectQuickAgents` 硬编码 4 个 + 默认 `claude` | 从统一 catalog(§6.5)读 |
| `cli/commands/pipeline.ts:4-34` `buildAgentMetadata` | 只认 4 角色 | 加 `--remediator-agent` flag,补全 5 角色 |

> 字面量删除**以 A3 直接单测为前置**:每删一点,先确认对应单测在场且通过。

### 6.4 任务序列(B)
- **B1 扩展 descriptor schema + registry 读取**:加 `providerFamily`/`tieBreakPriority`/`sandboxPolicy`/`inheritFiles`/`quarantineFiles` 字段 + `validateDescriptor` 校验;registry 暴露 `getCapability(name)` 查询。旧字段不删,新旧并存。
- **B2 删选择层特判**:按 §6.3 表逐点改读 registry;每点配单测。`defaultAgentForRole` 改 defaultRoles 驱动。
- **B3 mutation API + CLI**:registry 加 `registerDescriptor()`;`cli/commands/agents.ts` 加 `cpb agents add <file>` / `register`;写 `CPB_AGENTS_CONFIG_DIR`。
- **B4 对齐 catalog(不合并字段)**:`descriptors/defaultRoles`(路由默认)与 `manifests/roles`(发现/UI 广告的支持角色)**语义不同、刻意分离**——codex 故意广告 `executor` 却默认 `reviewer`。**保留两个字段**,定义不变式 `defaultRoles ⊆ roles` 并交叉校验;统一的是**条目来源**(同一 agent 在两处命名/版本一致),而非把两字段压成一份。`setup/` 另开 `CPB_SETUP_MANIFESTS_DIR` 等价物。
- **B5 dogfood**:写 `descriptors/gemini.json`(`providerFamily:"gemini"`、设 `defaultRoles`/`inheritFiles`/`sandboxPolicy`),**不改任何 .ts**,跑 `cpb pipeline ... --execute-agent gemini` 全链路;进 squad;被 outcome 排序;HOME 正确隔离。

### 6.5 Phase B DoD
- §6.3 表中所有字面量删除,`grep -rn '==="codex"\|==="claude"' core/ server/ cli/` 在选择/隔离/继承路径上零命中(测试 fixture 与注释除外)。
- B5 gemini dogfood 通过:接入第三类 agent 零源码改动。
- 注册/扩展 9、路由 9、隔离 9。

---

## 7. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| 删 codex 短路改变默认行为,质量回退 | 高 | Phase B 全程 env `CPB_PROVIDER_REGISTRY=0` 回退旧路径;dogfood + outcome A/B 对照(同任务跑新旧路径比 verdict) |
| catalog 统一破坏现有 setup/upgrade 流 | 中 | B4 单独 PR,保留 manifest 适配层;`cpb agents upgrade` 回归测试 |
| `inheritFiles` 通用化引入越权继承 | 高(安全) | A3 的 isolation 直测 + fuzz 为前置;`maxBytes` 兜底;`assertSafeDirectoryChain`/`O_NOFOLLOW` 不变 |
| gemini 无现成 ACP adapter,B5 无法验收 | 中 | dogfood 可用 `fake-acp` 变体或任一已有第三家族(如 `claude-mimo` 改 `providerFamily`)证明"零源码改接入",gemini 真实接入为加分项 |
| Phase B 违冻结红线 | 流程 | §4 明确需解冻 sign-off;PR 说明触及门禁 + 跑 `verify:release-gate` |
| 大文件重构(`acp-pool.ts` 5400+ 行) | 中 | 只动 agent 名特判点,不重构内部结构(非目标) |
| `inheritFiles` 泛化引入越权 / 路径逃逸 | 高(安全) | user 级 descriptor 强制 source 白名单 + `to` containment + 全局字节上限 + fail-closed(见 §6.2 安全约束) |
| 强制 `schemaVersion` 拒绝存量 agent 输出 | 高 | A2 版本协商:缺省 = legacy v0 照常接受,仅 `emitsEnvelopeVersion` descriptor 强制 |
| 误把"会话连续"当 DoD(实际 handoff 开新会话) | 中(语义) | D1:测试固化 agent-scoped 现状;跨 agent 连续另立 Phase B 设计 + 独立性评审 |
| high-assurance registry 化丢失独立性 | 高 | 保留 assurance 显式结构 + `verification.independent` fail-closed(见 §6.3) |
| 合并 catalog 改变默认路由 / 误报支持角色 | 中 | B4 保留 `roles` 与 `defaultRoles` 分离 + `defaultRoles ⊆ roles` 不变式 |

**回滚策略**:每个 Phase B 任务独立可 revert;`CPB_PROVIDER_REGISTRY=0` 作为全局 kill switch;旧 `inheritCodexConfig`/`inheritClaudeConfig` 保留至 B5 通过后再删。

## 8. 后续:拆分为子实现 plan

本 RFC 定稿后,按 writing-plans skill 拆为可执行子 plan(每份含 TDD bite-sized 任务):

- `2026-07-28-agent-docs-and-schema-plan.md`(A1 + A2)
- `2026-07-28-agent-test-coverage-plan.md`(A3 + coverage 门槛)
- `2026-07-28-agent-observability-plan.md`(A4,核实后定细节)
- `2026-07-28-profile-consistency-plan.md`(A5)
- `2026-07-28-provider-capability-registry-plan.md`(B1–B5,解冻后)

每份子 plan 头部带 `subagent-driven-development` 执行指引。

---

## 修订记录

- **2026-07-28 v1.1(Codex review 驱动)**:
  - [P1] §6.2 `inheritFiles` 增加 source 白名单 / `to` containment / 全局字节上限 / fail-closed;`from` 改环境感知(`$CODEX_HOME`),修正自定义 `CODEX_HOME` 拷错文件致未鉴权启动。
  - [P1] §5 A2 `schemaVersion` 改为可选 + 版本协商(缺省 = legacy v0 照常接受),避免拒绝存量 codex/claude/fake-acp 输出。
  - [P1] §5 A3 纠正"provider handoff 会话连续"的错误断言:核实 `cacheEntryName`(`${agent}--…`)与 `assertSessionRecordBinding` 使缓存键含 agent,handoff 即开新会话(亦是独立性保证);新增设计决策 D1。
  - [P1] §6.3 high-assurance 改为"保留显式 assurance 结构 + registry 解析默认值 + `verification.independent` fail-closed",不再 collapse 成 defaultRoles 查询。
  - [P2] §6.4 B4 改为"对齐而非合并":保留 `roles`(广告)与 `defaultRoles`(路由)分离 + `defaultRoles ⊆ roles` 不变式。
  - [P3] `child-A` / `child-B` 为无关 writer/sequence 测试产物,非 RFC 内容——建议从工作树移除或转入 fixture(不在本 RFC 范围)。
- **2026-07-28 v1.2(拆子计划时自查驱动)**:
  - §3 + §5 A4:可观测性评分 7→8。核实发现 `cpb jobs trace [--replay]` 已存在、routing decision 已在 `trace-log.ts:229-246` richly surface、`readAgentRoutingMetrics` 已算 per-agent 成功率;唯一缺口是无 CLI 暴露(已落 A4 子 plan)。
  - §5 A5:纠正"补齐 deny_tools""config.command 引用 descriptor"两条。核实 config.json 仅 `permissions.*` 被消费、deny_tools 是运行时权限 → 改为 audit-first + 仅 read-only 角色对齐 + 删 vestigial `agent`/`acp` 块。
  - 附录:移除"A4 未下钻"标注(已核实)。

## 附录:核实来源

本文 file:line 证据来源:
- 直接核实(codegraph verbatim / Read):`registry.ts`、`routing.ts`、`phase-agent-routing.ts`、`response-parser.ts`、`agent-runner.ts`、`acp-pool.ts`、`acp-client.ts`、`descriptors/*.json`、`squads.json`、`docs/acp-provider-validation.md`、`tests/` 目录。
- 只读子 agent 核实(带 file:line,与直接核实一致):`profiles/*`、`core/setup/*`、`cli/commands/{setup,pipeline,agents}.ts`、`isolation.ts`、`session-cache.ts`、`session-pin.ts`、`poisoned-session*.ts`、`dynamic-agent-plan.ts`、`outcome-routing.ts`、`high-assurance.ts`、`provider-handoff.ts`、`phase-retry.ts`、`auto-discover.ts`。

§5 A4 可观测性已于 v1.2 核实(见修订记录);本文 file:line 证据均经直接(codegraph verbatim / Read)或只读子 agent 核实。
