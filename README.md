# CodePatchBay — 面向 AI 编码代理的本地网关，用于经过验证的代码变更

[![npm version](https://img.shields.io/npm/v/codepatchbay.svg)](https://www.npmjs.com/package/codepatchbay) [English](README.en.md)

> 通过本地可检查的规划 → 执行 → 验证交接流程路由 AI 编码工作，任何代码在到达 PR 之前都需经过验证。无需托管服务。

## 快速开始

### 从 npm 安装（推荐）

npm 包名：[`codepatchbay`](https://www.npmjs.com/package/codepatchbay)

```bash
npm install -g codepatchbay
cpb setup --recommended        # 检测工具、安装智能体、运行健康检查
cpb demo                       # 本地产物演示，无需服务提供商密钥
cd your-project
cpb init .                     # 注册当前项目
cpb run "fix failing tests"    # 完整规划 → 执行 → 验证流水线
```

免安装直接试用：

```bash
npx codepatchbay demo
```

### 从源码安装

```bash
git clone https://github.com/changw98ic/codepatchbay.git
cd codepatchbay
sh scripts/install.sh          # 一键安装：检测依赖 → 全局注册 → setup
```

`cpb demo` 运行本地模拟，展示产物循环（规划产物、执行交付物、验证器判定结果），无需服务提供商 API 密钥。`cpb run` 使用已配置的本地 ACP 适配器，通过 Codex 进行规划和验证，通过 Claude Code 进行执行。

`scripts/install.sh` 会检查 `node`、`npm`、`git`、`gh`，通过本地包管理器安装缺失工具，将当前目录安装为全局 `cpb` 命令行工具，验证 `gh auth status`，按需引导 `gh auth login`，然后执行 `cpb setup --recommended`。

### 使用流程

```text
1. cpb init .                        注册项目
2. cpb run "add dark mode"           提交任务（完整流水线）
3. cpb status myproj                 查看状态
4. cpb artifacts <job-id>            查看产物
5. cpb verdict <job-id>              查看验证结果
```

### 可选 GitHub 集成

连接 GitHub 实现无人值守议题驱动工作流：

```bash
cpb github bind myproj owner/repo
cpb github connect --app-id 123 --webhook-secret-ref env:CPB_GITHUB_WEBHOOK_SECRET
cpb github doctor                # 启动守护进程前验证通信
cpb daemon start
```

然后给 GitHub 议题添加 `cpb` 标签。CodePatchBay 会自动拾取、规划、执行、验证并创建草稿 PR。

`cpb github doctor` 执行九层检查：应用配置、webhook 密钥、安装实例、私钥、传输模式、仓库绑定、分支推送就绪、PR 创建、gh 命令行认证。使用 `--json` 获取机器可读输出。

### 从源码手动安装

```bash
npm ci
npm install -g .
cpb setup --recommended
```

使用 `sh scripts/install.sh --skip-setup` 仅安装命令行工具，或 `sh scripts/install.sh --setup-json` 查看安装计划但不执行。

## 功能概览

CodePatchBay 是本地优先的控制平面，用于经过验证的 AI 代码变更：

1. **任务接收** — 从 CLI 提示符或 GitHub 议题接收任务
2. **规划** — Codex 将可检查的规划产物写入 `inbox/`
3. **执行** — Claude Code 应用变更并将交付物写入 `outputs/`
4. **验证** — Codex 审查变更并写入判定产物
5. **草稿 PR** — 验证通过时，为人工审核创建草稿 PR
6. **产物检查** — 所有规划、交付物和判定均为本地 Markdown 文件

关键命令：
- `cpb setup --recommended` — 检测工具、安装智能体、运行健康检查、认证循环
- `cpb demo` — 本地产物演示（无需密钥）
- `cpb init .` — 注册当前项目（名称从 `package.json` 或目录名推断）
- `cpb run "task"` — 完整规划 → 执行 → 验证流水线
- `cpb research` — 双智能体研究（Codex + Claude 并行调研）
- `cpb sdd init` — 规格驱动开发骨架（Spec-Driven Development）
- `cpb index refresh` — 项目代码索引和依赖图
- `cpb github bind` / `cpb github connect` — 绑定项目到 GitHub 仓库并配置 GitHub 应用
- `cpb daemon start` — 启动队列工作进程，实现无人值守议题驱动工作
- `cpb ui` — 本地 Web 界面，用于项目和任务管理

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
# 项目管理
cpb init <path> [name]             # 初始化项目（省略名称时自动推断）
cpb attach [path] [name]           # 附加项目到 Hub
cpb list                           # 列出项目
cpb status <project>               # 项目状态

# 流水线与单阶段
cpb run "<task>" [--project <id>]  # 通过完整流水线运行任务
cpb pipeline <project> "<task>" [retries]  # 完整流水线（显式指定项目）
cpb plan <project> "<task>"        # 仅 Codex 规划
cpb execute <project> <plan-id>    # 仅 Claude 执行
cpb verify <project> <id>          # 仅 Codex 验证
cpb research <project> "<task>"    # 双智能体研究（Codex + Claude 并行调研）
cpb review <project> [id]          # 审查交付物

# 多阶段进化与规格驱动
cpb evolve-multi [--once|--scan|--continuous]  # 多阶段进化
cpb sdd <init|bootstrap|verify|drift> <project> # 规格驱动开发

# 代码索引
cpb index <status|refresh|graph|impact|context-pack> <project>  # 代码索引与依赖图

# 任务管理
cpb jobs [reconcile|cleanup|report]  # 任务管理
cpb artifacts <job-id> [--json]      # 列出任务产物
cpb verdict <job-id> [--json]        # 显示任务判定结果
cpb repair <project> <job-id> [--agent <name>]  # 重试失败阶段
cpb cancel <project> <jobId> [reason]           # 取消运行中任务
cpb redirect <project> <jobId> "<msg>" [reason] # 重定向任务

# 清理与恢复
cpb gc [--dry-run]                 # 清理过期任务 + 孤立租约 + 污染文件
cpb recover [--dry-run]            # gc 别名

# 审计与合并
cpb diff <project>                 # Git diff
cpb audit <project> <job-id>       # 导出审计包
cpb merge-preview <project> <ref> [--base <branch>]  # 预览合并

# Hub 与守护进程
cpb hub [status|start|stop|projects|...]  # Hub 管理
cpb daemon [start|status|stop]     # 队列守护进程
cpb coderag [status|start|stop]    # CodeRAG MCP 服务器

# GitHub 集成
cpb github bind <proj> <owner/repo>  # 绑定项目到 GitHub 仓库
cpb github connect [options]         # 配置 GitHub 应用凭据
cpb github doctor [--json]           # 检查 GitHub 集成健康状态

# 设置与诊断
cpb demo [--json]                  # 本地模拟演示（无需密钥）
cpb setup [--recommended|--interactive|--json]  # 安装向导
cpb agents [list|detect|install|test]  # 智能体网关管理
cpb auth [status]                  # 服务提供商认证检查
cpb doctor [--json]                # 健康检查
cpb health-check                   # HTTP + 测试 + 构建检查
cpb profile [list|show|use]        # 配置文件管理
cpb wiki [lint|list]               # Wiki 操作
cpb release <list|use|install|doctor|gc>  # 版本管理
cpb install-bin                    # 安装 cpb 到 PATH
cpb ui [--port] [--host]           # 启动 Web 界面
cpb version                        # 显示版本
```

## 架构

```text
cpb (命令行入口, Node.js)
|-- bridges/                # ACP 桥接层 + 运行时
|   |-- acp-client.mjs      # ACP 标准输入输出 JSON-RPC 客户端
|   |-- run-phase.mjs       # 单阶段运行器（规划/执行/验证）
|   |-- run-pipeline.mjs    # 完整流水线编排器
|   |-- job-runner.mjs      # 持久化任务执行器（租约心跳）
|   `-- supervisor-loop.mjs # 无人值守监管器
|-- cli/commands/           # 命令行命令模块
|-- server/                 # Fastify REST + WebSocket 后端
|-- web/                    # React 19 + Vite 前端
`-- wiki/                   # 共享记忆文件系统
    `-- projects/{name}/
        |-- inbox/          # Codex 写入（规划、评审）
        `-- outputs/        # Claude 写入交付物，Codex 写入判定结果
```

## ACP 连接

智能体通过 ACP 标准输入输出（JSON-RPC）连接。默认适配器：

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

## 精简计划校验

精简计划限制 80 行，必须包含 `Affected Files`、`Tests`、`Risk` 段落。

- **默认**：违规记录警告，执行继续。
- **严格模式** (`CPB_LIGHT_PLAN_STRICT=1`)：违规直接失败。

```bash
CPB_LIGHT_PLAN_STRICT=1   # 精简计划约束违规时失败
```

## 持久化任务

无人值守模式使用持久化任务，支持事件日志、租约心跳、任务工作树和监管器恢复。

```bash
cpb jobs                     # 列出持久化任务
cpb jobs reconcile           # 标记过期任务为失败
cpb gc                       # 清理过期任务 + 孤立租约
```

## 系统要求

- **Node.js 20+**：命令行工具和桥接层运行时
- **Codex ACP 适配器**：`codex-acp` 或 `npx -y @zed-industries/codex-acp`
- **Claude ACP 适配器**：`claude-agent-acp` 或 `npx -y @agentclientprotocol/claude-agent-acp`
- **智能体登录/API 密钥**：由各适配器自行处理

## 设计原则

1. **本地优先** — 一切运行在你的机器上；服务提供商适配器各自管理认证。
2. **角色分离** — Codex 负责规划和验证，Claude 负责执行。
3. **Wiki 隔离** — inbox/outputs 边界将未验证内容与已验证内容分离。
4. **文件通信** — 双方读写可检查的本地文件。
5. **协议复用** — 无自定义智能体运行时，在现有适配器上叠加 CPB 指令。

## 安全

CPB 使用服务提供商原生认证，不存储服务提供商令牌，拦截任务输入和产物中的密钥。完整安全模型参见 [docs/security/codepatchbay-gateway-security.md](docs/security/codepatchbay-gateway-security.md)，涵盖安装安全、密钥脱敏、即时通讯密钥禁止、webhook 签名验证、工作树隔离、验证器约束和草稿 PR 策略。
