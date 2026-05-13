# Flow — Codex + Claude Code ACP Workflow

> Codex 做规划验证，Claude Code 做执行，ACP 做统一连接层，Wiki 做共享记忆。

## 快速开始

```bash
# 1. 初始化一个项目
./flow init /path/to/your-project your-project

# 2. 通过 Codex ACP adapter 规划一个任务
./flow plan your-project "Add dark mode toggle"

# 3. 通过 Claude ACP adapter 执行计划
./flow execute your-project 001

# 4. 通过 Codex ACP adapter 验证结果
./flow verify your-project 001

# 或者一步到位：全自动流水线
./flow pipeline your-project "Add unit tests for utils"
```

## 巶作流

```
┌─────────┐     plan-{id}.md      ┌─────────────┐   deliverable-{id}.md   ┌─────────┐
│ Codex ACP │ ─────────────────>  │ Claude ACP   │ ─────────────────────> │ Codex ACP │
│ (规划)   │      inbox/          │   (执行)     │       outputs/          │ (验证)   │
└─────────┘                       └─────────────┘                         └─────────┘
     ↑                                                                  │
     │                      review-{id}.md                              │
     └──────────────────────────────────────────────────────────────────┘
                                  inbox/                         (如果 FAIL)
```

## 三层使用模式

### 1. 手动逐步

逐个命令执行，每步确认后再继续。

```bash
flow plan my-project "Add auth"
# 检查 inbox/plan-001.md ...
flow execute my-project 001
# 检查 outputs/deliverable-001.md ...
flow verify my-project 001
```

### 2. 分屏协作

在 tmux 中左右分屏，Claude Code 一侧，Codex 一侧，通过 Wiki 文件实时同步。

```bash
flow interop
# 左侧 Claude Code，右侧 Codex
# 两侧都读写同一个 Wiki
```

### 3. 全自动流水线

一个命令跑完 plan → execute → verify 循环，失败自动重试。

```bash
flow pipeline my-project "Add dark mode" 3
# 自动规划 → 执行 → 验证，最多重试 3 次
```

## 目录结构

```
flow/
├── flow                    # CLI 入口
├── profiles/
│   ├── codex/soul.md       # Codex 角色定义
│   └── claude/soul.md      # Claude 角色定义
├── wiki/
│   ├── schema.md           # Wiki 宪法
│   ├── system/             # 全局管理
│   └── projects/{name}/    # 项目空间
│       ├── inbox/          # Codex 写入（计划、审查）
│       └── outputs/        # Claude 写入（交付、测试）
├── bridges/                # 调度脚本
│   ├── codex-plan.sh
│   ├── claude-execute.sh
│   ├── codex-verify.sh
│   ├── run-pipeline.sh
│   └── init-project.sh
└── templates/handoff/      # 交接文档模板
```

## ACP 连接

Flow 现在通过 ACP stdio 连接 agent，不再直接调用 `omx exec` 或 `claude -p`。

默认 adapter：

- Codex: 优先使用 PATH 中的 `codex-acp`，否则使用 `npx -y @zed-industries/codex-acp`
- Claude Code: 优先使用 PATH 中的 `claude-agent-acp`，否则使用 `npx -y @agentclientprotocol/claude-agent-acp`

可用环境变量覆盖：

```bash
FLOW_ACP_CODEX_COMMAND=codex-acp
FLOW_ACP_CODEX_ARGS='["--some-arg"]'
FLOW_ACP_CLAUDE_COMMAND=claude-agent-acp
FLOW_ACP_CLAUDE_ARGS='["--some-arg"]'
FLOW_ACP_CWD=/path/to/project
FLOW_ACP_TIMEOUT_MS=1800000
```

`FLOW_ACP_TIMEOUT_MS` 是**空闲超时**，不是总运行时长限制。只要 ACP adapter 还在输出日志、发送 tool/progress 更新、返回 JSON-RPC 消息，计时器就会刷新；设置为 `0` 可完全禁用空闲超时。

### Claude Code provider variants

`flow execute` 启动 Claude ACP adapter 前会自动应用一次性的 provider 环境变量 overlay，不会写入 secrets。

默认选择规则：

- 如果存在 Kimi/Ollama Cloud 变量，默认使用 `kimi-k2.6`
- 否则如果存在小米变量，默认使用 `mimo-v2.5pro`
- 设置 `FLOW_CLAUDE_VARIANT=none` 可完全禁用 overlay，直接继承当前 `ANTHROPIC_*`

显式切换：

```bash
FLOW_CLAUDE_VARIANT=kimi-k2.6 flow execute my-project 001
FLOW_CLAUDE_VARIANT=mimo-v2.5pro flow execute my-project 001
```

支持的 Kimi/Ollama Cloud 变量名：

```bash
OLLAMA_CLOUD_URL=...
OLLAMA_CLOUD_KEY=...
OLLAMA_CLOUD_MODEL=kimi-k2.6
```

兼容别名：`OLLAMA_CLOUD_BASE_URL`、`OLLAMA_CLOUD_API_KEY`、`OLLAMACLOUD_*`、`KIMI_*`、`MOONSHOT_*`。

支持的小米变量名：

```bash
XIAOMI_BASE_URL=...
XIAOMI_API_KEY=...
XIAOMI_MODEL=mimo-v2.5pro
```

兼容别名：`MIMO_BASE_URL`、`MIMO_API_KEY`、`MIMO_MODEL`。

Flow 会把这些变量映射为 Claude Code 识别的 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_MODEL`、`ANTHROPIC_CUSTOM_MODEL_OPTION` 以及 `ANTHROPIC_DEFAULT_*_MODEL`。

## 24h 无人值守

Flow 的无人值守模式基于 durable job、event log、lease heartbeat、task worktree 和 supervisor resume。

```bash
flow jobs
flow supervisor
```

设计说明见 `wiki/system/unattended-supervisor.md`。

## 前置要求

- **Node.js / npx**: 用于运行 Flow 的 ACP client 和按需启动 adapter
- **Codex ACP adapter**: `codex-acp` 或 `npx -y @zed-industries/codex-acp`
- **Claude ACP adapter**: `claude-agent-acp` 或 `npx -y @agentclientprotocol/claude-agent-acp`
- **Codex / Claude 登录状态或 API key**: 由各自 adapter 处理
- **tmux** (可选): 用于分屏协作模式

## 设计理念

灵感来自 Hermes 多 Agent 架构：

1. **角色分离** — Codex 只规划不执行，Claude 只执行不审批
2. **Wiki 防污染** — inbox/outputs 边界隔离未验证和已验证内容
3. **文件通信** — 不依赖 API，两侧都通过文件系统读写
4. **复用现有基础设施** — 不建新 agent，通过 ACP adapter 叠加 Flow 指令
5. **Codex 无状态** — 每次调用读 Wiki 获取完整上下文，不依赖 session

## 团队 Profile 规划

Flow 的下一阶段会从 `codex/claude` 双角色升级为 profile 驱动的小型 AI 项目团队：

- PRD: `wiki/system/team-prd.md`
- 架构: `wiki/system/team-architecture.md`

核心方向：

- `coordinator` 是唯一入口；第一步只做轻量分类、workflow 选择、roles/model variants 选择
- 分类结果写入 `wiki/projects/{project}/tasks/{task-id}/classification.yaml`
- 任务分类为 `simple`、`standard`、`complex` 或 `blocked`，并支持失败后自动升级 workflow
- `researcher`、`planner`、`builder`、`reviewer`、`verifier`、`writer`、`security` 通过 profile 定义职责和边界
- Claude Code 角色通过临时环境变量选择 `glm5.1`、`kimi-k2.6`、`mimo-v2.5pro` 等模型 variant
- 写代码任务默认使用 task-level git worktree；非 git 项目默认先 `git init`，再创建受保护 baseline 和任务 worktree
- ACP 继续作为统一连接层，wiki/state 继续作为共享记忆
