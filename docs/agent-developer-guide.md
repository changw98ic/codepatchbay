# Agent 接入指南 (Single Source of Truth)

> 本文档是接入 CodePatchbay (CPB) 的唯一权威指南。无论是接入新的 coding agent
> (Codex/Claude/任意 ACP-compatible provider)，还是新增角色 profile，都从本文档
> 开始。两条已发布的 JSON Schema 与本指南共同构成 agent I/O 契约：
> - Descriptor 形式化契约：[`schemas/agent-descriptor.schema.json`](../schemas/agent-descriptor.schema.json)
> - Envelope 形式化契约：[`schemas/cpb-envelope.schema.json`](../schemas/cpb-envelope.schema.json)

## 1. 接入概览

CPB 是基于 ACP (Agent Client Protocol) 的本地 coding-agent 交付运行时：用 JSON-RPC
over stdio 中立地连接 coding agents，编排 plan → execute → verify → review 流水线。
接入一个新的 agent = 写一份 **descriptor**（描述如何 spawn 该 agent 的 ACP 进程），
可选再写一份 **role profile**（覆盖某个语义角色的灵魂提示与写入边界）。

判断一个 agent 是否"接入成功"的唯一标准是它能否通过 ACP 握手并在每个被路由到的
phase 吐出本指南第 3 节定义的 envelope。最快速的参考实现是 **`fake-acp`**——一个
确定性的 ACP-compatible provider，注册在 [`core/agents/descriptors/fake-acp.json`](../core/agents/descriptors/fake-acp.json)，
其端到端验证流程（含 scenario file 用法、pool 生命周期、live provider 差异）记录在
[`docs/acp-provider-validation.md`](./acp-provider-validation.md)。本文档的所有概念
都能在 `fake-acp` 上跑通。

5 个语义角色与对应的灵魂提示位于 [`profiles/`](../profiles/)
(`planner`/`executor`/`verifier`/`reviewer`/`remediator`)。任意 ACP-compatible agent
通过 descriptor 的 `defaultRoles` 映射到这些角色。

## 2. Descriptor 形式化契约

Descriptor 的权威 schema 是 [`schemas/agent-descriptor.schema.json`](../schemas/agent-descriptor.schema.json)
(JSON Schema draft 2020-12)。`required: ["name", "command", "envPrefix"]`，`additionalProperties: true`
(允许向前兼容)。

### 逐字段说明

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string (`^[A-Za-z0-9][A-Za-z0-9._-]*$`) | 是 | agent 唯一标识，用于 `--<role>-agent <name>` 路由与 `agent-homes/<name>/` 隔离目录命名。 |
| `command` | string (`minLength: 1`) | 是 | spawn ACP 进程的主命令，如 `codex-acp`、`claude-agent-acp`、`node`。 |
| `envPrefix` | string (`^CPB_ACP_[A-Z0-9]+(_[A-Z0-9]+)*$`) | 是 | 该 agent 的环境变量前缀，CPB 据此解析 `CPB_ACP_<NAME>_COMMAND` / `_ARGS` / `_VARIANT` 等覆盖。 |
| `args` | string[] | 否 | 传给 `command` 的固定参数。 |
| `fallbackCommand` / `fallbackArgs` | string / string[] | 否 | 主命令不存在时的回退（如 `npx -y @agentclientprotocol/codex-acp`）。 |
| `displayName` | string | 否 | 人类可读名，出现在 `cpb agents detect` 输出里。 |
| `protocol` | enum `acp` \| `claude-cli` \| `unknown` | 否 | 传输协议。ACP agent 填 `acp`。 |
| `transport` | string | 否 | 传输细节（如 `stdio`）。 |
| `lifecycle` | enum `one-shot` \| `cached` | 否 | `one-shot` = 每个 phase 起一个新进程；`cached` = 进入持久 ACP 池复用。`fake-acp`/`codex`/`claude` 均为 `one-shot`。 |
| `stability` | enum `stable` \| `experimental` \| `test` \| `discovered` | 否 | 成熟度标签，影响 `cpb agents detect` 的可见性。生产 agent 填 `stable`。 |
| `capabilities` | string[] | 否 | 该 agent 能承担的 phase 能力子集，如 `["plan","execute","verify","review","remediate"]`。 |
| `defaultRoles` | enum[] (`planner` \| `executor` \| `verifier` \| `reviewer` \| `remediator`) | 否 | 默认承担的语义角色，`core/agents/routing.ts` 据此做 agent → role 映射。`codex` 默认 `["planner","verifier","reviewer"]`，`claude` 默认 `["executor","remediator"]`。 |
| `poolLimit` | integer (>=0) | 否 | 持久 ACP 池上限。 |
| `sessionMcpServers` | boolean | 否 | 是否向 `session/new.mcpServers` 注入 MCP。`claude` 显式设为 `false`（见 `docs/acp-provider-validation.md` 的 Headless vs UI 说明）。 |
| `resumeCommand` / `resumeArgs` | string / string[] | 否 | 会话恢复命令（如 `claude --resume`）。 |
| `providerKey` / `providerVariant` | string | 否 | provider 适配键 / 变体（GLM、MiMo 等走 provider-*.ts 适配器）。 |
| `description` | string | 否 | 自由文本说明。 |

### 最小可工作 descriptor 示例

照抄 [`core/agents/descriptors/fake-acp.json`](../core/agents/descriptors/fake-acp.json)
改名即可（这是最小通过 ACP 握手的真实形态）：

```json
{
  "name": "my-acp",
  "displayName": "My ACP Agent",
  "command": "node",
  "fallbackCommand": "node",
  "fallbackArgs": ["tests/fixtures/test-acp-agent.js"],
  "args": [],
  "capabilities": ["plan", "execute", "verify", "review", "remediate"],
  "defaultRoles": [],
  "stability": "test",
  "envPrefix": "CPB_ACP_MY_ACP",
  "description": "My ACP-compatible provider",
  "lifecycle": "one-shot",
  "poolLimit": 1
}
```

`codex.json` / `claude.json` 是生产级范例（带 `protocol`、`resumeCommand`、
`defaultRoles`）。已发布的 6 个 builtin descriptor 全部合规（`codex` / `claude` /
`claude-glm` / `claude-mimo` / `browser-agent` / `fake-acp`）。

## 3. I/O 契约 (Envelope)

Agent 必须在输出中吐出 **fenced JSON envelope**（``` ```json ... ``` ``` 或裸 JSON
对象均可，解析器两者都接受）。权威 schema 是 [`schemas/cpb-envelope.schema.json`](../schemas/cpb-envelope.schema.json)。
解析实现位于 [`core/agents/response-parser.ts`](../core/agents/response-parser.ts)
(`parseAgentJson` / `parsePlannerJson` / `parseExecutorJson` / `parseVerifierJson`)。

### 字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `status` | enum `ok` \| `error` \| `fail` \| `partial` | 是 | envelope 唯一必填字段。非 `ok` 即视为结构化失败，`reason`/`error` 字段会被透传。 |
| `schemaVersion` | integer (enum `[1]`) | 否 | 版本协商。**缺省 = legacy，照常接受**；存在且不在支持集 `{1}` 内 → 结构化失败 `unsupported envelope schemaVersion`。显式 `0` 不在支持集内，会被拒绝（legacy 必须以"缺省"表达，而非 `0`）。 |
| `reason` / `error` | string | 否 | 失败原因，会在 `status != "ok"` 时回传给上层。 |
| `planMarkdown` | string | planner 必填 | planner 角色的规划文档。缺失 → `planner response missing planMarkdown field`。 |
| `summary` | string | 否 | executor 摘要（也接受 `message` 别名）。 |
| `deliverablePath` | string | 否 | executor 交付物路径（如 `outputs/deliverable-*.md`）。 |
| `checklistVerdict` | array | verifier 必填 | 逐项 checklist 裁决，每项 `{ itemId, status: pass\|fail\|partial, reason? }`。缺失/非法 → verify phase 合成 `VERDICT_INVALID` / `VERIFICATION_FAILED`（见 `core/phases/verify.ts`）。 |

### Verdict 机器解析行

verify phase 的最终走向由 completion-gate 解析。机器解析行格式：

```
VERDICT: <PASS|FAIL|PARTIAL>
```

verifier envelope 同时支持 JSON 字段 `verdict: "pass"|"fail"|"partial"`（见
`parseVerifierJson`），不在该枚举内 → `invalid verdict` 结构化失败。

### 向后兼容

`schemaVersion` 协商是向后兼容的：当前所有 shipped agent (`codex`/`claude`/`fake-acp`/
fixture) 输出的无版本 `{status:"ok",...}` envelope 一律照常接受（见
`tests/agent-envelope-version.test.ts` 与 `tests/agent-envelope-golden.test.ts`）。
新接入的 agent 既可继续输出无版本 legacy envelope，也可显式带上 `"schemaVersion": 1`。

## 4. 角色期望与写入边界

5 个角色，每个角色的权威定义是其 [`profiles/<role>/soul.md`](../profiles/) 文件。
下表是一句话速查 + 写入边界（边界以 soul.md 为准）：

| 角色 | 一句话 | 只允许写入 | 强制校验 |
|---|---|---|---|
| **planner** | 把任务目标 + 项目上下文转成精确执行计划 | `wiki/projects/{name}/inbox/plan-*.md` | 只读终端命令；不写生产代码 |
| **executor** | 把已批准的计划转成可运行代码 + 测试 + 交付报告 | 项目源码 + `wiki/projects/{name}/outputs/deliverable-*.md`（+ `test-report-*.md`） | 按风险/范围补测试并跑校验 |
| **verifier** | 独立判定当前项目状态是否满足任务目标与验收标准 | `wiki/projects/{name}/outputs/verdict-*.md`（纯 JSON） | **MANDATORY**：先 `node --check` 所有变更的 `.js`/`.mjs`（语法错 = 自动 FAIL）；若 `package.json` 有 `test` script，必须跑 `npm test`（测试失败 = 自动 FAIL）；通过后才能做验收项裁决 |
| **reviewer** | 在 verifier 验收前独立审查代码质量 | `wiki/projects/{name}/outputs/review-*.md` | 输出按 `REVIEW: PASS\|FAIL` + Blocking/Non-Blocking Findings 结构 |
| **remediator** | 诊断并修复阻塞 job 的 CPB 自身 harness/runtime bug | `wiki/projects/{name}/outputs/remediation-*.md` + CPB 源码 | 只改 CPB harness，不改用户项目代码 |

写入边界的强制层在 `core/acp/policy.ts` 与 `core/policy/filesystem-boundary.ts`：
read-only phase（verify/review）越权写 → `READ_ONLY_MUTATION_DENIED`（见第 5 节）。

## 5. Sandbox 与隔离模型

### Per-agent per-job HOME

每个 agent 进程都跑在独立的隔离 HOME 下，防止同类型并发 agent 互相污染
`~/.claude` / `~/.codex`（实现：[`core/agents/isolation.ts`](../core/agents/isolation.ts)
`createAgentHome`）。隔离目录位于项目 runtime root 下的
`agent-homes/<safeAgentName>/<safeJobId>/`，权限 `0o700`，并显式设：

- `HOME` = 隔离目录
- `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_CACHE_HOME` = 隔离子目录
- `GIT_CONFIG_GLOBAL=/dev/null`、`GIT_CONFIG_NOSYSTEM=1`（不继承开发者个人 git 配置/别名/hook）

### 凭据继承 vs 配置隔离

只从用户宿主 HOME **拷贝**（非软链，`copyRegularFileNoFollow`）认证文件，让 ACP
adapter 复用登录态而不共享可变 session 状态：

- **Codex** (`inheritCodexConfig`)：只继承 `.codex/auth.json`（`CODEX_SHARED_CONFIG_FILES = ["auth.json"]`）。**`config.toml` 不继承**——它会先被 `isolateOwnedRegularFileNoFollow` 隔离保留供恢复，CPB 在运行时显式注入配置。原因见源码注释：用户级 `config.toml` 可能针对比已装 ACP adapter 更新的 Codex 版本（model/MCP/plugin/feature 开关），会让每个 job 在执行前就失败。
- **Claude** (`inheritClaudeConfig`)：继承 `.claude/.credentials.json`、`.claude/credentials.json`、`.claude/auth.json`（`CLAUDE_SHARED_CONFIG_FILES`）以及 `.claude.json`（`CLAUDE_SHARED_HOME_FILES`）。
- 单文件大小上限 `MAX_INHERITED_AUTH_BYTES = 1 MiB`，且拒绝跟随符号链接（`CPB_AGENT_HOME_UNSAFE_AUTH_SOURCE`）。

GLM/MiMo 等 variant adapter 只接收各自的原始 provider 配置（见
`core/policy/child-env.ts` 的 `*_COMPATIBLE_CREDENTIALS` 白名单），由 trusted adapter
在启动后转换，避免 ambient Anthropic key 与 GLM/MiMo 凭据混入同一子进程。

### Read-only phase 越权写

verify / review 等 read-only phase 的写越权（改项目源码、改 wiki 输入、改 git 状态
等）会被拦截为结构化失败：

- Failure kind：`FailureKind.READ_ONLY_MUTATION_DENIED`
- 拦截与归类实现：[`core/agents/agent-runner.ts`](../core/agents/agent-runner.ts)
  (`readOnlyMutationFailure` + `classifyAgentError` 中匹配 `read-only phase ...cannot run mutating terminal command`)
- 该失败 `retryable: false`，并带 `readOnlyMutation` 诊断（targetPath / allowedRoots / acpAuditFile）。

## 6. 如何用 fake-acp 测

`fake-acp` 的命令行与参数可通过环境变量覆盖（前缀来自 descriptor 的 `envPrefix`
`CPB_ACP_FAKE_ACP`）。以下例子照搬自 [`docs/acp-provider-validation.md`](./acp-provider-validation.md)。

**单次响应**（`--response`）：

```bash
CPB_ACP_FAKE_ACP_COMMAND=node \
CPB_ACP_FAKE_ACP_ARGS='["dist/tests/fixtures/test-acp-agent.js","--response","hello"]' \
node dist/server/services/acp/acp-client.js --agent fake-acp --cwd "$PWD"
```

**全链路 scenario**（`--scenario-file`，按 prompt 匹配返回不同响应）：

```bash
CPB_ACP_FAKE_ACP_ARGS='["dist/tests/fixtures/test-acp-agent.js","--scenario-file","/tmp/scenario.json"]'
```

scenario 条目用 `match` / `matchRegex` 匹配 prompt，可返回 `output` / `chunks` /
`outputFile`，或通过 `writes` 让 fake agent 执行 ACP client 文件写入。这样能在跑通
registry 解析、ACP 进程启动、JSON-RPC 握手、session update、response 解析、artifact
持久化的同时，精确控制 plan/execute/review/verify 各 phase 的响应内容。

新接入的 agent 应先用 fake-acp 模式把全链路打通（descriptor 合规、envelope 解析、
角色路由），再切到真实 provider 做第 1 节引用的 live validation。

## 7. 如何发布一个新 agent

1. **放 descriptor**：
   - Builtin：放 [`core/agents/descriptors/`](../core/agents/descriptors/)（随发行版
     分发）。加载入口：[`core/agents/registry.ts`](../core/agents/registry.ts)。
   - 本地/私有：设环境变量 `CPB_AGENTS_CONFIG_DIR` 指向一个目录，把 descriptor
     JSON 放进去（`registry.ts` 优先读该目录）。
2. **指派到角色**：在 `cpb pipeline` 上用 per-role agent 开关把该 agent 绑到某个
   语义角色。真实 flag 名（见 `cli/commands/pipeline.ts`）：
   - `--plan-agent <name>` — planning phase
   - `--execute-agent <name>` — execution phase
   - `--verify-agent <name>` — verification phase
   - `--review-agent <name>` — review phase

   不指定时，`core/agents/routing.ts` 按 descriptor 的 `defaultRoles` 自动路由。
3. **探测与自检**：
   - `cpb agents detect [--json]` — 探测本机已安装的 agent。
   - `cpb agents test <agent> [--json]` — 对指定 agent 做握手冒烟。

## 8. 冻结边界与 Phase B 展望

**当前稳定化周期（见根 CLAUDE.md / README 红线）冻结横向能力扩张**：不新增 agent
类型、不新增 workflow 类别、不新增 scheduler 特性或 provider 集成。这意味着：

- 不要在本周期内新增第 6 个语义角色或新的 workflow phase。
- 新接入的 **ACP-compatible** agent 仍可通过本指南第 7 节的 descriptor + 配置目录
  方式落地（这是已被支持的扩展面），但不要新增需要改 `core/agents/routing.ts` /
  `core/agents/registry.ts` 类型枚举的硬编码 agent 种类。

**Phase B — Provider Registry 落地后**（父 RFC
[`docs/superpowers/plans/2026-07-28-cpb-agent-platform-maturity-rfc.md`](./superpowers/plans/2026-07-28-cpb-agent-platform-maturity-rfc.md)
§6）：接入第三类 agent 将无需改源码——descriptor 注册、路由、隔离全部走配置化
registry。届时本指南第 7 节的"放 descriptor / 设 `CPB_AGENTS_CONFIG_DIR`"会成为
所有 agent 的标准接入路径，不再需要 builtin 目录。
