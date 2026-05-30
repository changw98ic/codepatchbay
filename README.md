# CodePatchBay

[![npm version](https://img.shields.io/npm/v/codepatchbay.svg)](https://www.npmjs.com/package/codepatchbay) [English](README.en.md)

**统筹 coding agents 的 AI 项目经理。**

给它一个任务或 GitHub Issue，它负责拆解、分派、验收，并把结果整理成可审查的 PR。

```text
Issue / 任务 → CodePatchBay → 分派 coding agents → 验证通过的 PR
```

CodePatchBay 不替代 Claude Code、Codex 或其他 coding agents。它管理它们。

## 为什么 coding agents 需要项目经理

Coding agents 擅长写代码，但真正的工程工作不只是代码生成。一个完整的编码工作流还需要：

- **任务接收** — 理解需求、拆解工作
- **规划** — 确定改动范围和风险
- **分派** — 把工作交给合适的 agent
- **跟踪** — 收集产物、记录进度
- **验证** — 审查变更是否正确
- **交付** — 准备 PR 供人类最终审查

CodePatchBay 提供的就是这层协调。

## 它怎么工作

```text
任务或 GitHub Issue
        ↓
CodePatchBay 项目经理
        ↓
  拆解计划 → 分派 coding agent → 收集变更 → 验证结果 → 准备 PR
        ↓
  Codex · Claude Code · 其他 coding agents
        ↓
  人类审查并合并
```

每一步都产生本地产物（Markdown 文件），你可以在信任最终变更之前审查每一个环节。

## 快速开始

### 从 npm 安装（推荐）

npm 包名：[`codepatchbay`](https://www.npmjs.com/package/codepatchbay)

```bash
npm install -g codepatchbay
cpb setup --recommended        # 检测工具、安装 agents、运行健康检查
cpb demo                       # 本地演示，无需 API 密钥
cd your-project
cpb init .                     # 注册项目
cpb run "fix failing tests"    # 提交任务，CodePatchBay 会完成剩下的
```

免安装试用：

```bash
npx codepatchbay demo
```

### 从源码安装

```bash
git clone https://github.com/changw98ic/codepatchbay.git
cd codepatchbay
sh scripts/install.sh
```

## 给 CodePatchBay 一个任务

```bash
# 注册你的项目
cpb init .

# 提交一个任务
cpb run "add dark mode toggle to the settings page"
```

CodePatchBay 会：

1. 分析任务，生成实施计划
2. 把执行工作分派给 coding agent
3. 收集变更和产物
4. 验证结果是否正确
5. 准备 PR 步骤

```bash
# 查看进展
cpb status myproj

# 查看产物
cpb artifacts <job-id>

# 查看验证结果
cpb verdict <job-id>
```

## GitHub Issue 到 PR

连接 GitHub 后，给 Issue 打上 `cpb` 标签，CodePatchBay 自动接管：

```bash
cpb github bind myproj owner/repo
cpb github connect --app-id 123 --webhook-secret-ref env:CPB_GITHUB_WEBHOOK_SECRET
cpb github doctor                # 验证通信正常
cpb daemon start                 # 启动 worker
```

给 Issue 打 `cpb` 标签 → 自动规划 → 分派执行 → 验证 → 创建草稿 PR。

## 支持的 Coding Agents

| Agent | 角色 |
|-------|------|
| Claude Code | 执行代码变更、修复 bug |
| Codex | 规划、验证、审查 |
| OpenCode | 开源替代 agent |
| 自定义 Agent | 通过 model profile 接入任何 ACP 兼容 agent |

CodePatchBay 把这些 agents 组织成可审查的工程流程。你可以配置哪个 agent 负责哪个阶段：

```bash
# 用 mimo 模型做规划和验证，Claude 做执行
cpb config myproj --plan-agent claude --plan-model mimo
cpb config myproj --execute-agent claude
cpb config myproj --verify-agent claude --verify-model mimo
```

## 功能

- **任务管理** — 从 CLI 或 GitHub Issue 接收任务，拆解工作
- **智能分派** — 把规划、执行、验证分给最合适的 agent
- **产物追踪** — 每一步产生可审查的本地产物
- **结果验证** — 变更必须通过验证才能进入 PR
- **GitHub 集成** — Issue 标签触发、草稿 PR、webhook 连接
- **Web UI** — 本地界面查看项目和任务
- **多 Agent 支持** — Codex、Claude Code、OpenCode 及自定义 agent
- **双 Agent 研究** — 两个 agent 并行调研，合并结论
- **规格驱动开发** — SDD 骨架，从 spec 到代码
- **代码索引** — 项目依赖图和影响分析
- **持久化任务** — 断点恢复、租约心跳、无人值守运行

## 命令

```bash
# 项目管理
cpb init <path> [name]             # 初始化项目
cpb attach [path] [name]           # 附加项目到 Hub
cpb list                           # 列出项目
cpb status <project>               # 项目状态

# 提交任务
cpb run "<task>" [--project <id>]  # 提交任务（完整流程）
cpb pipeline <project> "<task>" [retries]  # 完整流程（显式项目）
cpb plan <project> "<task>"        # 仅规划
cpb execute <project> <plan-id>    # 仅执行
cpb verify <project> <id>          # 仅验证
cpb research <project> "<task>"    # 双 agent 研究
cpb review <project> [id]          # 审查交付物

# 多阶段与 SDD
cpb evolve-multi [--once|--scan|--continuous]  # 多阶段进化
cpb sdd <init|bootstrap|verify|drift> <project> # 规格驱动开发

# 代码索引
cpb index <status|refresh|graph|impact|context-pack> <project>

# 任务管理
cpb jobs [reconcile|cleanup|report]
cpb artifacts <job-id> [--json]
cpb verdict <job-id> [--json]
cpb repair <project> <job-id> [--agent <name>]
cpb cancel <project> <jobId> [reason]
cpb redirect <project> <jobId> "<msg>" [reason]

# 清理
cpb gc [--dry-run]
cpb recover [--dry-run]

# 审计与合并
cpb diff <project>
cpb audit <project> <job-id>
cpb merge-preview <project> <ref> [--base <branch>]

# GitHub
cpb github bind <proj> <owner/repo>
cpb github connect [options]
cpb github doctor [--json]

# Hub 与守护进程
cpb hub [status|start|stop|projects|...]
cpb daemon [start|status|stop]
cpb codegraph [status|start|stop]

# 设置与诊断
cpb demo [--json]
cpb setup [--recommended|--interactive|--json]
cpb agents [list|detect|install|test]
cpb config <project> --plan-agent <name> --plan-model <profile>
cpb auth [status]
cpb doctor [--json]
cpb health-check
cpb profile [list|show|use]
cpb model-profile add --name <n> --agent <a> --env KEY=VALUE
cpb wiki [lint|list]
cpb release <list|use|install|doctor|gc>
cpb ui [--port] [--host]
cpb version
```

## 设计原则

1. **项目经理角色** — 不替代 coding agents，而是协调它们完成完整的工程工作流
2. **人类最终审查** — 所有变更经过验证后仍需人类审查才能合并
3. **本地优先** — 一切运行在你的机器上，不需要托管服务
4. **产物可审查** — 每一步产生本地文件，你可以在任何环节介入
5. **Agent 可组合** — 任何 ACP 兼容的 coding agent 都可以接入

## 安全

CodePatchBay 使用各 agent 的原生认证，不存储 provider token，拦截任务输入和产物中的密钥。完整安全模型参见 [docs/security/](docs/security/)，涵盖安装安全、密钥脱敏、webhook 签名验证、工作树隔离和草稿 PR 策略。

## 系统要求

- **Node.js 20+**
- 至少一个 coding agent（Claude Code、Codex、或其他 ACP 兼容 agent）

## License

[AGPL-3.0](LICENSE) — 免费使用和修改，但衍生作品必须开源。商业授权可联系作者。
