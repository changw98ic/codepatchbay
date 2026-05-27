# CodePatchBay — 编码 Agent 本地网关

[English](README.en.md)

> 将编码任务路由到 Codex 和 Claude Code，只需一个本地 CLI。无需托管服务。

## 快速开始

```bash
git clone https://github.com/changw98ic/codepatchbay.git
cd codepatchbay
sh scripts/install.sh
cpb demo
cpb init .
cpb run "fix failing tests"
```

`scripts/install.sh` 会检查 `node`、`npm`、`git`、`gh`，通过本地包管理器安装缺失工具，将当前目录安装为全局 `cpb` CLI，验证 `gh auth status`，按需引导 `gh auth login`，然后执行 `cpb setup --recommended`。

连接 GitHub 实现无人值守 issue 驱动工作流：

```bash
cpb github bind myproj owner/repo
cpb github connect --app-id 123 --webhook-secret-ref env:CPB_GITHUB_WEBHOOK_SECRET
cpb github doctor                # 启动 daemon 前验证通信
cpb daemon start
```

然后给 GitHub issue 添加 `cpb` 标签。CodePatchBay 会自动拾取、规划、执行、验证并创建 draft PR。

`cpb github doctor` 执行九层检查：app 配置、webhook 密钥、installation、私钥、传输模式、仓库绑定、分支推送就绪、PR 创建、gh CLI 认证。使用 `--json` 获取机器可读输出。

手动安装：

```bash
npm ci
npm install -g .
cpb setup --recommended
```

使用 `sh scripts/install.sh --skip-setup` 仅安装 CLI，或 `sh scripts/install.sh --setup-json` 查看安装计划但不执行。

## 功能概览

CodePatchBay 在你的机器上编排编码 Agent：

1. **`cpb setup --recommended`** — 检测工具、安装 Agent、运行健康检查、认证循环、写入配置。
2. **`cpb init .`** — 注册当前项目（名称从 `package.json` 或目录名推断）。
3. **`cpb github bind`** / **`cpb github connect`** — 绑定项目到 GitHub 仓库并配置 GitHub App。
4. **`cpb run "task"`** — 通过 plan → execute → verify 完整流水线运行任务。
5. **`cpb daemon start`** — 启动队列 worker，实现无人值守 issue 驱动工作。

## 工作流

```text
Codex 规划
  -> inbox/plan-{id}.md
  -> Claude Code 执行
  -> outputs/deliverable-{id}.md
  -> Codex 验证
  -> outputs/verdict-{id}.md

验证失败时，review-{id}.md 返回 inbox/ 重试或等待人工审核。
```

## 命令

```bash
cpb init <path> [name]             # 初始化项目（省略名称时自动推断）
cpb run "<task>" [--project <id>]  # 通过完整流水线运行任务
cpb pipeline <project> "<task>"    # 完整流水线（显式指定项目）
cpb plan <project> "<task>"        # 仅 Codex 规划
cpb execute <project> <plan-id>    # 仅 Claude 执行
cpb verify <project> <id>          # 仅 Codex 验证
cpb demo [--json]                  # 本地 mock demo（无需密钥）
cpb setup [--recommended|--interactive|--json]  # 安装向导
cpb agents [list|detect|install]   # Agent 网关管理
cpb auth [status]                  # Provider 认证检查
cpb github bind <proj> <owner/repo> # 绑定项目到 GitHub 仓库
cpb github connect [options]       # 配置 GitHub App 凭据
cpb github doctor [--json]         # 检查 GitHub 集成健康状态
cpb daemon [start|status|stop]      # 队列 worker daemon
cpb status <project>               # 项目状态
cpb list                           # 列出项目
cpb jobs [reconcile|cleanup]       # 任务管理
cpb artifacts <job-id>             # 列出任务产物
cpb verdict <job-id>               # 显示任务判定结果
cpb doctor [--json]                # 健康检查
cpb ui [--port] [--host]           # 启动 Web UI
cpb version                        # 显示版本
```

## 架构

```text
cpb (CLI 入口, Node.js)
|-- bridges/                # ACP bridges + 运行时
|   |-- acp-client.mjs      # ACP stdio JSON-RPC 客户端
|   |-- run-phase.mjs       # 单阶段运行器 (plan/execute/verify)
|   |-- run-pipeline.mjs    # 完整流水线编排器
|   |-- job-runner.mjs      # Durable job 执行器 (lease heartbeat)
|   `-- supervisor-loop.mjs # 无人值守 supervisor
|-- cli/commands/           # CLI 命令模块
|-- server/                 # Fastify REST + WebSocket 后端
|-- web/                    # React 19 + Vite 前端
`-- wiki/                   # 共享记忆文件系统
    `-- projects/{name}/
        |-- inbox/          # Codex 写入（规划、评审）
        `-- outputs/        # Claude 写入（交付物、判定结果）
```

## ACP 连接

Agent 通过 ACP stdio (JSON-RPC) 连接。默认适配器：

- Codex: `codex-acp` 或 `npx -y @zed-industries/codex-acp`
- Claude Code: `claude-agent-acp` 或 `npx -y @agentclientprotocol/claude-agent-acp`

通过环境变量覆盖：

```bash
CPB_ACP_CODEX_COMMAND=codex-acp
CPB_ACP_CODEX_ARGS='["--some-arg"]'
CPB_ACP_CLAUDE_COMMAND=claude-agent-acp
CPB_ACP_CLAUDE_ARGS='["--some-arg"]'
CPB_ACP_TIMEOUT_MS=1800000   # 空闲超时（基于活动），0 禁用
```

## Light Plan 校验

Light plan 限制 80 行，必须包含 `Affected Files`、`Tests`、`Risk` 段落。

- **默认**：违规记录警告，执行继续。
- **严格模式** (`CPB_LIGHT_PLAN_STRICT=1`)：违规直接失败。

```bash
CPB_LIGHT_PLAN_STRICT=1   # light plan 约束违规时失败
```

## Durable Jobs

无人值守模式使用 durable job，支持事件日志、lease 心跳、task worktree 和 supervisor 恢复。

```bash
cpb jobs                     # 列出 durable jobs
cpb jobs reconcile           # 标记过期 job 为失败
cpb gc                       # 清理过期 job + 孤立 lease
```

## 系统要求

- **Node.js 20+**：CLI 和 bridges 运行时
- **Codex ACP 适配器**：`codex-acp` 或 `npx -y @zed-industries/codex-acp`
- **Claude ACP 适配器**：`claude-agent-acp` 或 `npx -y @agentclientprotocol/claude-agent-acp`
- **Agent 登录/API Key**：由各适配器自行处理

## 设计原则

1. **本地优先** — 一切运行在你的机器上；Provider 适配器各自管理认证。
2. **角色分离** — Codex 负责规划和验证，Claude 负责执行。
3. **Wiki 隔离** — inbox/outputs 边界将未验证内容与已验证内容分离。
4. **文件通信** — 双方读写可检查的本地文件。
5. **ACP 复用** — 无自定义 Agent 运行时，在现有适配器上叠加 CPB 指令。

## 安全

CPB 使用 Provider 原生认证，不存储 Provider token，拦截任务输入和产物中的密钥。完整安全模型参见 [docs/security/codepatchbay-gateway-security.md](docs/security/codepatchbay-gateway-security.md)，涵盖安装安全、密钥脱敏、IM 密钥禁止、webhook 签名验证、worktree 隔离、验证器约束和 draft PR 策略。
