# CodePatchBay

[![npm version](https://img.shields.io/npm/v/codepatchbay.svg)](https://www.npmjs.com/package/codepatchbay) [English](README.en.md)

**本地/私有化的 coding-agent 交付运行时。**

把任务或 GitHub Issue 交给 CodePatchBay。它通过 ACP 或 CLI gateway 调用 Codex、Claude Code、OpenCode 或其他受支持 agent，拆解计划、执行阶段、记录证据、验证结果，并生成可审查的本地产物或草稿 PR。

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
cd your-project
cpb quickstart --demo --project-path . --project-name your-project  # 初始化本地演示，无需 API 密钥
cpb run "fix failing tests" --project your-project                # 提交到完整流程队列
```

免安装试用：

```bash
npx codepatchbay quickstart --demo --project-path . --project-name cpb-demo
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
cpb init . myproj

# 提交一个任务
cpb run "add dark mode toggle to the settings page" --project myproj
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

# 查看交付产物和验证结论（位于注册项目运行时的 wiki/outputs 目录）
cpb outputs myproj
```

## GitHub Issue 到草稿 PR

配置 GitHub transport 和 webhook 后，给 Issue 打上 `cpb` 标签即可进入规划、执行和验证流程；默认先生成 draft PR dry-run preview：

```bash
cpb github bind myproj owner/repo
cpb github connect --app-id 123 --webhook-secret-ref env:CPB_GITHUB_WEBHOOK_SECRET
cpb github doctor                # 验证通信正常
cpb hub start                    # 启动 Hub 调度器
```

注意：当前 Hub HTTP server 不会仅因 `cpb hub start` 就暴露通用 GitHub webhook 路由；必须使用已经接线的 transport/外部 webhook 入口，才能让 Issue 标签触发上述流程。

Hub 默认只监听回环地址，但回环地址也不是身份边界：启动时必须配置至少 32 字节的
`CPB_HUB_BEARER_TOKEN`、`CPB_HUB_SERVICE_TOKENS_FILE` 或 `CPB_HUB_OIDC_CONFIG_FILE`。
仅本地开发可显式设置 `CPB_HUB_ALLOW_ANONYMOUS_DEV=1`；该模式只接受回环绑定，且 readiness 不会判定为商用就绪。
若设置非回环 `CPB_HOST`，应在 TLS 反向代理之后部署。只有明确位于受保护网络时，才可同时设置
`CPB_HUB_ALLOW_INSECURE_HTTP=1` 允许非回环明文 HTTP。GitHub 评论触发的
`/cpb run` 只接受仓库 `OWNER`、`MEMBER` 或 `COLLABORATOR`。

企业部署可设置绝对路径 `CPB_HUB_SERVICE_TOKENS_FILE`，使用只保存 SHA-256 的具名服务令牌，
并按 `hub:health`、`hub:read`、`hub:admin` scope 和项目白名单授权。旧
`CPB_HUB_BEARER_TOKEN` 继续作为全局 `legacy-admin` 兼容凭证。权限文件必须是非符号链接的私有文件
（POSIX 下不得向组或其他用户开放，例如 `0600`）。通过原子替换该文件可在下一次请求时热加载撤销、轮换和
授权变更，无需重启；文件缺失、损坏或不安全时请求会以 `503 HUB_AUTH_CONFIGURATION_UNAVAILABLE`
失败关闭，修复后自动恢复。完整格式、错误合同和轮换说明见
[`docs/security/cpb-hub-service-tokens.md`](docs/security/cpb-hub-service-tokens.md)。

企业 IdP 可通过私有 `CPB_HUB_OIDC_CONFIG_FILE` 接入 RFC 9068 JWT access token。Hub 严格校验
`typ`、算法、issuer、audience、有效期和 JWKS 签名，再用本地 group→scope/project 规则授权；OIDC
ID Token、opaque token 和未映射组不会获得 API 权限。JWKS 支持有界缓存、并发去重和受限的未知 `kid`
刷新，过期后 IdP 不可用时以 `503 HUB_IDENTITY_PROVIDER_UNAVAILABLE` 失败关闭。完整配置、轮换和限制见
[`docs/security/cpb-hub-oidc.md`](docs/security/cpb-hub-oidc.md)。

Hub 会在响应前把请求 ID、主体、路径（不含 query）、状态、scope 判定和错误码写入持久 SHA-256
hash-chain 访问审计；写入或完整性检查失败时请求返回 `503 HUB_ACCESS_AUDIT_UNAVAILABLE`，不会静默漏记。
日志默认上限 256 MiB，`cpb doctor` 会提前告警，也可用 `cpb hub verify-access-audit` 离线验证。
容量接近上限时可在停止 Hub 后运行 `cpb hub archive-access-audit --output PATH`；归档先完整发布再重置
活动日志，使用持久 journal 自动恢复中断事务，生产环境可用
`CPB_HUB_ACCESS_AUDIT_ARCHIVE_SIGNING_KEY` 添加 HMAC-SHA256 签名。
该本地链不能替代独立 SIEM/WORM，信任边界和保留要求见
[`docs/security/cpb-hub-access-audit.md`](docs/security/cpb-hub-access-audit.md)。

项目注册表的所有生产写路径使用带单调 `revision` 的跨进程事务；陈旧快照返回
`HUB_REGISTRY_CONFLICT`，不会覆盖其他进程已经提交的状态。默认本地文件模式使用所有权 token、续租、
死进程恢复和提交前所有权复核，保证范围限于同一主机。需要跨主机共享注册表时，可配置私有
`CPB_HUB_STATE_REDIS_CONFIG_FILE`，通过 Redis 原子 CAS 拒绝恢复后的旧 writer；leader lease、单调 epoch
、队列、assignment、worker registry 与 worker inbox 也存入同一个 Redis hash；leader 写入会在存储层
校验 fence，worker inbox 通过一次性 claim token 原子认领。远程连接强制
`rediss://`，Hub 启动和 `cpb doctor` 都会执行有界预检。凭据可在同一 endpoint/database/key 上轮换，
切换后端身份必须先停止全部控制面进程。lease、job 和审计状态仍没有完整分布式事务，
`cpb doctor` 会继续报告 `activeActiveSafe: false`，因此还不能运行多个 active scheduler。部署、迁移、备份和
拓扑限制见 [`docs/security/cpb-hub-redis-state.md`](docs/security/cpb-hub-redis-state.md)，本地事务细节见
[`docs/architecture/cpb-hub-registry-consistency.md`](docs/architecture/cpb-hub-registry-consistency.md)。

默认模式下 Hub 与所有注册项目的运行状态都位于 Hub 根目录内。配置 Redis 注册表后，该注册表位于
外部服务，当前 Hub 备份不会包含它，必须使用 Redis 自身的备份恢复并核对 revision 和项目集合。
文件系统备份和恢复必须离线执行；快照包含
SHA-256 清单，恢复前会完整校验，覆盖已有状态必须显式使用 `--force`，原目录会保留为
`*.pre-restore-*` 回滚副本：

```bash
cpb hub stop
cpb hub backup --output /secure/backups/cpb-2026-07-11
cpb hub verify-backup --input /secure/backups/cpb-2026-07-11
cpb hub restore --input /secure/backups/cpb-2026-07-11 --force
cpb hub recover-restore       # 检查并恢复被中断的恢复事务
```

备份默认要求至少 32 字节、无空白字符的 `CPB_HUB_BACKUP_SIGNING_KEY`，并自动写入
HMAC-SHA256 签名；校验和恢复默认拒绝未签名快照。只有本地开发兼容场景可显式使用
`--allow-unsigned-dev` 创建、校验或恢复未签名快照。签名密钥必须与
快照分开保管，并纳入企业密钥轮换和灾备恢复流程。

备份和恢复会在 Hub 根目录同级位置持有 token 化维护锁，Hub、调度器、worker、队列、项目注册表
和 quota delegate 的写入口都会拒绝并发写入。恢复过程使用持久三阶段日志并在目录 rename 后执行
fsync；进程或主机中断后，下一次 Hub 启动会自动回滚未提交状态或校验已提交的新根。也可以离线运行
`cpb hub recover-restore` 显式执行同一恢复流程。

复制开始前会检查目标文件系统的可用空间，并默认要求操作完成后仍保留 256 MiB。可用
`CPB_HUB_MIN_FREE_BYTES` 设置其他非负字节数。备份 stage 使用与 Hub 和输出路径绑定的所有权标记；
后续备份只会回收能够证明由同一 Hub/输出事务留下的中断 stage，遇到无标记或不匹配目录会拒绝删除。

命令/测试类验收探针不再执行模型生成的 `expectedEvidence` 文本。需要此类探针的项目必须由维护者在
仓库 `HEAD` 提交 `.cpb/verification-probes.json`，以结构化 `executable`/`args` 绑定 `predicateId`；
未配置时会留下可审计的失败证据，不会回退到 shell 执行。格式和边界见
[`docs/security/cpb-agent-secret-boundary.md`](docs/security/cpb-agent-secret-boundary.md)。

在已配置的 GitHub transport 中，Issue 标签可触发自动规划 → 分派执行 → 验证 → draft PR dry-run preview；live 草稿 PR 创建需要显式 opt-in。

## 支持的 Coding Agents

CodePatchBay 通过 ACP 或 CLI gateway 连接 coding agents。Claude Code、Codex 等 ACP agent，以及 OpenCode 等 CLI agent，都可以按各自 gateway 接入。工程工作流暴露 5 个语义角色，其中常规 agent 路由覆盖 planner、executor、verifier、reviewer，remediator 由补救阶段处理：

| 语义角色 | 职责 | 产物 |
|---------|------|------|
| `planner` | 分析任务、生成实施计划 | `inbox/plan-*` |
| `executor` | 执行代码变更、修复 bug | `outputs/deliverable-*` |
| `verifier` | 验证结果、给出判定 | `outputs/verdict-*` |
| `reviewer` | 审查交付物 | review 产物 |
| `remediator` | 补救失败（debug/lint/tdd/test） | remediation 产物 |

planner、executor、verifier、reviewer 通过 `core/agents/routing.ts` 映射到对应阶段；remediator 由补救阶段处理。你可以在提交任务时指定哪个 agent + 模型负责哪个阶段：

```bash
# 为不同阶段指定 agent；所有阶段共用一个模型 profile
cpb run "add unit tests for auth" \
  --plan-agent claude --execute-agent claude \
  --verify-agent claude --model mimo
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
cpb pipeline <project> "<task>" [--retries <n>]  # 完整流程（显式项目）
                                  #   可加 --plan-agent/--execute-agent/--verify-agent
                                  #   及 --model
cpb review <project> [id]          # 审查交付物
cpb retry <project> <job-id> [--agent <name>]  # 重试失败任务

# 任务管理
cpb jobs report [--json]           # job 运行报告 (reconcile/cleanup/gc 已移除)
cpb jobs worktrees                # 列出 task-level git worktrees
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
cpb agents [list|detect|install|upgrade|test]
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
5. **Agent 可组合** — 受支持的 ACP 或 CLI coding agent 都可以接入

## 安全

CodePatchBay 使用各 agent 的原生认证，不存储 provider token，拦截任务输入和产物中的密钥。

- **不复制 provider token** — API key 和 OAuth token 保留在 agent 进程环境中，CPB 从不写入磁盘。
- **密钥提交被禁止** — 不允许通过 Slack、Discord、GitHub 评论或任何 IM 渠道提交密钥。
- **Webhook 签名验证** — 当前运行链路明确支持 GitHub webhook 的 HMAC-SHA256；Slack/Discord ingress 不在当前 Hub HTTP 路由中。
- **草稿 PR 策略** — flagship finalizer 的 live PR 路径以 draft 创建且不自动合并；默认流程先生成 dry-run preview。
- **工作树隔离** — 任务在独立 git worktree 中执行，不修改主分支。

完整安全模型参见 [Security Documentation](docs/security/codepatchbay-gateway-security.md)，涵盖安装安全、密钥脱敏、webhook 签名验证、工作树隔离、角色权限矩阵和草稿 PR 策略。Agent 进程隔离边界分析参见 [Agent Secret Boundary](docs/security/cpb-agent-secret-boundary.md)。

## 系统要求

- **Node.js 20+**
- **npm 和 git**（GitHub 集成另需 `gh` 或已配置的 GitHub transport）
- 至少一个 coding agent（Claude Code、Codex、OpenCode 或其他受支持 agent）

## 开发与验证

```bash
npm ci
npm run typecheck:node
npm test
npm run verify:release-gate
```

## License

[AGPL-3.0](LICENSE) — 免费使用和修改，但衍生作品必须开源。商业授权可联系作者。
