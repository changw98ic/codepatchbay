# CodePatchbay — Codex + Claude Code ACP Workflow

> Codex 做规划验证，Claude Code 做执行，ACP 做统一连接层，Wiki 做共享记忆。

## 项目概览

CodePatchbay 是一个 multi-agent 工作流编排系统。通过 ACP (Agent Client Protocol) stdio 协议连接 Codex 和 Claude Code，实现 plan → execute → verify 的自动化流水线。支持手动逐步、分屏协作、全自动流水线三种使用模式，以及基于 durable event log 的 24h 无人值守模式。

## 架构

```
cpb (CLI入口, Bash)
├── bridges/               # 调度脚本 + ACP client
│   ├── common.sh          # 共享函数库 (ID生成、日志、状态、RTK prompt构建)
│   ├── acp-client.mjs     # ACP stdio JSON-RPC client (Node.js)
│   ├── codex-plan.sh      # Codex 规划 bridge
│   ├── claude-execute.sh  # Claude 执行 bridge
│   ├── codex-verify.sh    # Codex 验证 bridge
│   ├── run-pipeline.sh    # 全自动流水线 (plan→execute→verify+retry)
│   ├── job-runner.mjs     # Durable job 单步执行器 (lease heartbeat)
│   ├── supervisor-loop.mjs# 无人值守 supervisor
│   └── init-project.sh    # 项目初始化
├── server/                # Fastify REST + WebSocket 后端
│   ├── index.js           # 入口 (Fastify + WS + file watcher)
│   ├── routes/projects.js # 项目 CRUD API
│   ├── routes/tasks.js    # 任务触发 API
│   └── services/
│       ├── event-store.js # JSONL event log (append-only, materialize)
│       ├── job-store.js   # Job lifecycle (create/phase/complete/fail/block)
│       ├── lease-manager.js # 分布式 lease (atomic write + lock dir)
│       └── supervisor.js  # Recovery: stale lease → resumable job
├── web/                   # React 19 + Vite 前端
│   └── src/
│       ├── App.jsx        # Router + sidebar layout
│       ├── pages/         # Dashboard, Project, NewTask
│       └── hooks/         # WebSocket hook
├── wiki/                  # 共享记忆文件系统
│   ├── schema.md          # Wiki 宪法 (命名规则、权限、不可变规则)
│   └── system/            # 全局文档 (handshake, dashboard, team architecture等)
├── profiles/              # Agent 角色定义 (codex/soul.md, claude/soul.md)
└── templates/handoff/     # 交接文档模板
```

## 技术栈

| 层 | 技术 |
|---|---|
| CLI | Bash (入口 `cpb`) |
| Bridge 脚本 | Bash + Node.js (mjs) |
| ACP 通信 | JSON-RPC over stdio |
| 后端 | Fastify 5 + @fastify/websocket + chokidar |
| 前端 | React 19 + React Router 7 + Vite 6 |
| 持久化 | 文件系统 (JSONL events, JSON state, Markdown wiki) |
| 并发控制 | mkdir-based atomic locks, lease with heartbeat |

## 核心数据流

```
Codex (plan) → wiki/projects/{name}/inbox/plan-{id}.md
                 ↓
Claude (execute) → wiki/projects/{name}/outputs/deliverable-{id}.md
                 ↓
Codex (verify) → wiki/projects/{name}/outputs/verdict-{id}.md
```

Wiki 写入权限隔离：Codex 写 `inbox/` 和 `outputs/verdict-*`，Claude 写 `outputs/`（除 verdict）。

## 关键约定

### ACP 连接
- Codex adapter: `codex-acp` 或 `npx -y @zed-industries/codex-acp`
- Claude adapter: `claude-agent-acp` 或 `npx -y @agentclientprotocol/claude-agent-acp`
- 环境变量覆盖: `CPB_ACP_{CODEX|CLAUDE}_{COMMAND|ARGS}`, `CPB_ACP_CWD`, `CPB_ACP_TIMEOUT_MS`
- `CPB_ACP_TIMEOUT_MS` 是空闲超时（activity-based），设 `0` 禁用

### 权限约束 (`--dangerous` 移除)
- Codex plan: 只写 `inbox/`，不执行终端命令
- Claude execute: 只写项目代码和 `outputs/deliverable-*`
- Codex verify: 只写 `outputs/verdict-*`，不修改代码

### Durable Job 系统
- Event log: `cpb-task/events/{project}/{jobId}.jsonl` (append-only)
- Lease: `cpb-task/leases/{leaseId}.json` (TTL + heartbeat + atomic lock dir)
- State: `cpb-task/state/pipeline-{project}.json`
- Worktree: `cpb-task/worktrees/` (task-level git worktree)
- Supervisor 通过 `recoverJobs()` 检测 stale lease → 恢复执行

### Wiki 原子性
- Handoff 文件必须包含 `## Handoff` 头和 `## Acceptance-Criteria` 尾
- 原子 ID 生成: mkdir lock + placeholder file 防止碰撞
- 原子日志追加: mkdir lock

### Verdict 格式 (机器解析)
```
VERDICT: <PASS|FAIL|PARTIAL>
```
Pipeline 通过 grep 此行决定下一步。

## 开发命令

```bash
# CLI
./cpb init /path/to/project my-project
./cpb plan my-project "Add dark mode"
./cpb execute my-project 001
./cpb verify my-project 001
./cpb pipeline my-project "Add unit tests" 3
./cpb status my-project
./cpb list
./cpb jobs
./cpb supervisor
./cpb wiki lint

# Web UI (启动后端 + 前端)
./cpb ui [--port PORT] [--host HOST]

# 后端单独开发
cd server && npm run dev    # node --watch index.js

# 前端单独开发
cd web && npm run dev       # vite dev server :5173

# 测试
cd /path/to/cpb && node --test tests/*.mjs     # 单元测试
bash tests/cpb-jobs.test.sh                     # Job 系统集成测试
bash tests/cpb-bridges.test.sh                  # Bridge 集成测试
```

## 测试结构

- `tests/*.test.mjs` — Node.js 内置测试运行器的单元测试
- `tests/cpb-jobs.test.sh` — Job/lease/event 系统的 Bash 集成测试
- `tests/cpb-bridges.test.sh` — Bridge 脚本的 Bash 集成测试
- `tests/fixtures/` — fake ACP agent stub
- `tests/helpers/` — 测试工具 (如 spawn-file)

## API 端点

```
GET  /api/projects              # 列出所有项目
GET  /api/projects/:name        # 项目详情
GET  /api/projects/:name/inbox  # inbox 文件列表
GET  /api/projects/:name/outputs # outputs 文件列表
GET  /api/projects/:name/files/* # 读取项目文件 (防 path traversal)
POST /api/projects/init         # 初始化新项目
GET  /api/tasks/running         # 运行中任务
GET  /api/tasks/durable         # Durable jobs
POST /api/tasks/:name/plan      # 触发 Codex 规划
POST /api/tasks/:name/execute   # 触发 Claude 执行
POST /api/tasks/:name/verify    # 触发 Codex 验证
POST /api/tasks/:name/pipeline  # 触发全自动流水线
WS   /ws                        # WebSocket (实时事件推送)
```

## 注意事项

- 项目名只允许 `[a-zA-Z0-9-]`，通过 `require_safe_name` 校验
- ACP client (`bridges/acp-client.mjs`) 必须有执行权限
- 后端 CORS 仅允许 `localhost:5173` 和 `127.0.0.1:5173`
- Lease 默认 TTL 120s，heartbeat 间隔 TTL/3
- Pipeline 的 total timeout 通过 watchdog 写 state flag，不杀进程
- `wiki/schema.md` 是 Wiki 宪法，所有 agent 必须遵守其写入权限和不可变规则
