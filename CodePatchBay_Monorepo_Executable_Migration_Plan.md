# CodePatchBay Monorepo 可执行迁移方案

> 文档状态：最终版；已完成独立架构审查、第一轮修复、独立对抗性审查与第二轮修复  
> 基线日期：2026-08-10  
> 仓库基线：`changw98ic/codepatchbay` 当前 `main`  
> 目标版本：建议从 `0.5.x` 稳定化完成后开始，在 `0.6.x` 完成结构迁移  
> 核心原则：单仓库、单安装包、多个本地进程、一套 canonical mutation authority 模型

## 1. 决策摘要

CodePatchBay 应迁移为 npm workspaces Monorepo，但本轮迁移不得把它改造成多仓库、微服务或多个强制安装包。

本方案采用以下最终决策：

1. 保持仓库 `changw98ic/codepatchbay` 不拆分。
2. 保持 npm 包名 `codepatchbay` 和全局命令 `cpb` 不变。
3. 使用 npm workspaces，不在第一阶段引入 Nx、Turborepo、pnpm 或新的发布系统。
4. 内部 workspace 全部设为 `private: true`，暂不单独发布 `@codepatchbay/*`。
5. 发布仍由根包完成，产物统一组装到根目录 `dist/`，避免 packed install 中出现 workspace 运行时解析失败。
6. 先建立合同与依赖边界，再移动运行时代码；禁止一次性全仓搬迁。
7. 新增能力围绕本地 Coding Agent Control Plane：需求澄清、Skill、MCP、Sandbox、Agent、Evidence、UI。
8. MCP Gateway 是独立本地进程；Skill Registry、需求澄清和 Sandbox 策略不放入 Gateway。
9. 保持一个 Control Plane authority，但允许不同 aggregate 使用各自 canonical store；每个 aggregate 只能有一个明确 mutation protocol/owner。
10. 每个迁移阶段必须声明代码、功能、binary 与数据四类回退条件，且保持 `npm install -g codepatchbay` 可用。

## 2. 当前仓库基线

### 2.1 已核实的现状

- 根 `package.json` 当前为单包 `codepatchbay@0.5.0`。
- `cpb` 根启动器固定导入 `./dist/cli/cpb.js`，并设置 `CPB_EXECUTOR_ROOT=dist`。
- `tsconfig.node.json` 以仓库根为 `rootDir`，统一编译 `cli/`、`core/`、`server/`、`runtime/`、`bridges/`、`shared/`、`scripts/` 到 `dist/`。
- `scripts/build-output.mjs` 硬编码上述 source/asset directories，并校验 `dist/cli/cpb.js`、`dist/server/services/executor-root.js` 等产物。
- `package.json#files` 只发布根启动器、`dist/`、`profiles/`、`skills/`、`templates/`、文档和必要 wiki schema。
- 已有 `scripts/e2e-npm-pack.ts`，覆盖 pack、隔离全局安装、doctor、Hub、队列、Worker、流水线和远端交付验证。
- 现有运行时边界已经把 `core`、`server`、`runtime`、`cli`、`bridges`、`shared` 的允许依赖方向写入文档和测试。
- `shared/types.ts` 与 `core/contracts/types.ts` 存在重叠的 `LooseRecord` 合同，说明合同层仍需收敛，但不能在一次 PR 中全量替换。
- README 当前仍声明横向能力冻结，优先稳定执行内核、managed-worker/ACP 隔离、finalizer、类型门禁和 release gate。

### 2.2 迁移不得破坏的不变量

| 不变量 | 验收方式 |
|---|---|
| `npm install -g codepatchbay` 仍只安装一个产品 | 从 `npm pack` tarball 做隔离全局安装 |
| `cpb --version`、`cpb doctor --json` 可用 | pack smoke test |
| `cpb setup` 不要求用户安装内部 workspace | 隔离 HOME 验证 |
| 每个 aggregate 只有一个明确 mutation authority；managed Worker 不得意外直写 | 边界测试 + broker/direct-mode 集成测试 |
| Worker 只能消费冻结执行清单 | contract test |
| verifier 默认只读且保持独立 | managed-worker E2E + sandbox test |
| 默认 finalizer 不产生外部副作用 | release gate dry-run |
| 旧 `~/.cpb` 数据可继续读取 | migration fixture test |
| Agent 原生认证不被复制到 CPB 配置 | secret-boundary test |

## 3. 目标架构

### 3.1 目标目录

```text
codepatchbay/
├─ apps/
│  ├─ cli/                    # cpb 命令路由与输出适配
│  ├─ hub/                    # 本地 Control Plane、API、调度入口
│  ├─ worker/                 # managed worker 与执行进程入口
│  ├─ tool-gateway/           # 会话级本地 MCP Gateway
│  └─ ui/                     # 本地 Web UI，最后迁移/新增
│
├─ packages/
│  ├─ contracts/              # 版本化 TypeScript 合同与 JSON Schema
│  ├─ core/                   # 纯领域状态机、工作流和规则
│  ├─ execution-policy/       # Skill/MCP/Sandbox/Role 解析
│  ├─ agent-adapters/         # Codex/Claude/OpenCode/ACP/CLI 适配
│  ├─ evidence/               # Trace、Evidence、Verifier 合同与物化
│  ├─ storage/                # Event Store、Registry、锁和原子文件事务
│  └─ api-client/             # CLI/UI/IM 共享的 Hub 类型化客户端
│
├─ resources/
│  ├─ skills/
│  ├─ profiles/
│  ├─ builtin-mcp/
│  └─ templates/
│
├─ scripts/
├─ tests/
├─ docs/
├─ package.json
├─ tsconfig.base.json
└─ package-lock.json
```

这是最终目录，不是第一批 PR 必须一次建完的目录。只有承载真实代码的 workspace 才创建，禁止用空 package 占位。

### 3.2 进程边界

| 进程 | 生命周期 | 权限 | 状态所有权 |
|---|---|---|---|
| CLI | 单次命令 | 用户命令权限 | 不持久化 canonical state |
| Hub | 长驻本地 | Registry、Queue、Event Store、审批 | Control Plane coordinator；持有各 aggregate mutation authority |
| Worker | 每 assignment/受 Hub 管理 | Worktree、Agent、测试、构建 | 写受限产物；业务 mutation 通过有效 authority/broker |
| Tool Gateway | 每 Agent session，默认 stdio | 仅会话 manifest 允许的工具 | 不拥有任务状态 |
| UI | 浏览器 + Hub 静态服务/API | 仅调用 Hub API | 不复制业务状态 |

### 3.3 Canonical authority 与存储所有权

“一个 Control Plane authority”不等于“把所有状态重写进一个 Event Store”。目标模型是 aggregate-specific canonical stores：

| Aggregate | Canonical store | Mutation authority |
|---|---|---|
| Project Registry | `projects.json` 及 registry transaction | Hub registry transaction |
| Queue | Hub queue store | Hub scheduler/API |
| Assignment/Attempt | AssignmentStore | managed mode 经 Worker Broker；standalone mode 经显式 composition authority |
| Job Event/Projection | Project event store | Hub broker 或显式 standalone composition port |
| Artifacts | Attempt/project runtime files | Worker 持有的受限 assignment authority |

Worker 模式必须显式二选一，并由存储层 fencing 保证互斥：

- `managed`：强制 broker-only。Worker 缺少有效 broker capability 时失败关闭，不得静默 fallback 到 direct store。
- `standalone`：只允许本地 composition root 显式签发 `MutationAuthorityV1 { mode: "standalone" }` 后直接访问 store；该模式不能与同一 Hub aggregate 并行写入。

现有 direct-store fallback 在迁移期保留为 legacy 行为，但 Phase 4 完成时必须变成显式模式，不能继续由“broker 不存在”隐式触发。

统一写入权威合同为：

```ts
export interface MutationAuthorityV1 {
  schema: "cpb.mutation-authority.v1";
  aggregateId: string;
  mode: "managed" | "standalone";
  ownerId: string;
  leaseId: string;
  epoch: number;
  issuedAt: string;
  expiresAt: string;
}
```

mode 切换必须在 canonical store 的原子事务中提升 `epoch` 并取得排他 lease。每个 mutation、finalizer 和 migration journal commit 都携带 authority；store 用 compare-and-set 校验当前 `aggregateId + mode + leaseId + epoch`。旧 epoch 无条件拒绝，不能只靠 PID、文件存在或 heartbeat 判定互斥。

### 3.4 强制依赖方向

```text
contracts
   ↓
core / storage
   ↓
execution-policy / evidence
   ↓
agent-adapters
   ↓
apps
```

强制规则：

- `packages/*` 不得导入 `apps/*`。
- `contracts` 不得导入任何 CPB 实现包，不得读文件、网络或启动进程。
- `core` 不得导入 storage、HTTP、CLI、runtime 或具体 Agent Adapter。
- `execution-policy` 输出语义策略，不直接启动 Agent 或 MCP。
- `agent-adapters` 只翻译并执行已解析策略，不决定业务路由。
- `tool-gateway` 不直接导入 Hub 内部服务；只消费 `SessionToolManifest` 并通过审计端口回报事件。
- `ui` 只依赖 `api-client` 与生成的 DTO，不导入 Hub 实现。
- `worker` 不重新读取并合并用户配置，只消费带 hash 的 `ResolvedExecutionProfile`。

允许边矩阵：

| From | contracts | core | storage | execution-policy | evidence | agent-adapters | apps |
|---|---:|---:|---:|---:|---:|---:|---:|
| contracts | — | 否 | 否 | 否 | 否 | 否 | 否 |
| core | 是 | — | 否 | 否 | 否 | 否 | 否 |
| storage | 是 | 是 | — | 否 | 否 | 否 | 否 |
| execution-policy | 是 | 是 | 否 | — | 否 | 否 | 否 |
| evidence | 是 | 是 | 是 | 否 | — | 否 | 否 |
| agent-adapters | 是 | 是 | 否 | 是 | 是 | — | 否 |
| apps | 是 | 是 | 是 | 是 | 是 | 是 | — |

## 4. 核心合同

第一阶段只新增精确合同，不把现有巨大 `LooseRecord` 整体搬入新包。

### 4.1 RequirementContract

```ts
export interface RequirementContractContentV1 {
  schema: "cpb.requirement-contract-content.v1";
  requestId: string;
  projectId: string;
  revision: number;
  goal: string;
  nonGoals: string[];
  acceptanceCriteria: AcceptanceCriterionV1[];
  constraints: string[];
  decisions: RequirementDecisionV1[];
  openQuestions: RequirementQuestionV1[];
  risk: "low" | "medium" | "high" | "critical";
}

export interface RequirementContractV1 {
  schema: "cpb.requirement-contract.v1";
  content: RequirementContractContentV1;
  contentHash: string; // 只对 canonicalized content 计算
  approval: "not_required" | "pending" | "approved" | "rejected";
  createdAt: string;  // 不进入 contentHash preimage
}
```

### 4.2 Skill Inventory 与 Snapshot

```ts
export interface RolePromptSkillV1 {
  schema: "cpb.role-prompt-skill.v1";
  id: string;
  version: string;
  source: "builtin" | "user" | "project";
  roles: AgentRole[];
  capabilities: string[];
  requiredTools: string[];
  risk: "low" | "medium" | "high";
  contentHash: string;
  provenance: SkillProvenanceV1;
  trust: "builtin" | "verified" | "user-approved" | "untrusted";
  approvalRevision?: number;
}

export interface AgentIntegrationBundleV1 {
  schema: "cpb.agent-integration-bundle.v1";
  id: string;
  version: string;
  targetAgents: string[];
  installer?: string;
  mcpAssets: string[];
  instructionAssets: string[];
  source: "builtin" | "user";
  contentHash: string;
  provenance: SkillProvenanceV1;
  trust: "builtin" | "verified" | "user-approved" | "untrusted";
  approvalRevision?: number;
}

export interface ResolvedSkillSnapshotV1 {
  schema: "cpb.resolved-skill-snapshot.v1";
  jobId: string;
  attemptId: string;
  phase: string;
  role: AgentRole;
  promptSkills: RolePromptSkillV1[];
  integrationBundles: AgentIntegrationBundleV1[];
  injectedContentHash: string;
  contentAddressedResources: ResolvedResourceRefV1[];
  sourceRevisions: Record<string, string>;
}
```

现有 `profiles/<role>/skills/*.md` 映射为 `RolePromptSkillV1`；现有根 `skills/*` 映射为 `AgentIntegrationBundleV1`。两者在迁移期保持不同命名空间、不同发现规则和不同写入权限，禁止直接合并成一个“Skill Registry”。Worker 只消费 Hub 冻结后的 `ResolvedSkillSnapshotV1`。

Snapshot 固化不可变内容或 content-addressed resource，而不是只记可被替换的路径。`AgentIntegrationBundle.installer` 只能在显式、可审计的安装事务中运行；禁止在 assignment resolve 或 Agent session 启动时执行。Skill 文本和模型输出都不能自行批准或扩大 Sandbox、Secret、Tool 或外部副作用权限。

### 4.3 SandboxPolicy

```ts
export interface SandboxPolicySourceV1 {
  schema: "cpb.sandbox-policy-source.v1";
  profileId?: string; // absent = inherit
  filesystem?: {
    readRoots?: string[];  // absent = inherit; [] = 禁止全部
    writeRoots?: string[];
  };
  shell?: {
    allowClasses?: string[];
    denyClasses?: string[];
  };
  network?: {
    mode?: "deny" | "allow" | "allowlist";
    domains?: string[];
  };
  subprocess?: "deny" | "allow";
  secrets?: "none" | "native-auth-only" | "explicit-refs";
}

export interface ResolvedSandboxPolicyV1 {
  schema: "cpb.resolved-sandbox-policy.v1";
  profileId: string;
  filesystem: {
    readRoots: string[];
    writeRoots: string[];
  };
  shell: {
    allowClasses: string[];
    denyClasses: string[];
  };
  network: {
    mode: "deny" | "allow" | "allowlist";
    domains: string[];
  };
  subprocess: "deny" | "allow";
  secrets: "none" | "native-auth-only" | "explicit-refs";
}
```

### 4.4 SessionToolManifest

```ts
export type SessionToolTransport =
  | "acp-session-mcp"
  | "cli-strict-mcp-config"
  | "unsupported";

export interface ResolvedToolPolicyV1 {
  schema: "cpb.resolved-tool-policy.v1";
  allowedServers: ResolvedMcpServerV1[];
  allowedCapabilities: string[];
  deniedCapabilities: string[];
}

export interface SessionToolManifestV1 {
  schema: "cpb.session-tool-manifest.v1";
  manifestId: string;
  sessionId: string;
  jobId: string;
  attemptId: string;
  projectId: string;
  assignmentLeaseId: string;
  assignmentEpoch: number;
  gatewayInstanceId: string;
  audience: "cpb-tool-gateway";
  revocationGeneration: number;
  phase: string;
  role: AgentRole;
  worktreeId: string;
  toolPolicy: ResolvedToolPolicyV1;
  issuedAt: string;
  expiresAt: string;
  executionProfileHash: string;
}

export interface SessionToolManifestEnvelopeV1 {
  schema: "cpb.session-tool-manifest-envelope.v1";
  manifest: SessionToolManifestV1;
  authenticator: string;
  authenticatorAlgorithm: "ed25519" | "hmac-sha256";
}
```

`executionProfileHash` 证明策略内容一致性；`authenticator` 另行证明 manifest 的真实性和时效性。认证 preimage 必须覆盖 manifest 的全部 canonical bytes，包括 `issuedAt`、`expiresAt`、lease/epoch、audience 和撤销代数。签名私钥或 MAC key 只能由 Hub/受信 supervisor 持有：Agent-spawned Gateway 使用签名 + 只读公钥；supervisor-spawned Gateway 可使用只经继承 FD 或受限 IPC 交付的临时 MAC key。任何 signer secret 都不得进入 Agent 可读文件、env、日志或 hash。

Gateway 在调用工具前通过窄化的 session-activation/revocation port 验证 lease/epoch，并在 durable replay store 中原子领取 `manifestId`。并发双领取、Gateway 重启、assignment lease 变化、撤销代数提升、墙钟过期或单调时钟超过最大寿命都使旧 manifest 失败关闭；该端口不是 Hub 管理 API。

### 4.5 ResolvedExecutionProfile

```ts
export interface ResolvedExecutionProfileV1 {
  schema: "cpb.resolved-execution-profile.v1";
  jobId: string;
  attemptId: string;
  projectId: string;
  phase: string;
  role: AgentRole;
  agent: ResolvedAgentV1;
  skills: ResolvedSkillSnapshotV1;
  sandbox: ResolvedSandboxPolicyV1;
  tools: ResolvedToolPolicyV1;
  budgets: ExecutionBudgetV1;
  sourceRevisions: Record<string, string>;
  policyHash: string;
  resolvedAt: string;
}
```

### 4.6 Hash preimage 与 canonical serialization

所有 hash 使用独立、版本化 preimage；任何 hash 字段都不得包含自身或嵌套引用自身。

```ts
export interface ExecutionPolicyDigestInputV1 {
  schema: "cpb.execution-policy-digest-input.v1";
  jobId: string;
  attemptId: string;
  projectId: string;
  phase: string;
  role: AgentRole;
  agent: ResolvedAgentV1;
  skills: ResolvedSkillSnapshotV1;
  sandbox: ResolvedSandboxPolicyV1;
  tools: ResolvedToolPolicyV1;
  budgets: ExecutionBudgetV1;
  sourceRevisions: Record<string, string>;
}
```

规则：

- `policyHash`、`contentHash`、`executionProfileHash`、时间戳和审批状态不进入自身 preimage。
- Object key 使用 Unicode code-point 稳定排序；数组按字段语义排序后去重。
- capability 必须先规范化为稳定 ID。
- 文件路径先解析为 canonical real path，再按 containment 语义计算更窄范围，不能做字符串集合交集。
- 域名先 IDNA/小写规范化；通配规则必须使用明确 matcher，不把 `*.example.com` 当普通字符串。
- `SessionToolManifest.executionProfileHash` 只引用外层 profile hash，不再包含独立 `policyHash`。
- Requirement `contentHash` 仅覆盖 `RequirementContractContentV1`；审批和创建时间不影响内容身份。
- Manifest authenticator 使用独立 preimage，必须包含发行/过期时间；不能复用为了稳定策略身份而排除时间戳的 policy digest。

### 4.7 配置合并规则

功能配置采用优先级覆盖：

```text
CPB default < user global < project < role < task
```

权限配置禁止 last-write-wins，采用最小权限交集：

```text
effective allow = 按资源语义求 global/project/role/task 的最窄共同允许范围
effective deny  = global deny ∪ project deny ∪ role deny ∪ task deny
```

配置源使用 tri-state：字段 absent 表示 inherit，显式 `[]` 表示禁止全部，非空集合表示本层允许上限。任何扩大文件写入、网络、外部副作用或 Secret 范围的配置变更必须产生审批事件；低层配置不能静默突破上层硬限制。

### 4.8 安全资源打开协议

Threat model 包含与 CPB 同 OS 用户运行、但受 Sandbox 约束的失控 Agent/MCP/Skill 进程，因此 `realpath` 或 `lstat` 后再按路径打开不构成安全边界。

- Manifest、assignment、Skill asset、secret-ref 文件和受策略约束的工具路径必须 descriptor-relative 打开。Linux 优先 `openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS)`；其他平台使用逐级 no-follow/file-ID/reparse-point 等价实现。
- 打开后校验类型、owner、mode、大小、device/inode/file ID；控制文件要求单链接或平台等价保证。只从已校验 FD/handle 读取，禁止再按路径打开。
- assignment data root 及其控制文件父目录不得可被 Agent 写入。每次 `tools/call` 重新解析相关路径，不能复用 session 启动时的 `realpath` 结果。
- 平台适配器无法证明等价 containment 时，高风险文件/工具 capability 失败关闭，而不是降级到字符串前缀判断。

## 5. 构建与发布策略

### 5.1 第一阶段不发布内部包

根 `package.json` 增加：

```json
{
  "workspaces": [
    "apps/*",
    "packages/*"
  ]
}
```

内部 workspace 统一：

```json
{
  "private": true,
  "type": "module"
}
```

第一阶段禁止在运行时代码中依赖未发布的 `@codepatchbay/*` npm 解析。源代码仍使用可随目录镜像编译的相对导入，根构建器将所有生产代码编译到一个 `dist/` 树中。

原因：npm pack 不会自动把私有 workspace 作为可解析的全局运行时依赖交付。若过早使用 bare package specifier，源码测试可能通过，隔离全局安装会失败。

迁移期 TypeScript 策略明确为：

- 生产构建继续由根 `tsconfig.node.json` 和 `scripts/build-output.mjs` 单次编译并镜像到根 `dist/`。
- workspace `tsconfig.json` 统一 `strict: true`、`noEmit: true`，用于包级严格检查和边界验证。
- 根脚本新增 `typecheck:workspaces`，显式逐个运行 workspace tsconfig。
- 迁移期不使用 `tsc -b`，不要求 Project References 产出运行时文件。
- 是否切换 Project References 延后到 Monorepo 收口后单独决策；切换前必须先设计 per-package outDir、artifact assembler 和 packed install 解析。

### 5.2 构建输出

迁移后的目标输出：

```text
dist/
├─ apps/
│  ├─ cli/
│  ├─ hub/
│  ├─ worker/
│  └─ tool-gateway/
├─ packages/
├─ scripts/
└─ build-metadata.json
```

根 `cpb` 启动器最终改为导入：

```js
./dist/apps/cli/cpb.js
```

但启动器切换只能发生在对应 dist 入口已经进入 pack smoke test 的同一阶段，不能提前提交。

### 5.3 UI 交付

- `apps/ui` 使用单独构建命令生成 `apps/ui/dist`。
- 根 artifact assembler 把它复制到 `dist/ui/`。
- Hub 只提供静态文件和 canonical API。
- npm tarball 必须包含 `dist/ui/index.html` 和 hashed assets。
- UI 缺失不得导致 CLI、Hub 或 Worker 无法启动；`cpb ui` 才要求 UI 资产存在。

### 5.4 发布验收

每个会影响 build、path 或 package files 的 PR 都必须运行：

```bash
npm ci
npm run typecheck
npm run typecheck:workspaces
npm run typecheck:strict:runtime-contracts
npm test
npm run build
npm pack --dry-run --json
npm run verify:packed-install-local
npm run verify:release-contracts
```

在授权的 release 环境运行：

```bash
npm run verify:p0p1
npm run verify:release-gate
```

`scripts/e2e-npm-pack.ts` 包含受保护的远端副作用路径，只能在满足其 disposable Hub、显式远端 capability 和 ACK 前置条件的专用环境运行，不能把绕过其安全前置条件写入普通开发脚本。

`verify:packed-install-local` 必须是无远端副作用的日常门禁：复用现有 pack authority/isolated install 逻辑，但只执行 build、pack、tar manifest/bundled dependency closure、offline 隔离全局安装、`cpb --version`、`cpb version --json`、`cpb doctor --json`、Hub start/status/stop、runtime roots 和 `REQUIRED_EXECUTOR_FILES` 校验；禁止访问 GitHub、启动真实 Agent 或调用 live finalizer。

## 6. 可执行迁移阶段

## Phase 0：冻结基线与迁移门禁

**目标：** 在任何结构变化前建立可比较基线。

### 改动文件

- 新增 `docs/architecture/monorepo-migration-baseline.md`
- 新增 `scripts/verify-monorepo-baseline.ts`
- 新增 `scripts/verify-packed-install-local.ts`
- 新增 `tests/monorepo-baseline.test.ts`
- 新增 `tests/packed-install-local.test.ts`
- 修改根 `package.json`，只增加验证命令，不加 workspace

### 任务

1. 记录当前 commit、Node/npm 版本、包名、bin、pack 文件清单和关键入口 hash。
2. 记录以下命令结果：

   ```bash
   npm ci
   npm run typecheck
   npm test
   npm run verify:p0p1
   npm pack --dry-run --json
   npm run verify:packed-install-local
   ```

3. 基线脚本验证：
   - 根包名仍为 `codepatchbay`；
   - `bin.cpb === "cpb"`；
   - pack 包含 `cpb` 和当前 CLI 入口；
   - pack 不包含 source checkout、测试、`.git`、临时状态或凭据；
   - `cpb --version` 与 package version 一致。
4. 从 `scripts/e2e-npm-pack.ts` 抽出可复用的 pack authority/isolated installation helper；共享 helper 不得携带远端 GitHub 前置条件。
5. `verify:packed-install-local` 必须使用隔离 prefix 和隔离 HOME，执行 version/doctor/Hub 生命周期/runtime-root 校验，且测试断言没有网络/Agent/finalizer 调用。
6. 创建 `monorepo-migration` 长期分支仅用于集成；每个 Phase 仍使用独立短分支和 PR。

### 完成标准

- 基线命令全部通过，或既有失败被记录为带证据的 pre-existing failure。
- 后续 PR 不允许增加新的基线失败。
- `git diff --check` 通过。

### 回滚

删除新增验证文件和 package script，不触及运行时。

---

## Phase 1：建立 Contracts Workspace

**目标：** 建立第一个真实 workspace，不移动现有引擎。

### 改动文件

- 修改根 `package.json`：增加 `workspaces`
- 新增 `tsconfig.base.json`
- 新增 `packages/contracts/package.json`
- 新增 `packages/contracts/tsconfig.json`
- 新增 `packages/contracts/src/*.ts`
- 新增 `packages/contracts/schemas/*.schema.json`
- 新增 `tests/contracts/*.test.ts`
- 修改 `tsconfig.node.json`、`tsconfig.tests.json`
- 修改 `scripts/build-output.mjs`：识别 `packages/` 源码和 schema asset
- 修改 `scripts/release-source-fingerprint.ts`
- 修改 `scripts/write-dist-metadata.ts`
- 修改所有枚举 source roots 的 release/build verifier
- 修改 `tests/release-source-fingerprint.test.ts`

### 任务

1. 根 workspaces 只匹配存在的真实 package。
2. `packages/contracts` 设为 `private: true`，禁止运行时副作用。
3. 实现第 4 节列出的 v1 合同和 JSON Schema。
4. 给每个合同增加：
   - schema discriminator；
   - parser/validator；
   - canonical serialization；
   - content hash；
   - unknown version fail-closed；
   - backward-compatible optional fields 规则。
5. 不移动 `shared/types.ts`，不删除 `core/contracts/types.ts`。
6. 新合同禁止引用 `LooseRecord`；边界处显式解析旧结构。
7. 更新 build fingerprint，把 workspace source、package manifest 和 schema 加入输入。
8. 与创建 `packages/` 同一 PR 更新 release source allowlist、source fingerprint 测试和 dist metadata；只允许实际创建的根目录，禁止提前把未来 `apps/`、`resources/` 作为任意允许根加入。
9. 新增根脚本 `typecheck:workspaces`，contracts workspace 必须 `strict: true`、`noEmit: true`。

### 测试

```bash
npm run build
npm run build:tests
npm run typecheck
npm run typecheck:workspaces
npm run typecheck:strict:runtime-contracts
node dist-tests/scripts/run-node-tests.js tests/contracts
npm pack --dry-run --json
npm run verify:packed-install-local
npm run verify:release-contracts
```

### 完成标准

- 现有 CLI/Hub/Worker 行为无变化。
- 新合同在源码、`dist/` 和 tarball 中存在。
- 运行时未出现对私有 workspace bare specifier 的依赖。
- pack 安装 smoke test 通过。

### 回滚

移除 contracts workspace 和根 workspace 配置；旧运行时不依赖新合同，因此可直接回滚。

---

## Phase 2：Skill Inventory 与 Runtime Resource Locator

**目标：** 在策略 enforce 前区分两类现有 Skill，并统一源码、dist 和 packed install 的资源寻址。

### 改动文件

- 新增 `packages/contracts/src/skill/*.ts`
- 新增 `packages/core/src/resources/resource-manifest.ts`
- 新增 `packages/core/src/resources/resource-locator.ts`
- 修改 `server/services/prompt/prompt-resources.ts`
- 修改读取 `profiles/`、`skills/`、`templates/` 的 canonical 路径
- 新增 `tests/resources/*.test.ts`
- 新增 `tests/skill-inventory/*.test.ts`

### 任务

1. 将现有 `profiles/<role>/skills/*.md` 发现为 `RolePromptSkillV1`。
2. 将现有根 `skills/*` 发现为 `AgentIntegrationBundleV1`，不与 prompt skill 合并命名空间。
3. Hub 负责读取 builtin/user/project 来源、选择并冻结 `ResolvedSkillSnapshotV1`；Worker 只消费 snapshot。
4. 每个 snapshot 固化 immutable bytes/content-addressed resource、publisher/provenance、trust level、审批 revision、content hash 和 source revision；resolve 后替换原路径内容不能改变 assignment。
5. `AgentIntegrationBundle.installer` 只允许显式 `cpb skill install` 安装事务调用；安装前展示来源、digest、将执行的步骤和权限，安装后记录结果。Session resolve、Worker 恢复和 Gateway 启动都禁止执行 installer。
6. 定义 `RuntimeResourceManifestV1`，记录 required/optional、source path、packed path、content hash 和 resource kind。
7. `ResourceLocator` 必须覆盖 source checkout、root `dist/`、packed global install、builtin 与 user/project resources，并使用第 4.8 节的安全打开协议读取控制资源。
8. 在移动任何 `profiles/`、`skills/`、`templates/` 前，先把动态路径消费者切换到 locator；import graph 不能替代动态路径审计。
9. 迁移期不移动根 `skills/`，不改变现有 installer/MCP adapter asset 的对外路径。
10. 新增只读 CLI/API inventory 查询可以内部实现，但公开命令延后到 Phase 5 的 canonical CLI entry 完成后。

### 完成标准

- 同一资源在 source、dist、packed install 下得到相同 logical ID/content hash。
- Role Prompt Skill 与 Agent Integration Bundle 不会互相覆盖。
- Worker assignment 包含冻结 snapshot，不扫描用户或项目 Skill 目录。
- packed install 能读取全部 required resources，缺失 required resource 时 fail-closed。
- 未批准 bundle、session-time installer、hash 后资源替换和 Skill 自行请求更高权限均被拒绝。

### 回滚

locator 以 shadow 模式对照旧路径；差异未归零前不删除旧 lookup。发生问题时切回 legacy locator，不写入新 canonical 格式。

---

## Phase 3：统一 Execution Policy

**目标：** 把 Skill、MCP、Sandbox、Role、Project、Task 的有效配置收敛成唯一 `ResolvedExecutionProfileV1`。

### 改动文件

- 新增 `packages/execution-policy/package.json`
- 新增 `packages/execution-policy/src/resolver.ts`
- 新增 `packages/execution-policy/src/policy-hash.ts`
- 新增 `packages/execution-policy/src/permission-merge.ts`
- 新增 `packages/execution-policy/src/legacy-adapter.ts`
- 修改：
  - `core/acp/policy.ts`
  - `core/policy/agent-sandbox.ts`
  - `core/policy/child-env.ts`
  - `server/services/permission-matrix.ts`
  - `server/services/agent/agent-config.ts`
  - `core/agents/descriptors/*.json`
- 新增 `tests/execution-policy/*.test.ts`

### 任务

1. 定义配置来源及 revision：builtin/user/project/role/task。
2. 实现功能覆盖与权限交集两套独立合并算法。
3. 按第 4.6 节的独立 digest preimage 生成稳定、排序无关且无自引用的 `policyHash`。
4. 把 Phase 2 生成的 `ResolvedSkillSnapshotV1` 纳入 profile，resolver 不再自行扫描 Skill 目录。
5. Agent capability 投影新增并真实消费 `SessionToolTransport`；不得只在 descriptor 中声明而不进入运行路径。
6. 加入 dual-evaluation 模式：

   ```text
   CPB_EXECUTION_PROFILE_MODE=shadow | enforce | legacy
   ```

7. `shadow` 模式同时计算旧策略和新策略，只记录差异，不改变执行。
8. 差异事件必须脱敏，不记录 token、完整 env 或 Secret 内容。
9. 至少运行一轮 planner/executor/verifier/reviewer 的真实策略对照。
10. 只有差异归零或被明确接受后，才把默认从 `legacy` 切到 `enforce`。
11. `enforce` 下任何不支持该策略的 Agent Adapter 都 fail-closed，并产生可操作的错误码。

### 测试

- 属性测试：安全权限不会因更低层 override 扩大。
- 顺序测试：相同输入集合在不同键顺序下得到相同 hash。
- 路径测试：symlink、相对路径、父目录逃逸不能扩展写范围。
- Race 测试：检查后文件交换、父目录 rename、hardlink/magic-link、Windows junction/reparse point 不能绕过 containment。
- Agent 测试：Codex native sandbox 与 CPB outer sandbox 不重复嵌套。
- 回归测试：verifier/reviewer/planner 不获得写工具。

### 完成标准

- `runAgent` 接收到明确的 profile/hash，而不是再次拼接散落 env。
- 事件记录实际生效的 agent、skills、sandbox 和 tool policy hash。
- 旧环境变量在兼容期仍可解析，但解析只发生在 legacy adapter。

### 回滚

设置 `CPB_EXECUTION_PROFILE_MODE=legacy`；整个新 resolver 可独立 revert。旧路径保留到 Phase 9 收口且所有 canary/pack/recovery 证据通过，不得提前删除。

---

## Phase 4：建立 Worker 应用边界

**目标：** 把长期运行入口与领域执行逻辑分开，但不重写执行内核。

### 改动文件

- 新增 `apps/worker/package.json`
- 新增 `apps/worker/src/main.ts`
- 新增 `apps/worker/src/runtime-adapter.ts`
- 迁移或收口：
  - `runtime/worker/managed-worker.ts`
  - `runtime/worker/assignment-finalizer.ts`
  - `server/orchestrator/worker-supervisor.ts`
  - `server/services/executor-root.ts`
- 新增 `packages/contracts/src/worker-assignment.ts`
- 新增 `tests/integration/worker-app.test.ts`

### 任务

1. 先定义 `WorkerAssignmentV1`、`WorkerResultV1`、`WorkerAuditEventV1`。
2. `apps/worker` 只负责启动、信号、取消、退出码、端口装配。
3. `core/engine/run-job.ts` 保持领域执行入口，不搬入 app。
4. Worker 从 assignment 文件读取冻结的 `ResolvedExecutionProfileV1` 及 hash。
5. Worker 不读用户全局 Skill/MCP/Sandbox 配置，不自行重新 resolve。
6. 明确实现 `managed` 与 `standalone` 两种 mutation authority：managed 强制 broker-only；standalone 必须持有显式 `MutationAuthorityV1 { mode: "standalone" }`。
7. mode 切换必须提升 aggregate epoch 并取得排他 lease；store 对每次 mutation/finalizer/journal commit 执行 authority CAS，旧 epoch 无条件拒绝。
8. standalone 启动必须证明无有效 Hub lease；Hub 恢复需先 takeover/revoke 并提升 epoch，不能直接与旧 writer 抢写。
9. 删除“broker 缺失就自动 direct store”的隐式语义；managed 缺少 broker capability 时返回结构化失败。
10. Supervisor 仍由 Hub 管理，恢复、lease、heartbeat 语义不改变。
11. 修改 build required outputs，加入 `dist/apps/worker/main.js`，但保留旧入口直到 packed E2E 通过。
12. packed E2E 通过后，同一 PR 内切换 canonical runtime entry 并删除旧入口；不保留永久 re-export 壳。

### 完成标准

- managed-worker 隔离 E2E 通过。
- cancel、timeout、crash recovery、lease recovery 行为不变。
- old/new entry 的 assignment/result bytes 在 fixture 中等价。
- `CPB_EXECUTOR_ROOT` 仍能从 packed installation 解析到合法只读 runtime root。
- managed 模式没有 Worker direct-store 写入；standalone 模式不能与相同 aggregate 的 Hub writer 并发。
- 网络分区、暂停后恢复、lease 边界、双启动和 Hub/Worker crash fixture 中，陈旧 epoch 的写入全部被 store 拒绝。

### 回滚

Supervisor 切回旧 canonical entry；新 contracts 可保留，因为无行为副作用。

---

## Phase 5：Hub/API 与 CLI 应用边界

**目标：** 在新增公开 MCP/澄清命令前，让 UI、CLI、IM 使用同一个 canonical API，不复制业务逻辑。

### 改动文件

- 新增 `apps/hub/package.json`、`apps/hub/src/main.ts`
- 新增 `apps/cli/package.json`、`apps/cli/src/cpb.ts`
- 新增 `packages/api-client`
- 把现有 CLI command 逐批迁移到 `apps/cli`
- 把 Hub 启动装配迁移到 `apps/hub`
- 保留 `server/services` 中稳定服务，按领域逐批迁移到 packages
- 更新创建 `apps/` 同 PR 的 release source allowlist/fingerprint/tests

### API 规则

- UI/CLI/IM 只调用 DTO/API，不导入 Hub service implementation。
- mutation 必须带 actor、requestId、idempotency key 和预期 revision。
- 所有审批、配置修改和重试写对应 aggregate 的 canonical mutation protocol；不能把所有 store 强行改写成单一 Event Store。
- API 返回 materialized state；调用者不得自行重放一部分事件猜状态。
- 本地匿名只允许 loopback development policy；沿用现有 Hub auth 边界。

### 双启动器切换

当前既有根 `cpb`，构建器还会生成 `dist/cpb` 供 executor-root 使用。切换必须在同一 PR 同时处理：

1. 根 `cpb` 导入 `./dist/apps/cli/cpb.js`，保留现有 `CPB_ROOT`/`CPB_EXECUTOR_ROOT` 解析语义。
2. `scripts/build-output.mjs` 生成的 `dist/cpb` 改为同一 canonical CLI entry。
3. 保持两个 launcher 的 executable mode。
4. 更新 `scripts/build-output.mjs` required outputs。
5. 更新 `server/services/executor-root.ts#REQUIRED_EXECUTOR_FILES`。
6. 更新 `scripts/e2e-npm-pack.ts` install authority、post-install repack identity 和 runtime-root tests。
7. 更新 package tarball integrity fixture、release source fingerprint 和 dist metadata。

只有 `dist/apps/cli/cpb.js`、`dist/apps/hub/main.js`、`verify:packed-install-local` 和 release contracts 全部通过后才切换，不允许先提交半个启动器。

### 完成标准

- 所有旧 CLI 命令参数和退出码保持兼容。
- Hub start/stop/status、worker scheduling、backup/restore 和 auth gate 全部通过。
- 仓库中不存在 app-to-app implementation import。
- 根 `cpb` 与 `dist/cpb` 在 source/packed install 下解析到相同 runtime authority。
- 旧 canonical CLI/Hub 入口被删除，不留下双入口。

### 回滚

在没有新 canonical data write 的前提下同时回滚两个 launcher、required files 和 artifact metadata；不得只回滚根 `cpb`。

---

## Phase 6：Local Tool Gateway MVP

**目标：** 为每个 Agent session 提供本地、最小权限、可审计的 MCP 工具面。

### 改动文件

- 新增 `apps/tool-gateway/package.json`
- 新增：
  - `apps/tool-gateway/src/main.ts`
  - `apps/tool-gateway/src/protocol.ts`
  - `apps/tool-gateway/src/registry.ts`
  - `apps/tool-gateway/src/session.ts`
  - `apps/tool-gateway/src/downstream-process.ts`
  - `apps/tool-gateway/src/audit.ts`
- 新增 `packages/contracts/src/mcp/*.ts`
- 修改 Agent Adapter 的 session MCP 注入路径
- 新增 `tests/tool-gateway/*.test.ts`
- 新增 CLI 命令：`cpb mcp list|add|enable|disable|doctor`

### MVP 范围

- 默认每 Agent session 启动一个 stdio Gateway 进程。
- 支持下游 stdio MCP；远程 Streamable HTTP 仅在现有 MCP client 能力验证通过后加入。
- 注册表是本地配置，Hub 是写入 owner。
- Agent 只能看到 manifest 允许的 server/tool。
- 禁用 server 后拒绝新 session；活跃 session 按 manifest 快照继续到结束，除非触发显式安全撤销。
- 下游 MCP 按 session 启动，Agent 退出或超时后清理。
- 工具名使用稳定 namespace，拒绝冲突和影子覆盖。
- Session manifest 钉住下游 executable 的安全 realpath/file ID + digest、argv、protocol version、server identity，以及每个 tool 的 canonical schema digest；`tools/list` 漂移时隔离该 server。
- 工具参数、结果摘要、时长、状态和 policy hash 写审计事件。
- 每个 Agent Adapter 必须声明并经过验证的 `SessionToolTransport`：`acp-session-mcp`、`cli-strict-mcp-config` 或 `unsupported`。
- profile 要求工具而 Adapter 为 `unsupported` 时返回 `MCP_SESSION_UNSUPPORTED`；只有工具明确标记 optional 的任务才允许无 MCP 继续。
- Gateway-required session 禁止 `session/new` 拒绝 MCP 后静默以空 MCP 重建；该 fallback 只能用于 tool-optional session，并必须产生显式降级事件。

### 安全要求

1. Gateway 不接收 provider token，不复制 Agent 原生认证。
2. Gateway 和下游 MCP 从空环境构造 env，只加入固定系统变量与该 server/tool/audience/TTL 明确允许的 secret refs；禁止继承代理、Git credential、云凭据、`*_TOKEN`/`*_KEY` 和多余 FD，关闭 core dump。
3. Gateway 不开放公网监听；MVP 只使用 stdio。
4. Manifest 必须包含第 4.4 节的 session/lease/epoch/audience/revocation 字段并通过独立 authenticator 验证；不得仅比较 `executionProfileHash`。
5. Manifest/assignment/control asset 必须使用第 4.8 节的 descriptor-relative 安全打开协议，禁止 check-then-open。
6. `manifestId` 必须通过 activation port 原子领取；required-tool session 在 activation/revocation port 不可用时失败关闭。
7. Gateway 不得通过 MCP 暴露 Hub 管理 API，避免 Agent 递归提交任务或绕过当前 assignment；只允许使用 typed、窄化的 activation/revocation/audit port。
8. 每次 `tools/call` 都重新检查 session lease/epoch/revocation、tool allowlist、server identity/schema digest 和路径 containment。
9. Tool 参数只按钉住的有限 JSON Schema 验证：限制总字节、深度、属性数、数组长度、regex 时间和本地 `$ref`；禁止远程 schema ref、prototype-pollution key 和未声明字段。
10. Tool result 一律标记为 untrusted，限制 MIME、总字节、深度、URI 与附件数量；禁止自动抓取其中链接、执行内容或把结果升级为 system instruction。模型输出、Skill 文本和 tool result 都不能满足高风险副作用审批。
11. 所有写入、网络、Secret、subprocess 或外部副作用调用必须在 dispatch 前 append + `fsync` 本地 audit WAL；audit/磁盘/sequence 失败时 fail-closed。只有纯本地只读调用可短暂进入有界内存缓冲，满后拒绝新调用。
12. 每个 session 运行在可回收的 OS containment unit：Linux cgroup v2、Windows Job Object、macOS 受限 supervisor 或经验证的等价机制；设置 PID/CPU/memory/FD/temp-disk/stdout/stderr/result/call-count/concurrency/wall/idle limits，kill-on-close 清理全部后代。
13. Hub 实施全局/项目 admission quota、启动速率限制、server crash circuit breaker 和隔离目录配额。

### 测试

- 工具枚举只返回允许集合。
- 使用旧工具名直接调用被拒绝。
- server/tool 命名冲突失败关闭。
- manifest 篡改、过期、hash 不匹配、symlink 被拒绝。
- 修改 expiry、旧 lease/epoch、跨 Gateway/session、Gateway 重启重放、并发双领取被拒绝。
- 文件/父目录交换、hardlink、magic-link、rename race 和 Windows reparse point 被拒绝。
- executable 或 tool schema 在批准后漂移时 server 被隔离。
- 超大/递归 schema/result、prompt injection、env/FD 泄漏和错误回显 secret fixture 被拒绝或脱敏。
- 下游挂死、输出过大、协议错误、崩溃得到结构化失败。
- fork/double-fork、忽略信号、无限输出、pipe 背压、内存/FD/磁盘耗尽和 session storm 不拖垮 Hub；Agent 取消后无孤儿进程。
- verifier manifest 无写工具。
- audit 磁盘满、权限丢失、事件删除/重排、started/completed 间 crash 和风险降级尝试均失败关闭或产生可恢复的 incomplete event。

### 完成标准

- 至少一个声明 `acp-session-mcp` 或 `cli-strict-mcp-config` 的真实 Adapter 完成 Gateway E2E。
- Claude 只有在升级后的 wrapper 或 strict CLI injection 被真实验证后才列为必过；当前 `sessionMcpServers: false` 不得被文档或 UI 误报为支持。
- Gateway 不改变没有 MCP 需求的任务路径。
- `cpb mcp doctor` 能定位 command、transport、health、permission 和 secret-ref 问题。
- `cpb mcp doctor` 只显示 secret ref identity 和脱敏状态，不回显值、继承 env 或认证材料。

### 回滚

项目级 `mcpGateway.enabled=false` 只可用于“无工具需求”或 legacy 配置已证明权限等价的任务；required-tool 或安全收紧依赖 Gateway 的任务必须暂停并返回结构化错误，不能回退到更宽的当前 Agent 工具配置。保留 registry 数据但不启动 Gateway。

---

## Phase 7：需求澄清与冻结需求合同

**目标：** 在 plan 前处理真正影响实现和验收的歧义。

### 改动文件

- 新增 `packages/core/src/intake/*`
- 接入并扩展 Phase 1 的 `packages/contracts/src/requirement-contract.ts`
- 修改 pipeline intake/prepare task 路径
- 新增 CLI：
  - `cpb task submit`
  - `cpb task clarify`
  - `cpb task approve-requirements`
- 新增 `tests/intake/*.test.ts`

### 状态机

```text
submitted
→ analyzing
→ clarification_required | requirements_ready
→ requirements_approved
→ planning
```

低风险且无 open question 的任务允许 `approval=not_required` 自动进入 planning。高风险、不可逆、外部副作用、数据迁移或验收冲突必须停在 `clarification_required`。

### 任务

1. `packages/core/src/intake` 只实现纯状态机、contract validation 和 stale 判定；planner 调用、代码索引和持久化由 Hub intake orchestrator 负责。
2. 由 planner 的只读 intake mode 完成澄清分析，不新增永久 Agent 类型。
3. 输入代码索引、项目约束、既有 issue 和风险图。
4. 只问会改变设计、权限、验收或交付的高信息量问题。
5. 生成 versioned Requirement Contract，批准后冻结 content hash。
6. Requirement Contract 是 intake authority；现有 acceptance checklist 是从已批准 requirement revision 派生的 execution artifact，不是第二份独立需求真相。
7. 每个 checklist item 必须记录 `requirementRevision`、`requirementHash` 和 `sourceCriterionId`；旧任务生成 `legacy-derived` Requirement Contract。
8. 计划、checklist、verifier 和 finalizer 必须引用同一 requirement revision/hash。
9. 需求变化或 scope amendment 必须生成新 revision 或显式批准 amendment；旧 plan/checklist 自动 stale，不能静默覆盖。
10. clarification timeout 不可被当作任务失败；应进入 attention queue。

### 完成标准

- 简单任务不增加无意义问答。
- 高风险 fixture 在缺关键决策时不能进入 execute。
- verifier 能逐条映射 acceptance criteria 到 evidence。
- retry/remediation 不得擅自扩大 Requirement Contract。

### 回滚

设置项目 `clarification.mode=legacy`，直接使用原 task description；已生成合同保留为审计产物。

---

## Phase 8：本地 UI 看板

**目标：** 建立 attention-first UI，而不是重新复制旧 Web 业务层。

### 信息架构

1. Inbox：待澄清、待批准计划、运行中、阻塞、待审阅。
2. Task：需求合同、计划、Agent/Skill/MCP/Sandbox、生效策略、时间线、Diff、Evidence、Verdict。
3. Agents & Tools：Agent、Provider、Skill Registry、MCP Registry、能力矩阵。
4. Policies：Sandbox、项目权限、外部副作用、protected paths。
5. System：Hub、Worker、Gateway、Provider quota、审计和存储健康。

### 实施约束

- UI 先只读，再逐项开放 mutation。
- 每个 mutation 必须复用 api-client，不得在前端重写策略。
- UI 展示 effective policy，而不只是配置源。
- UI 不显示 raw secrets、完整环境变量或未经脱敏的 tool arguments。
- UI 资产缺失不得阻止 CLI/Hub 核心路径。
- 不恢复历史 `web/` 目录的旧架构；新 UI 从 canonical API 开始。
- UI build 必须先清理 staging 目录，再原子发布 hashed assets；生成 asset manifest 并校验没有旧 hash 文件混入 tarball。
- UI/API 只绑定显式 `127.0.0.1` 和/或 `[::1]`，禁止 wildcard；严格校验启动时公布的 loopback Host/随机端口，拒绝 DNS 名、伪造 Host 和非 loopback 解析。
- 每次启动生成 256-bit UI capability，经私有文件或一次性启动 URL 交换为短期 `HttpOnly; SameSite=Strict` cookie；capability 不进入日志、历史 API、页面源码或持久配置。
- 所有 mutation 同时要求认证 cookie、非 simple JSON request、CSRF token、精确 Origin allowlist 与 Hub 侧 actor/approval/revision/idempotency 检查；CORS 默认关闭。
- WebSocket 握手验证 Host、Origin、session、子协议，首帧还需一次性 nonce；使用严格 CSP、`frame-ancestors 'none'` 和 `X-Content-Type-Options: nosniff`。

### 完成标准

- `cpb ui` 在 loopback 启动并打开本地页面。
- 用户可在一个页面完成澄清、计划批准和结果审阅。
- UI/CLI 对同一 job materialized state 一致。
- pack tarball 和隔离安装包含 UI 资产。
- `dist/ui/asset-manifest.json` 与 tarball 文件集合一致，重复构建不会残留 stale assets。
- 跨站 form/fetch、`Origin: null`、DNS rebinding、伪造 Host、跨站 WebSocket 和 session/capability 重放测试全部失败关闭。

---

## Phase 9：删除旧目录与完成 Monorepo 收口

**目标：** 在新边界稳定后删除旧组织结构，不保留永久双轨。

### 任务

1. 使用 code index 和 import graph 列出 `cli/`、`server/`、`runtime/`、`core/`、`shared/`、`bridges/` 的剩余所有者。
2. 每次只迁移一个领域 slice；提交中同时更新导入和测试。
3. 禁止创建兼容 re-export 目录维持旧路径。
4. 收敛 `shared/types.ts` 与 `core/contracts/types.ts`：
   - 精确合同进入 `packages/contracts`；
   - 内部局部宽类型留在具体包；
   - 删除重复 `LooseRecord` 定义；
   - 不能把巨大 `LooseRecord` 直接改名后视为合同迁移完成。
5. 删除旧目录前更新 build fingerprint、release source fingerprint、docs contract 和 boundary tests。
6. 更新 README、AGENTS.md、CLAUDE.md、开发文档和架构图。

### 完成标准

- 根生产源码只存在 `apps/`、`packages/`、`resources/`、`scripts/`。
- 不存在已删除路径的 import、dynamic path 拼接或文档命令。
- type-debt guard 没有因迁移扩大 allowlist。
- release gate、pack E2E、managed-worker E2E 全部通过。

## 7. PR 切分建议

禁止提交一个“大迁移 PR”。建议最少拆为以下 PR：

| PR | 内容 | 行为变化 |
|---|---|---|
| 1 | 基线、migration gate、无远端 packed-install gate | 无 |
| 2 | npm workspace + contracts + release source roots | 无 |
| 3 | contracts schema/validator/hash | 无 |
| 4 | Skill inventory + Resource Locator shadow | 仅观测 |
| 5 | execution-policy shadow + Adapter transport capability | 仅观测 |
| 6 | execution-policy enforce canary | 可回滚 |
| 7 | worker contracts + managed/standalone authority | 路径变化 |
| 8 | Hub/api-client application boundary | 内部结构变化 |
| 9 | CLI 双 launcher + packed install switch | 发布路径变化 |
| 10 | Tool Gateway registry + protocol | 默认关闭 |
| 11 | Tool Gateway agent integration | 项目级 canary |
| 12 | requirement intake + checklist derivation | 项目级 canary |
| 13+ | UI 只读、审批、管理页面分批 | 增量功能 |
| 最终组 | 旧目录按领域删除 | 结构收口 |

每个 PR 都必须给出：

- 触及的不变量；
- 运行的门禁；
- migration/rollback 指令；
- pack manifest diff；
- 新增或删除的 runtime entry；
- 是否改变 canonical state；
- 是否改变外部副作用能力。

## 8. 测试矩阵

| 测试层 | 重点 |
|---|---|
| Contract | schema、版本、hash、canonical serialization |
| Boundary | workspace 依赖方向、app/package 禁止边 |
| Unit | policy merge、path/network/tool deny、risk/clarification |
| Integration | Hub→Worker、Worker→Agent、Agent→Gateway |
| Security | symlink、路径逃逸、manifest 篡改、secret redaction、orphan process |
| Packaging | tarball 文件、全局安装、runtime roots、UI assets |
| Recovery | Hub/Worker/Gateway 崩溃、lease、cancel、resume |
| Product | Issue/Task→Clarify→Plan→Execute→Verify→Review Bundle |
| Live | Codex/Claude 真实 Agent、受控 draft PR |

### 每阶段最低命令集

```bash
npm ci
npm run build
npm run build:tests
npm run typecheck
npm run typecheck:workspaces
npm run typecheck:strict:engine
npm run typecheck:strict:runtime-contracts
npm run typecheck:type-debt:engine
npm test
npm run verify:p0p1
npm pack --dry-run --json
npm run verify:packed-install-local
npm run verify:release-contracts
git diff --check
```

涉及 release path 时，在授权环境额外运行：

```bash
npm run verify:release-gate
```

涉及真实远端交付时，使用项目现有 disposable E2E 安全合同，不新增宽松 bypass。

## 9. 数据迁移与兼容性

### 9.1 数据原则

- Monorepo 是源码结构迁移，不应强迫用户迁移 `~/.cpb` 根目录。
- 新 Registry/Requirement/Policy 文件必须有 schema/version/revision。
- 旧项目配置由只读 legacy adapter 解析为新合同。
- 第一次写入新格式时使用原子替换，并保留可恢复旧版本。
- 遇到未知新版本必须失败关闭，不能丢字段后覆盖。
- 新格式优先写 versioned sidecar；旧 canonical 文件保持不变，直到 cutover gate 通过。
- 每次 canonical cutover 写入 `minimumReaderVersion`、migration journal 和 readback proof。

每个 canonical cutover 必须使用单写者锁、当前 `MutationAuthorityV1` 和显式事务状态机：

```text
PREPARED → DATA_SYNCED → POINTER_SWAPPED → VERIFIED → COMMITTED
```

- Journal 记录 migration ID、source/target schema、source/target hash、backup path、authority epoch 和前序状态。
- 状态推进严格按平台验证过的 `fsync(file) → fsync(directory) → append + fsync(journal)` 协议执行；跨文件 cutover 不假设 rename 自动形成事务。
- 启动恢复器只依据最后一个已持久化合法状态做幂等 roll-forward/rollback；未知组合失败关闭、保留原件并进入 attention queue。
- `minimumReaderVersion` 只能在 target schema/hash/readback 全部验证后提交；迁移期间旧 writer 由 store epoch fencing。
- 对每个 I/O 边界做 fault-injection + crash/restart；重复恢复必须得到完全相同 bytes/hash/state。

回滚分为四类，不能笼统承诺“任意阶段直接 revert”：

| 类型 | 允许条件 | 方法 |
|---|---|---|
| 代码回滚 | 新 writer 尚未写入 canonical 新格式 | revert code/launcher/build metadata |
| Feature rollback | 新 writer 已启用 | feature flag 停止新行为，继续使用兼容 reader |
| Binary downgrade | 已写入新 canonical 格式 | 默认禁止；只有经过测试的 downgrade tool 才允许 |
| 数据恢复 | migration/cutover 失败 | 离线 backup + journal recovery + readback proof |

### 9.2 配置兼容周期

| 版本 | 行为 |
|---|---|
| 0.6.0 | 新旧双读，默认旧写；新策略 shadow |
| 0.6.1 | 新格式写入 opt-in，旧格式备份 |
| 0.6.2 | 新格式默认，新旧双读 |
| 0.7.0 | 删除旧写路径，保留只读导入工具 |

具体版本可随实际发布节奏调整，但“先双读、后切写、最后删旧写”顺序不可改变。

## 10. 可观测性与审计

必须新增或稳定以下事件：

- `requirement_contract_created`
- `requirement_contract_approved`
- `requirement_contract_superseded`
- `execution_profile_resolved`
- `execution_profile_mismatch`
- `tool_session_started`
- `tool_call_started`
- `tool_call_completed`
- `tool_call_denied`
- `tool_session_stopped`
- `sandbox_policy_applied`
- `sandbox_policy_unenforceable`
- `skill_snapshot_resolved`

事件只记录必要摘要和 hash；tool 参数、模型输出、路径和错误在进入持久层前统一脱敏。Tool audit WAL 还必须记录单调 sequence、previous-event hash、manifest/session/lease ID，并在轮转时保持 hash-chain continuity。`tool_call_started` 在任何具有写入、网络、Secret、subprocess 或外部副作用的 dispatch 前持久化并 `fsync`；结果事件随后追加。Adapter、Skill 或模型不得降低 tool risk 分类。

## 11. 风险登记

| 风险 | 级别 | 缓解 |
|---|---:|---|
| 私有 workspace 在 packed install 中无法解析 | P0 | 根单产物构建；禁止 bare workspace runtime import；pack E2E |
| 构建器漏掉新 workspace source/asset | P0 | build fingerprint + required outputs + tarball manifest test |
| 新根目录未登记导致 release contract 失败 | P0 | 创建目录的同一 PR 更新 allowlist/fingerprint/tests，不预先放宽 |
| 根 `cpb` 与生成的 `dist/cpb` 漂移 | P0 | 双 launcher 同 PR 切换 + executable/runtime-root/pack identity 测试 |
| Worker 重新解析配置导致恢复漂移 | P0 | assignment 固化 profile + policyHash；Worker 禁止读取配置源 |
| managed/standalone 在分区后并发写 | P0 | store-level epoch/lease fencing；每次 mutation CAS；陈旧 epoch 拒绝 |
| Gateway manifest 被篡改或重放 | P0 | authenticated envelope + audience/lease/epoch/revocation + durable one-time activation |
| 路径检查遭 TOCTOU/hardlink 绕过 | P0 | descriptor-relative no-follow open；fstat 后只从 FD 读取；race tests |
| Gateway 成为权限绕过点 | P0 | 每 session manifest、固定 server/schema digest、tools/call 重验、fail-closed audit |
| Adapter 不支持 session MCP 但继续执行 | P0 | transport capability + `MCP_SESSION_UNSUPPORTED` + required-tool 禁止 fallback |
| 恶意 MCP/Skill 泄漏 Secret 或成为 confused deputy | P0 | provenance/approval/content snapshot；空 env；schema pinning；untrusted result |
| 本地 UI 遭 CSRF/DNS rebinding/WebSocket hijack | P0 | loopback Host/Origin/auth/CSRF/WS nonce + CSP |
| MCP 进程或 session storm 耗尽宿主机 | P1 | OS containment unit + per-session/global quotas + circuit breaker |
| UI 复制业务状态 | P1 | api-client only；Hub materialized state |
| 大搬迁破坏 release fingerprint | P1 | 小 PR、同 PR 更新 fingerprint、dist metadata 与 pack authority |
| 旧配置被新写路径覆盖 | P0 | 双读、原子替换、版本保护、备份 |
| 合同包变成新 LooseRecord 垃圾场 | P1 | 精确类型、schema、禁止 LooseRecord import |
| 两类 Skill 被错误合并 | P0 | RolePromptSkill/AgentIntegrationBundle 分库存；assignment 固化 snapshot |
| Hash preimage 自引用或权限误归零 | P0 | 独立 digest input、tri-state source、canonical containment、稳定序列化 |
| Gateway 残留孤儿子进程 | P1 | OS containment kill-on-close、取消 E2E、平台特定测试 |
| Cutover 任意 I/O 点崩溃产生半迁移状态 | P0 | fencing + 状态机 journal + fsync 顺序 + 幂等 crash recovery |
| Sandbox 在不同 Agent 上语义不一致 | P0 | semantic policy + adapter evidence + unenforceable fail-closed |
| 迁移期功能扩张拖垮稳定化 | P0 | Phase 0/1 无行为变化；新功能默认关闭；release gates |

## 12. Go/No-Go Gate

每个 Phase 合并前必须回答：

1. 是否保持单包安装？
2. packed install 是否真实验证？
3. 是否为任一 aggregate 新增第二个 writer 或未定义 mutation authority？若是，No-Go。
4. 是否让 Worker/Gateway/UI 重新解析业务配置？若是，No-Go。
5. 是否扩大 Agent、Sandbox、Tool 或外部副作用权限？若未经审批与测试，No-Go。
6. 是否需要永久兼容 re-export？若是，No-Go，重新切 slice。
7. 是否说明代码回滚、feature rollback、binary downgrade、数据恢复分别如何处理？没有则 No-Go。
8. 是否增加 type-debt allowlist？没有单独审查则 No-Go。
9. release source fingerprint 和 pack manifest 是否更新？未更新则 No-Go。
10. control artifact 是否用 authenticated envelope 和安全 FD/handle 协议读取，并有 replay/race 测试？否则 No-Go。
11. 新 writer 是否由 store-level epoch/lease fencing 约束，并通过分区/陈旧写测试？否则 No-Go。
12. UI mutation、MCP 副作用、Secret 与 subprocess 是否分别有不可由 Agent/Skill 降级的认证、审计和资源上限？否则 No-Go。

## 13. 建议排期

以下为单人高强度开发、Agent 辅助但坚持真实门禁的低至中置信度估算区间，不是交付承诺：

| 阶段 | 预计 |
|---|---:|
| Phase 0 基线与本地 packed-install gate | 2–3 天 |
| Phase 1 Contracts/release roots | 4–6 天 |
| Phase 2 Skill Inventory/Resource Locator/供应链边界 | 6–9 天 |
| Phase 3 Execution Policy/Adapter capability | 6–10 天 |
| Phase 4 Worker 边界/authority/fencing | 7–11 天 |
| Phase 5 Hub/CLI 双启动器边界 | 8–13 天 |
| Phase 6 Tool Gateway MVP/安全隔离 | 14–24 天 |
| Phase 7 需求澄清/checklist 派生 | 6–10 天 |
| Phase 8 UI MVP/本地请求安全 | 15–24 天 |
| Phase 9 收口与迁移恢复验证 | 10–18 天 |

总量约 78–128 个有效开发日。实际取决于 Adapter session MCP 支持、跨平台安全打开/进程 containment、旧动态资源路径数量和数据 cutover 复杂度；不要通过跳过 packed install、真实 Agent、恢复或安全测试压缩工期。

## 14. 最终完成定义

全部满足才可称为 Monorepo 迁移完成：

- 源码按 apps/packages/resources 组织。
- npm workspaces 安装、构建、测试稳定。
- 用户仍只安装 `codepatchbay`。
- CLI/Hub/Worker/Gateway/UI 有明确进程与权限边界。
- Requirement、Skill、MCP、Sandbox 和 Execution Profile 全部版本化且可审计。
- Worker 只消费冻结执行清单。
- Gateway 只消费 Session Tool Manifest。
- Gateway 拒绝伪造/重放 manifest、server/schema 漂移、Secret/env/FD 泄漏与超预算进程树。
- UI/CLI/IM 使用同一个 Hub API 和 materialized state。
- 本地 UI mutation 通过 Host/Origin/session/CSRF/WebSocket 安全门禁。
- managed/standalone writer 由 store-level epoch/lease fencing 约束，cutover 在每个 I/O 故障点都可确定性恢复。
- 不存在旧/新双入口和永久兼容壳。
- `npm pack` 隔离安装、release gate、managed-worker E2E 和真实 Agent 验证全部通过。
- 迁移没有扩大默认外部副作用；draft PR 仍默认不自动合并。

## 15. 审查记录

### 15.1 独立架构审查

独立审查基于 `changw98ic/codepatchbay@7accc253ce3017840bd1960bea4fce66043220c4`，审查者未参与初稿编写、未修改文件。结论为“方向成立，但初稿有 6 个 P0 和 7 个 P1 必须修复”：

| ID | 级别 | 发现 |
|---|---:|---|
| IA-1 | P0 | Phase 1 创建 `packages/` 会被现有 release source allowlist 拒绝 |
| IA-2 | P0 | `npm pack --dry-run` 不能替代日常隔离全局安装门禁；现有完整 e2e 又带受保护远端副作用 |
| IA-3 | P0 | “一个 Event Store/Hub 单写”与当前 Registry/Queue/Assignment/Event/Artifact 多 aggregate store 不一致 |
| IA-4 | P0 | 当前 Claude `sessionMcpServers:false`，且 ACP 拒绝 MCP 时存在空 MCP fallback；原完成标准不可实现且会绕过策略 |
| IA-5 | P0 | 现有 role prompt skills 与根 agent integration skills 被混为一个 Registry，缺少 inventory/snapshot 阶段 |
| IA-6 | P0 | Requirement/Profile/Manifest hash 存在自引用且权限交集未定义 absent 与显式空集合 |
| IA-7 | P1 | workspace tsconfig 没有进入实际 typecheck/build 策略 |
| IA-8 | P1 | 根 `cpb` 与构建生成的 `dist/cpb` 是双启动器，初稿只处理了一份 |
| IA-9 | P1 | Requirement Contract 与现有 acceptance checklist 可能形成双合同 |
| IA-10 | P1 | 动态 `profiles/skills/templates` 路径缺少统一 Resource Locator |
| IA-11 | P1 | 新 canonical writer 启用后不能承诺任意 binary revert |
| IA-12 | P1 | Gateway/澄清公开 CLI 先于 CLI app boundary 会造成二次迁移 |
| IA-13 | P1 | 最低门禁遗漏 `verify:release-contracts` 与 `typecheck:strict:runtime-contracts` |

审查同时确认以下决策正确并应保留：单仓库/单安装包、内部 workspace private、根单 `dist` 产物、禁止 bare private-workspace runtime import、先抽精确合同、Worker 消费冻结 profile、Gateway 独立 stdio session、UI 只走 typed Hub API、小 PR 与 shadow→enforce。

### 15.2 独立审查修复

已逐条修复并写入正文：

1. Phase 1 同 PR 更新 release source roots/fingerprint/tests，并新增 `verify:release-contracts`。
2. Phase 0 新增无 GitHub/无真实 Agent/无 finalizer 的 `verify:packed-install-local`。
3. canonical 模型改为“一个 Control Plane authority + aggregate-specific canonical stores”，并明确 managed broker-only 与显式 standalone authority。
4. 新增 `SessionToolTransport`；Gateway-required session 禁止空 MCP fallback；Claude 仅在真实验证后列为支持。
5. 新增独立 Phase 2，区分 `RolePromptSkillV1`、`AgentIntegrationBundleV1` 和冻结 `ResolvedSkillSnapshotV1`。
6. 新增独立 digest preimage、tri-state policy source、canonical containment 与无自引用 hash 规则。
7. 明确迁移期根单编译 + workspace strict/noEmit + `typecheck:workspaces`，不贸然切 `tsc -b`。
8. Phase 5 同时切换根 `cpb` 与 `dist/cpb`，覆盖 executable mode、executor files、pack identity 和 runtime roots。
9. Requirement Contract 定为 intake authority；acceptance checklist 是带 revision/hash/sourceCriterionId 的派生产物。
10. 在移动资源前增加 Runtime Resource Manifest/Locator。
11. 回滚拆为 code/feature/binary/data 四类，新格式优先 sidecar，并记录 `minimumReaderVersion`。
12. Hub/API/CLI app boundary 提前到 Gateway 和澄清公开命令之前。
13. 最低门禁补入 strict runtime contracts、release contracts 和本地 packed install。

未拒绝任何 P0/P1；P2 中关于 UI stale asset 和工期置信区间也已采纳。第一轮修复后进入独立对抗性审查。

### 15.3 对抗性审查

第二位独立审查者未参与方案编写、未修改文件，并以“同一 OS 用户下的 Agent/MCP/Skill 进程也可能失控或恶意”为 threat model。审查结论为 6 个 P0、2 个 P1：

| ID | 级别 | 攻击或失败场景 |
|---|---:|---|
| AR-1 | P0 | Manifest 只有 profile hash 引用，修改 expiry、跨 session/Gateway 或重启后重放仍可能成功 |
| AR-2 | P0 | `realpath/lstat` 与实际 open 之间可交换 symlink/父目录，hardlink/reparse point 也可绕过 |
| AR-3 | P0 | 恶意网页通过 CSRF、DNS rebinding 或跨站 WebSocket 操作 loopback UI |
| AR-4 | P0 | 网络分区后旧 managed Worker 与新 standalone writer 使用陈旧 lease 并发写 |
| AR-5 | P0 | 恶意 Skill installer/MCP schema/result 利用 confused deputy 泄漏继承的 Secret/env/FD |
| AR-6 | P1 | audit 磁盘满或事件被删除/重排时，副作用调用仍可能继续且无法证明顺序 |
| AR-7 | P1 | fork bomb、double-fork、无限输出或 session storm 耗尽 PID/FD/memory/disk |
| AR-8 | P0 | 进程在 sidecar、rename、reader version 或 journal 边界崩溃，形成半迁移状态 |

审查确认以下基础设计无需推翻：aggregate-specific stores、managed broker-only、required-tool 禁止空 MCP fallback、独立 hash preimage、冻结 profile/Skill snapshot、两类 Skill 分离、无远端 packed-install gate，以及四类回滚模型。

### 15.4 对抗性审查修复

已全部采纳并写入正文：

1. `SessionToolManifestV1` 增加 manifest/session/lease/epoch/Gateway audience/revocation 身份；新增覆盖时间戳的 authenticated envelope 和 durable one-time activation。
2. 控制资源改为 descriptor-relative no-follow 安全打开，打开后只从已校验 FD/handle 读取，并加入 symlink/hardlink/rename/reparse race tests。
3. Phase 8 增加显式 loopback Host、短期 HttpOnly session、CSRF、精确 Origin、CORS-off、WebSocket nonce 和 CSP 门禁。
4. 统一 `MutationAuthorityV1`，mode 切换提升 epoch；canonical store 对每次 mutation/finalizer/journal commit 做 lease/epoch CAS。
5. Skill snapshot 增加 immutable content/provenance/trust/approval；installer 仅在显式安装事务运行；MCP executable/schema 钉住，result 标记 untrusted。
6. Gateway/下游 MCP 从空 env 创建，Secret 按 server/tool/audience/TTL 注入，禁止继承 token/proxy/cloud credential/多余 FD。
7. 有副作用调用改为 dispatch 前 append + fsync audit WAL；sequence/hash chain 和风险分类不能由 Adapter/Skill/模型降级。
8. 每 session 使用 OS containment unit 和 PID/CPU/memory/FD/disk/output/concurrency/time limits；Hub 增加 admission quota 与 circuit breaker。
9. Cutover 使用 fencing、五阶段 journal、明确 fsync 顺序与幂等 crash recovery；对每个 I/O 边界做 fault injection。

第二轮没有拒绝项。修复后再次检查发现与正文的可追踪关系，所有 P0/P1 均有合同、实施阶段、测试或 Go/No-Go 条件承接。
