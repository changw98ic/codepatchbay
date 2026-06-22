# CodePatchBay

[![npm version](https://img.shields.io/npm/v/codepatchbay.svg)](https://www.npmjs.com/package/codepatchbay) [English](README.en.md)

**本地/私有化的 coding-agent 交付运行时。**

把任务或 GitHub Issue 交给 CodePatchBay。它通过 ACP 调用 Codex、Claude Code 或其他 agent，拆解计划、执行阶段、记录证据、验证结果，并生成可审查的本地产物或草稿 PR。

```text
Issue / 任务 → CodePatchBay Runtime → coding agents → 有证据的可审交付
```

CodePatchBay 不替代 Claude Code、Codex 或其他 coding agents。它管理 agent 之间的交接、状态、证据和产物。

## 当前稳定化周期

CodePatchBay 当前冻结横向能力扩张，优先清偿执行内核和发布门稳定性。稳定化周期内不新增 agent 类型、workflow 类别、scheduler 特性或 provider 集成；优先完成：

- 执行内核的恢复边界、事件顺序和 provider handoff 安全拆分
- 生产默认 checklist decomposition 合约测试和 worker 路径 E2E
- managed-worker / ACP 隔离证据
- 默认无外部副作用的 GitHub draft PR dry-run finalizer
- `core/engine` 类型门禁和 broad-any 债务守卫

发布级完成标准记录在 `docs/product/cpb-stabilization-baseline-2026-06-22.md` 和 `docs/product/cpb-flagship-validation-gate.md`；后续 PR 必须说明是否触及这些门禁，并在相关变更中运行 `npm run verify:release-gate`。

## 为什么需要交付运行时

Coding agents 擅长写代码，但真实工程交付不只是代码生成。一个可审查的编码工作流还需要：

- **任务接收** — 理解需求、拆解工作
- **规划** — 确定改动范围和风险
- **分派** — 把工作交给合适的 agent
- **跟踪** — 收集产物、记录进度
- **验证** — 用证据判断变更是否正确
- **交付** — 生成本地产物或草稿 PR，供人类最终审查

CodePatchBay 提供的就是这层本地运行时和审计层。

## 它怎么工作

```text
任务或 GitHub Issue
        ↓
CodePatchBay Runtime
        ↓
  拆解计划 → 分派 agent → 记录事件和产物 → 验证证据 → 交付可审结果
        ↓
  Codex · Claude Code · 其他 coding agents
        ↓
  人类审查并合并
```

每一步都产生本地产物（Markdown、JSONL、checklist、evidence ledger），你可以在信任最终变更之前审查每一个环节。

## 快速开始

### 从 npm 安装（推荐）

npm 包名：[`codepatchbay`](https://www.npmjs.com/package/codepatchbay)

```bash
npm install -g codepatchbay
cpb setup --recommended        # 检测工具、安装 agents、运行健康检查
cpb quickstart --demo          # 本地演示，无需 API 密钥
cd your-project
cpb init .                     # 注册项目
cpb run "fix failing tests"    # 提交任务，CodePatchBay 会完成剩下的
```

免安装试用：

```bash
npx codepatchbay quickstart --demo
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
5. 生成本地交付产物或草稿 PR 步骤

```bash
# 查看进展
cpb status myproj

# 查看交付产物和验证结论（位于项目 outputs 目录）
cpb outputs myproj
```

## GitHub Issue 到草稿 PR

连接 GitHub 后，给 Issue 打上 `cpb` 标签，CodePatchBay 自动接管：

```bash
cpb github bind myproj owner/repo
cpb github connect --app-id 123 --webhook-secret-ref env:CPB_GITHUB_WEBHOOK_SECRET
cpb github doctor                # 验证通信正常
cpb hub start                    # 启动 Hub 调度器
```

给 Issue 打 `cpb` 标签 → 自动规划 → 分派执行 → 验证 → 生成 draft PR dry-run preview；live 草稿 PR 创建需要显式 opt-in。

## 支持的 Coding Agents

CodePatchBay 通过 ACP 协议中立地连接 coding agents，任何 ACP 兼容 agent（Claude Code、Codex、OpenCode 或自定义）都可以接入。它把工程工作流拆成 5 个语义角色，由 agent 路由映射：

| 语义角色 | 职责 | 产物 |
|---------|------|------|
| `planner` | 分析任务、生成实施计划 | `inbox/plan-*` |
| `executor` | 执行代码变更、修复 bug | `outputs/deliverable-*` |
| `verifier` | 验证结果、给出判定 | `outputs/verdict-*` |
| `reviewer` | 审查交付物 | review 产物 |
| `remediator` | 补救失败（debug/lint/tdd/test） | remediation 产物 |

任意 agent 通过 `core/agents/routing.ts` 映射到这些角色。你可以在提交任务时指定哪个 agent + 模型负责哪个阶段：

```bash
# 用 mimo 模型做规划，Claude 做执行和验证
cpb run "add unit tests for auth" \
  --plan-agent claude --plan-model mimo \
  --execute-agent claude \
  --verify-agent claude
```

## 功能

- **任务接收** — 从 CLI 或 GitHub Issue 接收任务，拆解工作
- **角色路由** — 把规划、执行、验证、审查和补救分给合适的 agent
- **证据追踪** — 每一步产生可审查的本地产物和 evidence ledger
- **完成门** — checklist、verdict 和 runtime evidence 通过后才交付
- **GitHub transport** — Issue 标签触发、草稿 PR、webhook 连接
- **多 Agent 支持** — Codex、Claude Code、OpenCode 及自定义 agent
- **持久化任务** — 基于 event log + checkpoint 的断点恢复、多 worker 调度、无人值守运行

## 命令

```bash
# 项目管理
cpb init <path> [name]             # 初始化项目（自动注册到 Hub）
cpb list                           # 列出项目
cpb status <project>               # 项目状态

# 提交任务
cpb run "<task>" [--project <id>]  # 提交任务（完整流程）
cpb pipeline <project> "<task>" [retries]  # 完整流程（显式项目）
                                  #   可加 --plan-agent/--execute-agent/--verify-agent
                                  #   及 --plan-model/--execute-model/--verify-model
cpb review <project> [id]          # 审查交付物
cpb retry <project> <job-id>       # 重试失败任务

# 任务管理
cpb jobs report [--json]           # job 运行报告 (reconcile/cleanup/gc 已移除)
cpb jobs worktrees                # 列出 task-level git worktrees
cpb retry <project> <job-id> [--agent <name>]
cpb cancel <project> <jobId> [reason]
cpb redirect <project> <jobId> "<msg>" [reason]

# 变更查看
cpb diff <project>
cpb inbox <project>                # 查看 inbox 文件
cpb outputs <project>              # 查看 outputs 文件

# GitHub
cpb github bind <proj> <owner/repo>
cpb github connect [options]
cpb github doctor [--json]

# Hub 与调度
cpb hub [status|start|stop|projects|...]

# 设置与诊断
cpb setup [--recommended|--interactive|--json]
cpb agents [list|detect|install|test]
cpb stream [args]                  # 流式数据服务
cpb doctor [--json]
cpb health-check                   # quickstart 别名入口的健康检查
cpb version
```

### Checklist Artifacts

Checklist-aware tasks also produce a frozen acceptance checklist, execution map,
evidence ledger, checklist verdict, and completion gate details. These artifacts
show what was required, what changed, what was verified, and why CPB accepted or
rejected the task.

| Artifact | Description |
|----------|-------------|
| `acceptance-checklist` | Frozen task contract produced before execution |
| `execution-map` | Maps changed files back to checklist items |
| `evidence-ledger` | Replayable evidence claims with worktree identity |
| `checklist-verdict` | Itemized verifier judgment with evidence refs |

Use `cpb inbox <project> outputs` to list deliverables and verdicts for a project,
and `cpb status <project>` to see the latest verdict.

## 设计原则

1. **交付运行时** — 不替代 coding agents，而是管理它们的交接、状态和验收
2. **人类最终审查** — 所有变更经过验证后仍需人类审查才能合并
3. **本地优先** — 一切运行在你的机器上，不需要托管服务
4. **证据可审查** — 每一步产生本地文件，你可以在任何环节介入
5. **Agent 可组合** — 任何 ACP 兼容的 coding agent 都可以接入

## 安全

CodePatchBay 使用各 agent 的原生认证，不存储 provider token，拦截任务输入和产物中的密钥。

- **不复制 provider token** — API key 和 OAuth token 保留在 agent 进程环境中，CPB 从不写入磁盘。
- **密钥提交被禁止** — 不允许通过 Slack、Discord、GitHub 评论或任何 IM 渠道提交密钥。
- **Webhook 签名验证** — GitHub webhook 使用 HMAC-SHA256 验证，Slack 使用请求签名，Discord 使用 Ed25519。
- **草稿 PR 策略** — 所有 PR 以 draft 创建，不自动合并。
- **工作树隔离** — 任务在独立 git worktree 中执行，不修改主分支。

完整安全模型参见 [Security Documentation](docs/security/codepatchbay-gateway-security.md)，涵盖安装安全、密钥脱敏、webhook 签名验证、工作树隔离、角色权限矩阵和草稿 PR 策略。Agent 进程隔离边界分析参见 [Agent Secret Boundary](docs/security/cpb-agent-secret-boundary.md)。

## 系统要求

- **Node.js 20+**
- 至少一个 coding agent（Claude Code、Codex、或其他 ACP 兼容 agent）

## License

[AGPL-3.0](LICENSE) — 免费使用和修改，但衍生作品必须开源。商业授权可联系作者。
