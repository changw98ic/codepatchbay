# CPB v0.5 运行与发布稳定化规范

Status: Proposed — revision 9 for final independent hash confirmation

Target: `v0.5.0` 首次正式发布前的稳定化门槛

Decision owner: CPB maintainers

Tracked by: `flow-b7r` (`flow-gr2` records the original draft)

Related Beads: `flow-xxq`, `flow-d97`, `flow-4pt`, `flow-urs`,
`flow-c4h`, `flow-e68`, `flow-09m`, `flow-tcf`

Compatibility policy: 旧状态和旧产品面只允许一次性迁移；正式运行路径不保留双读、双写、别名、静默 fallback 或旧命令兼容。

Baseline date: 2026-08-03 (Asia/Shanghai)

Revision 2 addressed the seven P1 gaps found in the first independent review. Revision 3
addresses the second review findings: source/managed roots no longer conflict, queue writers
receive role-scoped ports through explicit authority handles, raw worker capability is never
persisted, idempotency and legacy mapping are deterministic, migration has an active state plus
explicit abort/commit recovery, generated evidence no longer changes its own source fingerprint,
and formal release receipts use a pinned Ed25519 trust boundary.

Revision 4 replaces the timing-based legacy-writer drain with durable writer leases and a
fencing epoch, keeps the readiness verifier in-process with an opaque public-key capability,
and closes the five smaller type, orphan-receipt, platform-env, install-receipt, and byte-contract
gaps found by the revision 3 review.

Revision 5 makes launcher admission a durable registration protocol, writes an immutable
migration initiation receipt before closing either admission fence, makes every pre-commit crash
state resumable or abortable, and fixes the remaining process-identity, hash-domain, and recovery-test
contracts found by the revision 4 confirmation review.

Revision 6 gives active-null recovery states a fail-closed locator, registers each recovery process
with one durable exclusive lease, makes activation replay idempotent after its commit point, and
binds launcher child authority to both admission and migration-state generations.

Revision 7 makes recovery authorization occur only under the maintenance lease, journals every
recovery durable mutation before execution, adds terminal-result replay, removes supersede in favor of full
abort-then-new migration, and initializes migration state before launcher activation commits so
fresh v2 startup has a complete legal path.

Revision 8 closes the two P1 and five P2 findings from the revision 7 independent review: aborted
cleanup is a first-class resolver result, selection removal is journaled as present-to-absent,
activation acquires a generation-bearing maintenance capability before state creation, resolver
snapshots bind launcher state pointers, unplanned payloads have a terminal audit path, and normal
migration rejects every leftover active recovery lease.

Revision 9 closes the three non-blocking P2 notes from the passing revision 8 review by freezing a
per-payload audit plan/completion schema and deterministic ID/path, defining absent-carrier no-op
handling, and documenting the no-selection-repair CLI shape for aborted cleanup.

## 1. 摘要

本规范定义 CPB v0.5 在正式发布前必须完成的五组工作：

1. 把 Hub 队列状态收口成一个唯一状态模型，迁移旧记录并消除统计不一致。
2. 让 `cpb doctor` 正确区分程序目录、运行数据目录和 Hub 目录，只报告真实存在的产品面和命令。
3. 用同一批真实 SWE-bench 样本证明“正确补丁不会再被误判为失败”，并完成真实服务商到草稿 PR 的发布证据。
4. 把散落的环境变量读取和关键弱类型收口到少量明确接口。
5. 让 README、贡献指南、安全说明、Agent 指令、CLI help 和 `package.json` 使用同一套事实。

目标读者是实现 v0.5 稳定化工作的 CPB maintainer 和审查者。maintainer 应能只依据
本文确定 Module Interface、数据迁移顺序、必改调用点、测试和发布退出条件；审查者
应能把每个“完成”声明追溯到命令、receipt 或外部 evidence。实施前需要 Node 20+、
可写的隔离 runtime/hub/release 目录；只有 Phase 3/4 需要 provider 凭据和可丢弃
GitHub 仓库。

Local Code Index v2 的接口与存储变更纳入本次 v0.5 发布：CLI 查询语法统一为位置参数式 canonical（`cpb code-index query definitions --symbol X`、`query references --symbol X`、`query inventory`），旧的 `--definitions`/`--references`/`--related-file` 选择器现为硬语法错误；查询结果 schema 调整（inventory 增加 `nodeCount`），持久化 `coverage` 字段从字符串枚举改为 summary 对象。上述破坏性变更可在稳定化版本接受，因为旧索引加载时会触发 `unsupported_index_schema` 守卫并自动重建为新的 summary 形态，无需维护者手工迁移（见提交 `c409f1d7`）。开始每个实施批次前都必须运行
`cpb code-index status -s .`；只有当次输出同时包含 `available: true`、
`fresh: true` 和 `exact: true` 时才可依赖该快照；还必须按 `tool.coverage` 限定声明范围。
`effective: "file-inventory-only"` 或 `partial: true` 只能证明文件清单，不能声称完整符号、引用
或调用关系。快照 ID 和文件数量会随源码变化，不属于长期规范。后续改动不得把索引写进
源码目录。

## 2. 当前事实基线

以下内容是 2026-08-03 的实测结果，不是目标值。

### 2.1 已健康的部分

- 源码启动器和全局 `cpb` 都报告 `v0.5.0`。
- 修订前重新构建后，本地代码索引为 available/fresh/exact，但当前 effective coverage 仍是
  partial file inventory；它只支持文件级定位，不作为完整符号图或调用图证据。具体快照和
  文件数量以每次 `status` 输出为准，不在本规范中固化。
- `npm run typecheck` 通过。
- `npm run typecheck:strict:engine` 通过。
- `isMutatingToolUpdate` 与验证基础设施的 32 项聚焦测试通过。
- 产品证据检查通过：3 条产品记录和 1 份官方评分包有效。

### 2.2 已确认的问题

| 范围 | 当前事实 | 直接影响 |
|---|---|---|
| 队列状态 | `queue.json` 为 version 1；一条 `failed` 记录仍保留退出 worker 的 `claimedBy`；另一条使用已移除的 `codegraph_unavailable` | Hub 显示总数 2，但只分类出 1 条失败记录；doctor 报告退出 worker 仍占用任务 |
| doctor 根目录 | `runReadinessChecks` 只接收 `cpbRoot`，把它同时当运行目录和程序目录 | JSON 中的 `executorRoot` 错误；依赖检查位置错误 |
| doctor 旧产品面 | 检查 `<cpbRoot>/server/node_modules`，建议 `cd server && npm install`，并仍描述 Web tests/build | 建议命令无法执行，健康结论失真 |
| 正确补丁误判 | 旧批次中 4 个官方 `resolved` 补丁均被 CPB 标为 `failed` | 不能证明 CPB 会保留正确交付结果 |
| 发布证据 | `docs/product/cpb-live-release-validation.json` 不存在 | `verify:live-release-evidence` 和 release readiness 必然失败 |
| 源码完整性 | release readiness 报告 `patchIntegrity.ok: false` | 当前工作状态不能打发布标签 |
| 配置读取 | 生产目录有 294 个不同 `CPB_*` 名称、422 行 `process.env` 直接读取 | 父子进程配置容易过滤、遗漏或解释不一致 |
| 类型债务 | 生产目录有 2,367 行 `LooseRecord` 使用；普通 `tsconfig.node.json` 为 `strict: false` | 状态字段和根目录字段可在编译期逃逸检查 |
| 文档 | `build:web`、Web UI、飞书/钉钉入口和“222 个主测试文件”等内容仍存在 | 新贡献者会执行无效命令或误判安全面 |

### 2.3 运行环境状态

这些状态不是源码缺陷，但会阻止真实发布验收：

- Hub 当前停止。
- Hub 认证、备份签名密钥和 GitHub App 未配置。
- 当前没有正式选中的 CPB release。
- 已有原始 Codex live E2E 成功记录，但没有经过正式 promotion，也没有满足本规范要求的临时草稿 PR 证据包。
- 上一轮确认的 Obsidian 长生命周期会话仍可能持有旧代码；重启前不得用它生成正式验收证据。

## 3. 目标

### 3.1 必须达成的结果

v0.5 发布候选必须满足：

- 所有队列记录只使用本规范定义的状态；未知状态不能被静默忽略。
- 只有实际活动中的记录可以持有 worker claim。
- Hub、doctor、jobs、task view、observability 和 release scripts 对同一份队列给出相同分类。
- `cpb doctor` 返回四个正确根目录，不再建议不存在的命令。
- 四个官方已解决样本在修复后的 CPB 中全部到达成功终态；第五个无源码补丁样本不得被错误标为成功。
- live release 证据通过现有 fail-closed 校验，release readiness 返回 `ready: true`。
- 关键运行路径不再直接读取 `process.env`，队列、doctor 和配置接口不再使用 `LooseRecord`。
- 主文档中的每条 `npm run` 命令都存在，每条 CPB 示例都符合当前 CLI 语法。
- 所有确定性测试、主测试、集成测试、发布门禁和真实验收全部通过。

### 3.2 质量目标

- 一处状态规则改动只需要修改一个 Module。
- 调用方不需要知道旧状态映射、claim 清理、汇总算法或迁移细节。
- doctor 的测试不需要启动真实 Hub、真实 agent 或真实 GitHub 连接。
- 环境变量解析错误在启动阶段一次性报告，不在工作流中途才暴露。
- 发布证据可追溯到原始运行、审计记录、草稿 PR 和校验摘要，不能人工拼装“成功”字段。

## 4. 非目标

本规范不做以下事情：

- 不新增或恢复 Web UI、飞书、钉钉或其他已移除产品面。
- 不实现多主机 active/active Hub；v0.5 仍是单机本地文件控制面。
- 不要求安装所有可选 agent；Codex 和 Claude 的必需能力与可选 adapter 必须分开报告。
- 不重写全部 17 万行生产 TypeScript，也不一次拆完所有超大文件。
- 不把历史运行失败改写成成功，不用旧官方评分替代新 CPB 运行。
- 不自动提交、推送、打 tag、合并或关闭临时 PR；这些操作需要发布维护者明确授权。
- 不自动终止用户的 ChatGPT、Codex 或其他长生命周期进程。
- Local Code Index v2 的 CLI 查询语法、查询结果 schema 与持久化 `coverage` 字段已纳入 v0.5（详见 §1 与提交 `c409f1d7`；旧索引经 `unsupported_index_schema` 守卫自动重建，无需手工迁移）；本次仍不改变索引存储位置规则（不得写入源码目录），也不新增索引后端。

## 5. 设计原则

### 5.1 单一事实来源

- 队列 runtime schema、状态、锁内写入和汇总由 `HubQueue` Module 唯一定义。
- CPB 根目录由 `CpbRoots` 值对象唯一定义。
- 环境变量由 `CpbConfig` Module 唯一解析。
- 命令列表以 `package.json` scripts 和 CLI command registry 为准。
- 发布结果以验证过的 evidence bundle 为准，不以文字说明或单个 phase 的 `passed` 为准。

### 5.2 深 Module

每个新 Module 必须用小 Interface 隐藏复杂 Implementation：

- 调用方不解析 `queue.json`，不自己判断终态，不自己清理 claim。
- 调用方不从模糊的 `cpbRoot` 推测程序目录。
- 调用方不直接读取 `process.env` 并重复默认值、别名或校验。
- 测试通过与调用方相同的 Interface 验证行为，不穿过 Interface 断言内部实现。

### 5.3 失败要明确

未知 schema、未知状态、非法状态跳转、根目录混用、未注册配置和不完整证据都必须返回明确错误。不得把未知状态投影成 `queued` 或 `running`，也不得漏计后继续返回成功。

## 6. 总体数据流

```text
queue v1 file
    -> explicit one-time migrator
    -> queue v2 file
    -> HubQueue Interface（锁内校验、写入与分析）
    -> Hub / doctor / jobs / task view / observability / release checks

process environment
    -> CpbConfig Interface
    -> immutable config snapshot + CpbRoots
    -> CLI / orchestrator / worker / verifier / doctor

agent events + deterministic evidence
    -> mutation progress classification
    -> completion decision
    -> real sample rerun
    -> provider bundle + draft-PR bundle
    -> live release manifest
    -> release readiness
```

## 7. HubQueue Module

### 7.1 Seam 与所有权

队列的外部 Seam 位于 `server/services/hub/hub-queue-v2.ts`。同一个深 Module
同时负责运行时解码、状态规则、queue 独占锁、revision 检查、assignment 身份核对、
原子发布和汇总；不能在锁外先算状态、再调用另一个函数写文件。

纯状态计算、filesystem、clock、ID 生成器和 assignment reader 可以作为 Module
内部 Seam，但不得为了测试出现在普通调用方的 Interface。测试使用临时 Hub 目录，
通过与生产调用方相同的 Interface 验证结果。

迁移完成后删除通用 `updateEntry`、公开的 `clearClaim`、`isActiveEntry`、
`summarizeFailedTargets` 以及 queue v1 loader。不得保留转发 facade。原
`hub-queue.ts` 中与 inbox/automation 无关的队列代码迁入新 Module，所有调用点一次性切换。

### 7.2 queue v2 完整数据结构

```ts
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type QueueStatus =
  | "pending"
  | "scheduled"
  | "in_progress"
  | "needs_issue_link"
  | "local_code_index_unavailable"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type QueuePriority = "P0" | "P1" | "P2" | "P3" | "P4";

export type QueueReason = Readonly<{
  code: string;
  message: string;
  details: Readonly<Record<string, JsonValue>>;
}>;

export type QueueEvidenceV2 = Readonly<{
  indexSnapshotId: string | null;
  schedulerDecision: JsonValue;
  indexEvidence: JsonValue;
  recoveryDecision: JsonValue;
  failureEvidence: JsonValue;
}>;

export type QueueEvidencePatch = Readonly<{
  indexSnapshotId?: string | null;
  schedulerDecision?: JsonValue;
  indexEvidence?: JsonValue;
  recoveryDecision?: JsonValue;
  failureEvidence?: JsonValue;
}>;

export type QueueClaimV2 =
  | Readonly<{
      kind: "orchestrator_reservation";
      ownerId: string;
      orchestratorEpoch: number;
      claimedAt: string;
    }>
  | Readonly<{
      kind: "worker_assignment";
      ownerId: string;
      workerId: string;
      assignmentId: string;
      attempt: number;
      attemptTokenSha256: string;
      claimedAt: string;
    }>;

export type QueueEntryV2 = Readonly<{
  id: string;
  projectId: string;
  type: string;
  priority: QueuePriority;
  description: string;
  mutating: boolean;
  status: QueueStatus;
  revision: number;
  claim: QueueClaimV2 | null;
  retryOf: string | null;
  lineageRootId: string;
  attempt: number;
  sourcePath: string | null;
  sessionId: string | null;
  cwd: string | null;
  executionBoundary: string;
  evidence: QueueEvidenceV2;
  metadata: Readonly<Record<string, JsonValue>>;
  result: JsonValue;
  reason: QueueReason | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}>;

export type QueueIdempotencyRecordV2 = Readonly<{
  keyHash: string;
  operation: "enqueue" | "retry";
  entryId: string;
  sourceEntryId: string | null;
  payloadSha256: string;
  createdAt: string;
}>;

export type QueueFileV2 = Readonly<{
  format: "cpb-hub-queue/v2";
  version: 2;
  revision: number;
  updatedAt: string;
  migration: Readonly<{
    migrationId: string;
    sourceVersion: 1;
    sourceQueueHash: string;
  }> | null;
  idempotency: Readonly<Record<string, QueueIdempotencyRecordV2>>;
  entries: readonly QueueEntryV2[];
}>;

export type QueueStatusCounts = Readonly<Record<QueueStatus, number>>;

export type QueueStatusSummary = Readonly<{
  total: number;
  byStatus: QueueStatusCounts;
  byProject: Readonly<Record<string, Readonly<{
    total: number;
    byStatus: QueueStatusCounts;
    activeMutatingTotal: number;
    failedTargets: number;
    retryingFailedTargets: number;
    retriedFailedTargets: number;
    unretriedFailedTargets: number;
  }>>>;
  activeMutatingTotal: number;
  failedTargets: number;
  retryingFailedTargets: number;
  retriedFailedTargets: number;
  unretriedFailedTargets: number;
}>;

export type QueueInvariantViolation = Readonly<{
  code:
    | "status_unsupported"
    | "claim_invalid"
    | "completion_time_invalid"
    | "revision_invalid"
    | "lineage_invalid"
    | "timestamp_invalid"
    | "summary_mismatch";
  entryId: string | null;
  message: string;
}>;

export type QueueAnalysis = Readonly<{
  summary: QueueStatusSummary;
  violations: readonly QueueInvariantViolation[];
}>;

export type QueueSnapshotV2 = Readonly<{
  file: QueueFileV2;
  analysis: QueueAnalysis;
}>;
```

queue 使用现有 16 MiB 上限的 bounded regular-file/no-follow 读取，并在 JSON parse 前拒绝
重复 object key。运行时 decoder 必须拒绝：非 v2 format/version、缺少必填字段、所有
closed object（file、migration、entry、claim、evidence、reason 和 idempotency record）
中的未知字段、
未知状态、非有限 JSON number、重复 ID、非法 ISO-8601 UTC 时间、非法 revision、
断裂的 retry lineage、idempotency ledger 冲突和违反 claim 规则的记录。`metadata`
与 `result` 可以承载扩展
JSON，但业务调用方若读取其中的字段，必须先通过该业务自己的 typed decoder；
不得把整个 entry 降级成 `LooseRecord`。

`idempotency` 以 raw key 的 exact UTF-8 bytes（不做 Unicode/空白 normalization）的
SHA-256 为 map key，不保存原始 key。每条记录绑定 operation、去掉 idempotency key 后的
RFC 8785 canonical command payload SHA-256、结果 entry 和可选来源 entry。同一个
key hash 携带相同 operation/payload 时返回原结果；携带不同 operation 或 payload 时返回
`HUB_QUEUE_IDEMPOTENCY_CONFLICT`，不能静默当作 duplicate。ledger 与 queue 在同一次
锁和原子发布中写入。只允许通过另行规范的原子 queue archival/compaction 同时移除已归档
entry 和对应 ledger；普通任务清理不得先删 ledger。
每个 ledger `entryId` 必须指向现存 entry；enqueue record 指向 root，retry record 的
`sourceEntryId` 必须等于 child 的 `retryOf`。不满足时 decoder fail-closed。
map key 必须是 64 位小写十六进制并与 record 的 `keyHash` 相同；payload hash 和
`attemptTokenSha256` 也必须是 64 位小写十六进制。所有 ID/project/type/session 字段为
1–256 UTF-8 bytes，description/reason message 为 1–65,536 bytes，reason code 为
1–128 bytes 且只含 `[A-Za-z0-9_.:-]`，path/boundary 为 1–32,768 bytes；nullable 字段只在
非 null 时检查。raw idempotency key 为 1–4,096 bytes。不能依赖下游日志或文件系统截断。

全新运行目录创建的 v2 文件使用 `migration: null`。从 v1 转换的文件必须保留
`migrationId` 和 `sourceQueueHash`；后续普通写入增加 revision 但不得删除或改写该绑定。

### 7.3 唯一写入 Interface

```ts
export type QueueEnqueueInput = Readonly<{
  projectId: string;
  type: string;
  priority: QueuePriority;
  description: string;
  mutating: boolean;
  sourcePath: string | null;
  sessionId: string | null;
  cwd: string | null;
  executionBoundary: string;
  indexSnapshotId: string | null;
  indexEvidence: JsonValue;
  metadata: Readonly<Record<string, JsonValue>>;
}>;

export type QueueRetryInput = Readonly<{
  sourceEntryId: string;
  expectedRevision: number;
  idempotencyKey: string;
  reason: QueueReason;
  evidencePatch: QueueEvidencePatch;
  metadataPatch: Readonly<Record<string, JsonValue>>;
}>;

export type IngressCommand = Readonly<{
  kind: "enqueue";
  idempotencyKey: string;
  input: QueueEnqueueInput;
}>;

export type SchedulerCommand =
  | Readonly<{
      kind: "reserve";
      entryId: string;
      expectedRevision: number;
      evidencePatch: QueueEvidencePatch;
    }>
  | Readonly<{
      kind: "handoff";
      entryId: string;
      expectedRevision: number;
      workerId: string;
      assignmentId: string;
      attempt: number;
      evidencePatch: QueueEvidencePatch;
    }>
  | Readonly<{
      kind: "transition_waiting";
      entryId: string;
      expectedRevision: number;
      to:
        | "pending"
        | "needs_issue_link"
        | "local_code_index_unavailable"
        | "blocked";
      reason: QueueReason | null;
      evidencePatch: QueueEvidencePatch;
    }>;

export type WorkerCommand =
  | Readonly<{
      kind: "accept";
      entryId: string;
      expectedRevision: number;
      evidencePatch: QueueEvidencePatch;
    }>
  | Readonly<{
      kind: "finish";
      entryId: string;
      expectedRevision: number;
      to: "completed" | "failed" | "blocked";
      reason: QueueReason | null;
      result: JsonValue;
      evidencePatch: QueueEvidencePatch;
    }>;

export type ReconcilerCommand =
  | Readonly<{
      kind: "reconcile";
      entryId: string;
      expectedRevision: number;
      to: "pending" | "failed" | "cancelled";
      reason: QueueReason;
      evidencePatch: QueueEvidencePatch;
    }>
  | Readonly<{
      kind: "retry_failed";
      input: QueueRetryInput;
    }>
  | Readonly<{
      kind: "fail_and_retry";
      input: QueueRetryInput;
      staleAssignmentId: string;
    }>;

export type OperatorCommand =
  | Readonly<{
      kind: "cancel";
      entryId: string;
      expectedRevision: number;
      reason: QueueReason;
      evidencePatch: QueueEvidencePatch;
    }>
  | Readonly<{
      kind: "retry_terminal";
      input: QueueRetryInput;
    }>;

export type QueueCommandResult =
  | Readonly<{ kind: "applied"; entry: QueueEntryV2; fileRevision: number }>
  | Readonly<{ kind: "duplicate"; entry: QueueEntryV2; fileRevision: number }>
  | Readonly<{
      kind: "conflict";
      entryId: string;
      expectedRevision: number;
      actualRevision: number | null;
    }>;

export interface QueueReaderPort {
  snapshot(): Promise<QueueSnapshotV2>;
}

export interface QueueIngressPort {
  submit(command: IngressCommand): Promise<QueueCommandResult>;
}

export interface QueueSchedulerPort {
  submit(command: SchedulerCommand): Promise<QueueCommandResult>;
}

export interface QueueWorkerPort {
  submit(command: WorkerCommand): Promise<QueueCommandResult>;
}

export interface QueueReconcilerPort {
  submit(command: ReconcilerCommand): Promise<QueueCommandResult>;
}

export interface QueueOperatorPort {
  submit(command: OperatorCommand): Promise<QueueCommandResult>;
}

// Internal to the Hub composition root; these handle types are owned by their
// authority Modules and have no JSON representation.
interface HubQueueComposition {
  readonly reader: QueueReaderPort;
  forIngress(session: AuthenticatedIngressSession): QueueIngressPort;
  forScheduler(lease: ActiveLeaderLeaseHandle): QueueSchedulerPort;
  forReconciler(session: ReconciliationSessionHandle): QueueReconcilerPort;
  forOperator(session: AuditedOperatorSessionHandle): QueueOperatorPort;
  forWorker(credentials: WorkerChannelCredentials): Promise<QueueWorkerPort>;
}

declare function createHubQueueComposition(
  dependencies: HubQueueDependencies,
): HubQueueComposition;
```

这里没有可复制的 `actor` 字符串，也没有由调用方保存的通用 permit。内部 composition
factory `createHubQueueComposition(...)` 接收 queue 路径、leader lease reader、assignment
store、worker store、operator audit sink、clock 和 ID source；它不从普通 package public
API 导出。composition root 按以下唯一合法路径把五个写端口交给实际服务：

- Hub API 或本机 CLI 先建立 authenticated/audited ingress session，再得到只允许
  idempotent enqueue 的 `QueueIngressPort`；ingress 只能设置初始 index evidence，其他
  evidence 字段由 Module 置为 null。
- scheduler 先从 leader Module 取得当前 live lease handle，再得到绑定该 epoch 的
  `QueueSchedulerPort`；每次 submit 都重新确认 lease 仍有效。
- reconciler 先用 assignment/worker store 建立有审计 ID 的 reconciliation session，再得到
  `QueueReconcilerPort`；每次 submit 都重读 session 涉及的 assignment 和 worker 状态。
- operator adapter 先完成认证并建立不可变 audit session，才能得到
  `QueueOperatorPort`；每个命令和结果都写入 audit sink。本机 CLI 也走同一 adapter。
- worker supervisor 在创建 assignment 时生成 256-bit 随机 attempt capability，只把原值
  通过受保护 IPC 交给对应 worker；assignment store 和 queue 仅保存它的 SHA-256。
  broker 用 `workerId + assignmentId + attempt + raw capability` 绑定
  `QueueWorkerPort`，Module 用固定长度字节和 constant-time compare 同时核对 assignment
  store、worker store 与当前 claim。raw capability 不得进入 queue snapshot、日志、错误、
  receipt 或可序列化 command。

`handoff` 不接收 capability：Module 从已存在且属于该 worker/attempt 的 assignment 读取
`attemptTokenSha256` 后写入 claim。因而复制 `QueueSnapshotV2` 里的 ID 和 hash 不能接受或
完成任务。assignment 建立但 handoff 失败的孤儿记录由 reconciler 清理；不能把明文 token
补写到 queue 来规避跨存储失败。

每个端口的 `submit` 都必须在同一次 queue 独占锁内重新读取并解码文件、验证端口绑定、
检查 entry revision、核对持久化身份、应用命令、验证整个文件、更新 revision、原子发布、
fsync 文件和父目录，然后重读确认。revision 不匹配返回 `conflict`；非法命令抛出明确
错误。不得暴露任意 patch、通用 `QueueCommand`、从 JSON 取得写权限或只靠 TypeScript
brand 的路径。`QueueEvidencePatch` 只能由相应角色写自己的字段：scheduler 写调度/
索引证据，worker 写索引/失败证据，reconciler 写恢复/失败证据；Module 拒绝越权字段。

### 7.4 唯一状态集合与 claim 规则

| 状态 | 含义 | 允许的 claim | 是否终态 |
|---|---|---|---:|
| `pending` | 等待调度 | `null` | 否 |
| `scheduled` | 已预留或已交给 worker、尚未接受 | reservation 或 worker assignment | 否 |
| `in_progress` | worker 已接受并执行 | worker assignment | 否 |
| `needs_issue_link` | 等待用户补 issue 关联 | `null` | 否 |
| `local_code_index_unavailable` | 等待本地索引恢复 | `null` | 否 |
| `blocked` | 等待明确外部条件或人工决定 | `null` | 否 |
| `completed` | 已完成 | `null` | 是 |
| `failed` | 已失败 | `null` | 是 |
| `cancelled` | 已取消 | `null` | 是 |

必须同时满足：

- `scheduled` 的 reservation claim 必须包含正整数 orchestrator epoch。
- `scheduled`/`in_progress` 的 worker claim 必须满足
  `ownerId === workerId`，且 assignment、attempt、`attemptTokenSha256` 与 assignment store
  一致；任何持久化位置都不得出现 raw attempt capability。
- `handoff` 是唯一允许的 `scheduled -> scheduled` 操作；它把 orchestrator reservation
  一次性替换成 worker assignment，不能只改其中几个字段。
- `accept` 只有在完整 worker assignment 身份一致时才可把 `scheduled` 改为 `in_progress`。
- 其他状态的 `claim` 必须为 `null`。进入等待态或终态时在同一命令中清空 claim。
- 终态必须有 `completedAt`；非终态必须为 `null`。
- 每次成功命令恰好增加 file revision 1。触碰已有 entry 的命令把该 entry revision 增加
  1；`enqueue` 新 entry 和 `retry_*` 新子 entry 从 revision 0 开始。`fail_and_retry`
  原子地把来源 revision 增加 1 并创建 revision 0 的子 entry。duplicate 不改变任何
  revision 或时间。所有时间都由 Module 设置。

### 7.5 状态跳转与重试 lineage

| 起点 | 合法端口与命令 | 结果 |
|---|---|---|
| `pending` | scheduler `reserve`；scheduler `transition_waiting`；operator `cancel` | `scheduled`、等待态或 `cancelled` |
| `scheduled` | scheduler `handoff`；worker `accept`；reconciler `reconcile`/`fail_and_retry`；operator `cancel` | 保持 `scheduled`、`in_progress`、`pending`、`failed` 或 `cancelled` |
| `in_progress` | worker `finish`；reconciler `reconcile`/`fail_and_retry`；operator `cancel` | `completed`、`failed`、`blocked`、`pending` 或 `cancelled` |
| `needs_issue_link` | scheduler `transition_waiting`；operator `cancel` | `pending` 或 `cancelled` |
| `local_code_index_unavailable` | scheduler `transition_waiting`；reconciler `reconcile`；operator `cancel` | `pending`、`failed` 或 `cancelled` |
| `blocked` | scheduler `transition_waiting`；reconciler `reconcile`；operator `cancel` | `pending`、`failed` 或 `cancelled` |
| `failed` | reconciler `retry_failed`；operator `retry_terminal` | 新建重试 entry，来源不变 |
| `cancelled` | operator `retry_terminal` | 新建重试 entry，来源不变 |
| `completed` | 无 | 不可转换或重试 |

原始 entry 必须满足 `retryOf: null`、`lineageRootId === id`、`attempt === 0`。
重试 entry 必须使用新 ID，`retryOf` 指向直接来源，`lineageRootId` 继承最初 entry，
`attempt === source.attempt + 1`。同一个来源和 idempotency key 只能产生一个重试；
同一来源不能同时有两个非终态子重试。自动 reconciler 只能重试 `failed` entry；
人工授权可以从 `failed` 或 `cancelled` 新建重试。`completed` 不称为重试，若要重新执行
必须作为新的 `enqueue` lineage。

`enqueue` 由 Module 生成新 ID，初始值固定为 status `pending`、revision 0、claim null、
root lineage/attempt 0、result/reason/completedAt null，并把非 ingress evidence 字段置 null。
`retry_*` 子 entry 复制来源的 project/type/priority/description/mutating/path/session/cwd/
boundary 和 metadata，再对 metadata 做 shallow merge；`_cpb*`、身份、lineage、claim、status、
revision 和时间字段禁止出现在 patch。子 entry 为 pending/revision 0/claim null/result null，
reason 使用 retry command 的 reason，evidence 按角色允许字段合并，时间/ID 由 Module 生成。
同状态 no-op 一律拒绝；唯一允许状态不变的写命令是具有新 assignment 身份的 `handoff`。

若 assignment/worker store 已证明活动 assignment 永久失效，reconciler 必须用
`fail_and_retry` 在一次 queue lock 和一次原子发布中：核对 stale assignment、把来源变为
`failed`、清空 claim、写 recovery/failure evidence、登记 idempotency record，并创建唯一
子 entry。不能先把来源标成 failed、崩溃后再无 ledger 地猜测是否已创建子任务。

### 7.6 汇总不变量

每个全局和项目级 `QueueStatusCounts` 都必须满足：

```text
total = pending + scheduled + in_progress + needs_issue_link
      + local_code_index_unavailable + blocked
      + completed + failed + cancelled
```

`activeMutatingTotal` 恰好等于 `mutating === true` 且 status 为 `scheduled` 或
`in_progress` 的 entry 数量；项目级值只在同一 projectId 内计算，全局值等于各项目值之和。

未知状态、lineage 重复、身份不匹配或等式不成立都返回
`HUB_QUEUE_INVARIANT_VIOLATION`，并使 Hub、doctor 和 release check 失败。
`jobs report`、task view 和 observability 必须消费 `QueueAnalysis`；它们可以改展示文字，
不能再维护状态集合、终态集合或 claim 解释。

失败重试汇总以 `lineageRootId` 为 target，并按 lineage 去重。一个 lineage 只要出现过
`failed` entry 就计入 `failedTargets`，再按互斥优先级恰好进入一个桶：若该 failed entry
之后存在任一 `completed` descendant，计入 `retriedFailedTargets`；否则若存在任一非终态
descendant，计入 `retryingFailedTargets`；否则计入 `unretriedFailedTargets`。因此必须满足：

```text
failedTargets = retriedFailedTargets
              + retryingFailedTargets
              + unretriedFailedTargets
```

后续 descendant 再次失败不会重复增加 target；只有 descendant 完成才从 retrying/unretried
移动到 retried。所有全局和项目级汇总都使用同一算法。

## 8. Queue v1 到 v2 的一次性迁移

### 8.1 唯一命令路径与正常运行规则

v0.5 必须把已有 release store Module 接到 CLI command registry，并只提供以下
正式升级路径：

```bash
./cpb release install --source <v0.5-source-root> --id <release-id> --json
<generationPath-from-install-json>/cpb release use <release-id> --migrate-queue-v2 --json
```

第一条命令必须从待安装的 v0.5 source/package executor 运行，并返回经过 manifest/hash
复核的 `releaseId`、绝对 `generationPath`、固定
`installReceiptPath = <generationPath>/.cpb-release-commit.json` 和 content hash。install 在返回
成功前还必须原子安装或验证唯一 managed launcher 已实现
`launcherAdmissionRegistrationProtocol: 1`，并把 launcher executable generation 和该协议版本
写入 install receipt；这一步不选择 target executor，也不能在没有 §8.3 platform isolation
capability 时伪造首次 protocol activation receipt。第二条必须直接运行这个已安装
generation 内的 launcher；
不能调用当前 PATH 中可能仍为 v0.4 的 `cpb`，也不能先把 v0.5 设为普通 active release
再补迁移。launcher 用 install receipt 构造 §9 的 staged-migration startup intent；该 target
executor 在 maintenance lease 内完成选择与状态迁移。

首次 activation 时，`release install` 必须通过平台 Adapter 真正取得并持续持有 isolation
capability；在任何 migration state/queue 写入前，再取得
`acquireHubMaintenance(hubRoot, "launcher-protocol-activation")` 返回的 v2 maintenance lease。
两者都持续持有到 activation receipt 与 open admission state 均 fsync/re-read 完成，isolation
还要持有到幂等 unmask 完成；任一取得失败则
install 在任何 activation state/queue 写入前整体失败，回滚 launcher 文件并恢复 supervisor 的
原状态，不能返回一个需要后续“补 receipt”的半成功。一旦 capability 已取得、旧入口已 mask
且开始 durable state/queue 写入，后续失败必须保持 mask 并返回
`CPB_LAUNCHER_ACTIVATION_INCOMPLETE`，
错误；只能按 §8.3 在同级 isolation 下幂等继续，不能重新开放旧入口。

`release use --migrate-queue-v2` 是唯一可读取 queue v1 的运行入口。普通
`release use`、Hub startup 和 `QueueReaderPort.snapshot()` 只接受
`format: "cpb-hub-queue/v2"`；遇到 v1 返回 `HUB_QUEUE_SCHEMA_UNSUPPORTED`。
迁移完成后不保留 v1/v2 双读、旧状态 alias、通用 migration callback 或隐藏脚本。

managed release 的选择链接固定为 `<runtimeRoot>/current`，选择记录固定为
`<runtimeRoot>/release/current.json`，release 内容位于 `releaseStoreRoot`。
安装到 PATH 的 managed launcher 必须通过该 `current` 链接启动选中的 executor；
`release use` 原子更新链接和选择记录。直接运行源码 checkout 的 `./cpb` 明确属于
source mode，只执行该 checkout，不能冒充 selected release。它只有在 §13 的 signed
session 同时包含 deterministic package hash 和 managed-install contract evidence 时才可为
该 candidate 生成正式 readiness；source-mode doctor 或源码测试本身不能。迁移期间停止旧进程后，新的 managed Hub 只能从选择后的 v2
executor 启动。

目标 release manifest 必须声明 `stateFormatVersions.queue: 2`。当前选择的来源 release
若存在，必须声明 queue 1，并声明/通过 contract test 证明
`hubMaintenanceFenceProtocol: 2` 和 `queueWriterRegistrationProtocol: 1`；不具备 durable
writer registration 的来源 release 返回 `HUB_QUEUE_MIGRATION_LEGACY_WRITER_UNFENCED`，
本规范不声称单靠取一次 queue lock 可以安全迁移它。managed launcher 与 install receipt
还必须声明并实测 `launcherAdmissionRegistrationProtocol: 1`；否则返回
`HUB_QUEUE_MIGRATION_LAUNCHER_UNFENCED`。自动迁移还必须验证 §8.3 activation receipt；
receipt 缺失表示“旧入口是否曾接纳未登记进程”未知，不能推断为安全。

尚未选择正式 release 时把 `previousReleaseId` 记录为 null。该离线分支只有在 §8.3 的
launcher startup lease 全部归零后，才能用 process registry + OS process identity scan 证明
没有仍可能访问该 hubRoot 的 queue1 executor，并验证正在执行迁移命令的源码本身支持
queue 2。正常 release selector 只接受当前代码支持的 queue 2；只有本节的迁移/中止流程
可以在持有 Hub maintenance lease 时验证来源 release 1。

离线证明不是两次时间采样本身。migrator 先 CAS 关闭 durable launcher admission，等待所有
旧 epoch startup lease 正常交接或退出，再做两次 scan：枚举 registry 中绑定 hubRoot 的
每个 exact process identity，并核对 OS executable realpath/generation；同时枚举 release store、
source allowlist 和 managed launcher generation 中所有尚未完成 registry 交接的 CPB process。
未知、权限不足、birth identity 精度不足、发现不支持 admission-registration 的旧 launcher，
或两次观察不一致都返回 unfenced error。一个正常 launcher 即使在第一次 state read 后暂停，
也必须先留下 startup lease；closing 后恢复时会在 generation recheck 失败，不能 spawn/exec。
scan 只可忽略 §8.3 规定的 current initiated migrator，或 mode 为 resume/abort 且
`authority_bound`/transition-null/active-pointer-matching 的 RecoveryLease exact owner；
两者都必须同时持有 matching maintenance generation；按 PID、命令名或工作目录做宽松
allowlist 都不允许。

完全不支持 `launcherAdmissionRegistrationProtocol: 1` 的旧 launcher 不允许走自动离线迁移。
维护者必须先由平台 Adapter 取得覆盖整个事务的外部 supervisor/namespace isolation capability，
证明旧 executable 已停止且所有启动入口被 mask；该 capability 不可序列化、不能由 CLI flag
伪造，并在释放前执行同样的 exact process scan。没有该平台能力时保持 Hub 停止并失败。
绕过 launcher 直接运行 source/retired generation 与直接改 queue 文件仍属 operator 越权，
不在自动迁移威胁模型内。

### 8.2 有证据的映射

migrator 先用 16 MiB bounded/no-follow、duplicate-key detecting v1 decoder 读取
`{version: 1, entries: [...]}`；version/entries 结构不符时返回 schema error，不进入下列映射。

| v1 内容 | v2 结果 |
|---|---|
| 已属于 §7 的正式状态 | 保持语义，转换为完整 v2 entry |
| `codegraph_unavailable` | `local_code_index_unavailable` |
| `canceled` | `cancelled` |
| 非活动状态残留 `claimedBy`/`claimedAt`/`workerId` | `claim: null`，写一条 correction 计数 |
| 未识别的额外顶层 JSON 字段 | 移入保留命名空间 `metadata._cpbMigration.legacyFields`，只作审计保存，运行时不得解释 |
| `agent_rate_limited`、`rate_limited`、`archived` 或其他状态 | 停止并返回 `HUB_QUEUE_LEGACY_STATE_REVIEW_REQUIRED`，不得猜测语义 |

`agent_rate_limited` 和 `rate_limited` 在当前代码中也可表示 provider 结果，不能据此
推断旧 queue entry 应变成 `blocked`。`archived` 也可能是清理结果而不是取消。
实施者必须先提供真实 queue/fixture 证据，再通过显式数据修正把这些 entry 改成
§7 状态；migrator 本身不增加未经证明的映射。

若 v1 metadata 已包含 `_cpbMigration`，迁移必须中止，不能覆盖。该保留区只保存
迁移前的 JSON 证据，任何运行逻辑都不得从中读取状态、claim 或重试语义。

迁移开始前，v1 中不得存在 `scheduled` 或 `in_progress` entry。存在时返回
`HUB_QUEUE_MIGRATION_ACTIVE_WORK`，维护者必须先在 v1 release 中完成、取消或恢复任务。
因此 migrator 不负责猜测活动 assignment/attempt 身份。

其余每个 v2 必填值必须按下表生成；这里没有“实现时自行选择”的默认值：

| v2 字段 | v1 到 v2 的确定性规则 |
|---|---|
| file `revision` | `0` |
| file `updatedAt` | 所有 entry 的最大 `updatedAt`；空 queue 固定为 `1970-01-01T00:00:00.000Z` |
| entry `revision` | `0` |
| `retryOf` / `lineageRootId` / `attempt` | 分别为 `null` / 当前 `id` / `0`；v1 没有可证明的正式 lineage |
| `type` | 原值为非空字符串时保留；缺失时为 `candidate` 并增加 correction；其他类型中止 |
| `priority` | 原值属于 P0–P4 时保留；缺失时为 `P2` 并增加 correction；其他值中止 |
| `mutating` | 旧值为 boolean 时保留；缺失时为 `true`，保持 v1 调度器的现有语义并增加 correction；其他类型中止 |
| `result` | 字段存在且为 JSON value 时原样保留；缺失时为 `null` |
| `reason` | 非空字符串转成 `{code: "legacy_reason", message: old, details: {}}`；缺失或空字符串为 `null`（空字符串增加 correction）；其他类型中止 |
| `completedAt` | 终态使用有效旧值；缺失或无效时使用有效 `updatedAt` 并增加 correction；非终态固定为 `null` |
| `createdAt` / `updatedAt` | 必须是有效 ISO-8601 UTC 且 `updatedAt >= createdAt`，否则整个迁移中止 |
| `sourcePath` / `sessionId` / `cwd` | 对应顶层字段为 string 或 null 时保留；缺失为 `null`；其他类型中止 |
| `executionBoundary` | 原值为 `worktree` 时保留；缺失时设为 `worktree` 并增加 correction；其他值中止 |
| `evidence` | 旧 `indexSnapshotId` 为 string/null 时保留，缺失为 null，其他类型中止；其余四个字段为 `null` |
| `claim` | 因活动 work 已在迁移前禁止，固定为 `null`；残留旧 claim 只增加 correction |

`id`、`projectId` 和 `description` 必须是非空字符串，entry ID 必须唯一，否则中止。
`metadata` 必须是 JSON object；旧字段迁入 `_cpbMigration.legacyFields` 后，运行字段按上表
从正式位置生成，不能从任意 metadata 猜测。

migrator 为每个 v1 entry 建立一条 `operation: "enqueue"` 的 ledger 记录。key 是旧
`entryKey` 语义的 canonical JSON（`projectId`、`description`、以及
`metadata.queueDedupeKey ?? metadata.originJobId ?? ""`）的 SHA-256；payload hash 来自
完整 mapped enqueue input，`entryId` 指向 mapped ID，`sourceEntryId` 为 null，
`createdAt` 等于 entry 的 validated `createdAt`。两个 entry 产生相同 key、不同 payload
或不同 entry ID 时，
返回 `HUB_QUEUE_LEGACY_IDEMPOTENCY_COLLISION`，不能任意选一个。`cli_retry` 只是旧 CLI
请求类型；没有 queue entry identity 的 `metadata.retryJobId` 不能证明 lineage，因此仍按
root entry 映射，旧引用仅留在 migration audit metadata 中。

### 8.3 migration state 与不可变 receipt

`prepared` 永远不代表完成。每个 generation 的 receipt 只追加、不改写；另有一个很小的
CAS state pointer 决定哪次迁移正在阻止 startup：

```ts
export type FileGenerationEvidence = Readonly<{
  dev: string;
  ino: string;
  size: number;
  mtimeNs: string;
  ctimeNs: string;
  birthtimeNs: string;
}>;

export type ExactProcessIdentityV1 = Readonly<{
  pid: number;
  birthId: string;
  birthIdPrecision: "exact";
  birthIdSource:
    | "darwin_proc_pidinfo"
    | "linux_procfs_starttime_ticks"
    | "windows_process_creation_time";
  incarnation: string;
  capturedAt: string;
}>;

export type HubMaintenanceLeaseSnapshotV2 = Readonly<{
  protocol: 2;
  hubRoot: string;
  operation: string;
  revision: number;
  generation: FileGenerationEvidence;
  ownerIdentity: ExactProcessIdentityV1;
  acquiredAt: string;
}>;

export interface HubMaintenanceLeaseV2 {
  readonly snapshot: HubMaintenanceLeaseSnapshotV2;
  assertCurrent(): Promise<HubMaintenanceLeaseSnapshotV2>;
  renew(): Promise<HubMaintenanceLeaseSnapshotV2>;
  release(): Promise<void>;
}

export function acquireHubMaintenance(
  hubRoot: string,
  operation: HubMaintenanceLeaseSnapshotV2["operation"],
  options?: Readonly<{ allowRestoreJournal?: boolean }>,
): Promise<HubMaintenanceLeaseV2>;

export type LauncherProtocolActivationReceiptV1 = Readonly<{
  format: "cpb-launcher-admission-activation/v1";
  protocol: 1;
  runtimeRoot: string;
  hubRoot: string;
  launcherExecutableRealpath: string;
  launcherContentHash: string;
  launcherExecutableGeneration: FileGenerationEvidence;
  migrationStateRevision: number;
  migrationStateGeneration: FileGenerationEvidence;
  initialQueue:
    | Readonly<{
        kind: "legacy_v1_observed";
        hash: string;
        generation: FileGenerationEvidence;
      }>
    | Readonly<{
        kind: "fresh_v2_created" | "existing_v2_verified";
        hash: string;
        generation: FileGenerationEvidence;
      }>;
  isolationProvider: "launchd" | "systemd" | "windows_job_object" | "container_namespace";
  isolationEvidenceSha256: string;
  activatedAt: string;
}>;

export type LauncherAdmissionStateV1 = Readonly<{
  format: "cpb-launcher-admission/v1";
  revision: number;
  epoch: number;
  admission: "open" | "closing";
  migrationId: string | null;
  initiatedSha256: string | null;
  migrationStateRevision: number;
  migrationStateGeneration: FileGenerationEvidence;
  updatedAt: string;
}>;

export type LauncherStartupLeaseV1 = Readonly<{
  format: "cpb-launcher-startup-lease/v1";
  revision: number;
  launcherId: string;
  epoch: number;
  handoffTokenSha256: string;
  launcherAdmissionRevision: number;
  launcherAdmissionGeneration: FileGenerationEvidence;
  migrationStateRevision: number;
  migrationStateGeneration: FileGenerationEvidence;
  operation: string;
  intendedHubRoot: string | null;
  launcherIdentity: ExactProcessIdentityV1;
  launcherExecutableRealpath: string;
  launcherExecutableGeneration: FileGenerationEvidence;
  handoff:
    | Readonly<{ phase: "starting" }>
    | Readonly<{
        phase: "registry_bound";
        childIdentity: ExactProcessIdentityV1;
        processRegistryGeneration: FileGenerationEvidence;
      }>;
  acquiredAt: string;
}>;

export type QueueWriterFenceV1 = Readonly<{
  format: "cpb-queue-writer-fence/v1";
  revision: number;
  epoch: number;
  admission: "open" | "closing" | "retired";
  migrationId: string | null;
  initiatedSha256: string | null;
  sourceQueueHash: string | null;
  updatedAt: string;
}>;

export type QueueWriterLeaseV1 = Readonly<{
  format: "cpb-queue-writer-lease/v1";
  writerId: string;
  epoch: number;
  operation: string;
  processIdentity: ExactProcessIdentityV1;
  executorRoot: string;
  executorContentHash: string;
  acquiredAt: string;
}>;

export interface QueueMigrationSelectionPort {
  compareAndWrite(input: Readonly<{
    carrier: "link" | "record";
    expectedGeneration: FileGenerationEvidence | null;
    expectedValueSha256: string | null;
    nextBytes: Uint8Array;
    nextValueSha256: string;
  }>): Promise<FileGenerationEvidence>;
  compareAndRemove(input: Readonly<{
    carrier: "link" | "record";
    expectedGeneration: FileGenerationEvidence;
    expectedValueSha256: string;
  }>): Promise<null>;
}

export type QueueMigrationState = Readonly<{
  format: "cpb-queue-v1-to-v2/state-v1";
  revision: number;
  activeMigrationId: string | null;
  lastCommittedMigrationId: string | null;
  updatedAt: string;
}>;

export type QueueMigrationInitiated = Readonly<{
  format: "cpb-queue-v1-to-v2/initiated-v1";
  migrationId: string;
  phase: "initiated";
  previousReleaseId: string | null;
  previousLinkGeneration: FileGenerationEvidence | null;
  previousRecordGeneration: FileGenerationEvidence | null;
  targetReleaseId: string;
  targetGenerationPath: string;
  targetExecutorHash: string;
  targetExecutorGeneration: FileGenerationEvidence;
  targetInstallReceiptPath: string;
  targetInstallReceiptHash: string;
  targetInstallReceiptGeneration: FileGenerationEvidence;
  migratorIdentity: ExactProcessIdentityV1;
  launcherActivationReceiptHash: string;
  launcherActivationReceiptGeneration: FileGenerationEvidence;
  launcherAdmissionEpoch: number;
  launcherAdmissionRevision: number;
  launcherAdmissionGeneration: FileGenerationEvidence;
  initialMigrationStateRevision: number;
  initialMigrationStateGeneration: FileGenerationEvidence;
  initialWriterFenceEpoch: number | null;
  initialWriterFenceRevision: number | null;
  initialWriterFenceGeneration: FileGenerationEvidence | null;
  initiatedAt: string;
}>;

export type QueueMigrationResolverSnapshotV1 = Readonly<{
  format: "cpb-queue-v1-to-v2/recovery-snapshot-v1";
  migrationId: string;
  migrationState: Readonly<{
    revision: number;
    generation: FileGenerationEvidence;
    activeMigrationId: string | null;
    lastCommittedMigrationId: string | null;
  }>;
  launcherAdmission: Readonly<{
    revision: number;
    epoch: number;
    admission: "open" | "closing";
    migrationId: string | null;
    initiatedSha256: string | null;
    migrationStateRevision: number;
    migrationStateGeneration: FileGenerationEvidence;
    generation: FileGenerationEvidence;
  }>;
  writerFence:
    | Readonly<{
        revision: number;
        epoch: number;
        admission: "open" | "closing" | "retired";
        migrationId: string | null;
        initiatedSha256: string | null;
        sourceQueueHash: string | null;
        generation: FileGenerationEvidence;
      }>
    | null;
  selection: Readonly<{
    linkReleaseId: string | null;
    linkGeneration: FileGenerationEvidence | null;
    recordReleaseId: string | null;
    recordGeneration: FileGenerationEvidence | null;
  }>;
  queue: Readonly<{
    format: "v1" | "v2";
    revision: number | null;
    hash: string;
    generation: FileGenerationEvidence;
  }>;
  backup:
    | Readonly<{
        hash: string;
        generation: FileGenerationEvidence;
      }>
    | null;
  initiatedSha256: string;
  preparedSha256: string | null;
  terminal:
    | Readonly<{
        kind: "committed" | "aborted";
        receiptSha256: string;
      }>
    | null;
  nonterminalGenerations: readonly Readonly<{
    migrationId: string;
    stage: "directory_only" | "initiated_only" | "backup_written" | "prepared";
    directoryGeneration: FileGenerationEvidence;
  }>[];
}>;

export type QueueMigrationRecoveryTransitionV1 = Readonly<{
  sequence: number;
  operation:
    | "adopt_active"
    | "close_launcher"
    | "close_writer"
    | "bind_source_queue"
    | "write_backup"
    | "append_prepared"
    | "repair_selection_link"
    | "repair_selection_record"
    | "remove_selection_link"
    | "remove_selection_record"
    | "publish_queue_v2"
    | "restore_queue_v1"
    | "retire_writer"
    | "append_committed"
    | "append_aborted"
    | "reopen_writer"
    | "commit_state"
    | "clear_active"
    | "reopen_launcher";
  resource:
    | "migration_state"
    | "launcher_admission"
    | "writer_fence"
    | "selection_link"
    | "selection_record"
    | "queue"
    | "queue_backup"
    | "prepared_receipt"
    | "committed_receipt"
    | "aborted_receipt";
  expected:
    | Readonly<{ kind: "absent" }>
    | Readonly<{
        kind: "present";
        revision: number | null;
        generation: FileGenerationEvidence;
        valueSha256: string;
      }>;
  next:
    | Readonly<{ kind: "absent" }>
    | Readonly<{
        kind: "present";
        payloadPath: string;
        payloadGeneration: FileGenerationEvidence;
        valueSha256: string;
      }>;
  plannedAt: string;
}>;

export type QueueMigrationRecoveryPayloadAuditPlanV1 = Readonly<{
  format: "cpb-queue-v1-to-v2/recovery-payload-audit-plan-v1";
  auditId: string;
  migrationId: string;
  attemptId: string;
  sequence: number;
  sourcePath: string;
  sourceGeneration: FileGenerationEvidence;
  sourceSha256: string;
  quarantinePath: string;
  terminalKind: "committed" | "aborted";
  terminalReceiptSha256: string;
  leaseInventorySha256: string;
  plannedAt: string;
}>;

export type QueueMigrationRecoveryPayloadAuditCompletedV1 = Readonly<{
  format: "cpb-queue-v1-to-v2/recovery-payload-audit-completed-v1";
  auditId: string;
  planSha256: string;
  quarantineGeneration: FileGenerationEvidence;
  quarantineSha256: string;
  completedAt: string;
}>;

export type QueueMigrationRecoveryLease = Readonly<{
  format: "cpb-queue-v1-to-v2/recovery-lease-v1";
  revision: number;
  authorityPhase: "acquired" | "authority_bound" | "terminal_replay";
  attemptId: string;
  predecessorAttemptId: string | null;
  migrationId: string;
  initiatedSha256: string;
  locatorKind: "active" | "initiated_orphan" | "committed_cleanup" | "aborted_cleanup";
  mode: "resume" | "abort" | "finish_commit";
  targetReleaseId: string;
  targetInstallReceiptPath: string;
  targetInstallReceiptHash: string;
  targetInstallReceiptGeneration: FileGenerationEvidence;
  targetExecutorHash: string;
  targetExecutorGeneration: FileGenerationEvidence;
  ownerIdentity: ExactProcessIdentityV1;
  launcherAdmissionEpoch: number;
  launcherAdmissionRevision: number;
  launcherAdmissionGeneration: FileGenerationEvidence;
  migrationStateRevision: number;
  migrationStateGeneration: FileGenerationEvidence;
  maintenanceLeaseRevision: number;
  maintenanceLeaseGeneration: FileGenerationEvidence;
  resolverSnapshot: QueueMigrationResolverSnapshotV1;
  currentSnapshot: QueueMigrationResolverSnapshotV1;
  transition: QueueMigrationRecoveryTransitionV1 | null;
  terminalResult:
    | Readonly<{
        kind: "committed" | "aborted";
        receiptSha256: string;
      }>
    | null;
  acquiredAt: string;
}>;

export type QueueMigrationPrepared = Readonly<{
  format: "cpb-queue-v1-to-v2/prepared-v1";
  migrationId: string;
  phase: "prepared";
  initiatedSha256: string;
  sourceQueueHash: string;
  sourceQueueGeneration: FileGenerationEvidence;
  expectedTargetQueueHash: string;
  expectedTargetQueueRevision: number;
  backupPath: string;
  backupHash: string;
  backupGeneration: FileGenerationEvidence;
  previousReleaseId: string | null;
  targetReleaseId: string;
  targetGenerationPath: string;
  targetExecutorHash: string;
  writerFenceEpoch: number;
  writerFenceRevision: number;
  writerFenceGeneration: FileGenerationEvidence;
  corrections: Readonly<Record<string, number>>;
  startedAt: string;
}>;

export type QueueMigrationCommitted = Readonly<{
  format: "cpb-queue-v1-to-v2/committed-v1";
  migrationId: string;
  phase: "committed";
  initiatedSha256: string;
  preparedSha256: string;
  sourceQueueHash: string;
  targetQueueHash: string;
  previousReleaseId: string | null;
  targetReleaseId: string;
  targetQueueRevision: number;
  targetQueueGeneration: FileGenerationEvidence;
  retiredWriterFenceRevision: number;
  retiredWriterFenceGeneration: FileGenerationEvidence;
  corrections: Readonly<Record<string, number>>;
  committedAt: string;
  rollbackFloorQueueVersion: 2;
}>;

export type QueueMigrationAborted = Readonly<{
  format: "cpb-queue-v1-to-v2/aborted-v1";
  migrationId: string;
  phase: "aborted";
  initiatedSha256: string | null;
  preparedSha256: string | null;
  observedQueueHash: string | null;
  observedQueueGeneration: FileGenerationEvidence | null;
  observedBackupHash: string | null;
  observedBackupGeneration: FileGenerationEvidence | null;
  orphanStage: "directory_only" | "initiated_only" | "backup_written" | "prepared";
  reasonCode: string;
  abortedAt: string;
}>;

```

`shared/hub-maintenance.ts` 的旧 lease Interface 必须直接升级为上述 v2 capability；不保留另一个
无 generation 的并行入口。acquire/renew/assertCurrent 都从已打开 lease handle 取得并返回 exact
revision/generation，调用方不能自行 stat 路径猜测；RecoveryLease 只绑定最近一次成功
`assertCurrent()` 的 generation。release 只删除 exact owner + generation 的 lease。

launcher protocol activation receipt 固定在
`<runtimeRoot>/launcher-admission/activation.json`。第一次从无注册协议的 launcher 切换时，
只有持有外部 supervisor/namespace isolation capability 的平台 Adapter 才能在停止并 mask
旧入口、完成 exact scan 后初始化 migration state、exclusive-create 该 receipt 和
`open/epoch 1` state。普通 install
不能自行声称“当前没有旧 launcher”；后续自动迁移必须验证 activation receipt 的 launcher
content hash/generation 仍匹配唯一 managed launcher。receipt 缺失或不匹配时，必须重新取得平台
isolation，不能用两次 scan 补造信任历史。

首次 activation 的 durable 顺序固定为：先取得并重验上一段的 isolation + maintenance，
再在已解析的 hubRoot 下 exclusive-create/re-read
revision 0、active/lastCommitted 都为 null 的 migration state；再在 isolation + maintenance
内从 handle 观察 queue。已有 v1 时只把 raw hash/generation 记为 `legacy_v1_observed`，留给显式
migration；queue path 与所有 legacy namespace 都不存在时，exclusive-create/fsync/re-read
空 `QueueFileV2 { migration: null }` 并记为 `fresh_v2_created`；已有 v2 只有完整 fresh/migrated
不变量已通过时才记为 `existing_v2_verified`。然后写/re-read immutable `activation.json`，绑定
state generation 和该 initialQueue evidence；最后 exclusive-create/re-read open launcher state，
再次绑定同一 state generation，之后才解除平台 mask。managed launcher 启动要求三者同时
有效。若在 state/queue→receipt 或 receipt→open 之间崩溃，旧入口仍被 supervisor mask，新 launcher
fail-closed；下一次 activation 只有在重新取得同一等级 isolation、复核 state/receipt/executable
后才能补后续步骤。不得在缺 receipt 时根据孤立 state/open 反向补造 activation evidence。

若仓库已出现 activation/open 但 migration state 缺失，视为旧半成品，普通 launcher 和迁移
命令都不能自行初始化；只有重新取得平台 isolation、证明没有 CPB process 并核对 activation
history 后，且当前 queue 是可验证 v1 或 `migration: null` 的 fresh v2，才可创建 active/last
均为 null 的 revision 0 state 并以新 activation generation 完成一次正式修复。若现有 v2 带
migration ID，必须先从完整 committed/retired/selection chain 人工取证；本自动 repair 不把
缺失 pointer 猜成 lastCommitted。
旧 activation/open 必须先按 generation 移入
`<runtimeRoot>/launcher-admission/quarantine/<repair-id>/`，再 exclusive-create 新 canonical
files；不得原地覆盖或把缺失 state 的旧 receipt 当成有效历史。

open state（包含 matching migration-state generation）的 durable write + parent-directory
fsync + re-read 是 activation commit point。commit
前失败按上一段继续；commit 后不得回滚 launcher/activation receipt。若在 open commit 后、
平台 unmask 前崩溃，重跑验证同一 receipt/open generation 后幂等 unmask；若 unmask 后、
install success JSON 返回前崩溃，重跑不得重新激活或生成新 receipt，只重读 install/activation
结果、确认入口已 unmask 并返回同一 JSON。重复 unmask、重复返回和“已是目标状态”都算同一
成功结果；任何不同 executable/content hash 则停止，不得覆盖 committed activation。

launcher admission state 固定在 `<runtimeRoot>/launcher-admission/state.json`，startup lease
固定在同目录 `leases/<launcherId>.json`。§9 的最小 parser 分流 recovery/audit 后，每个普通
managed launcher 在解析 selected release 或 spawn/exec child 前，必须读取 open epoch、
exclusive-create startup lease，再重读
state revision/generation，并读取 active 为 null 的 migration-state revision/generation；只有
两者都完全一致才可 spawn/exec。launcher 一直持有 lease，直到 child
以 exact process identity 和 intended hubRoot durable 写入 process registry、child 明确确认
尚未接触 queue，并把同一 registry generation 回写为 `registry_bound`。只有该交接重读成功
后才可删除 lease；失败路径必须先终止 child，再按 lease generation 清理。

launcher 在内存中生成 256-bit handoff token，只把 SHA-256 写入 startup lease/registry，raw
token 仅通过受保护 IPC 给 child。child 在 matching lease 已变为 `registry_bound`、registry
hash/identity/hubRoot 一致，再次观察同一 open epoch，并确认 migration state 仍为 active null
且 revision/generation 等于 lease 记录前，只能执行 bootstrap 或退出；Hub、
worker、queue port 都拒绝它。launcher 若在 spawn 后、registry handoff 前死亡，child 因而没有
运行 authority，必须退出；migrator 仍要做全 CPB process scan，不能只因 launcher 已死亡就
假定没有 child。

migrator 只在 verified `initiated.json` 和 active state pointer 已经 durable 后，CAS launcher
admission `open/E -> closing/E+1`，同时绑定 migration ID 与 `initiatedSha256`。closing 后新
startup lease 一律失败；旧 epoch lease 必须完成上述交接并使对应 process 可被 scan 观察，
或在 launcher/child exact identity 都已死亡后按 generation quarantine。migrator 等 lease
集合重读为 0 后才做离线 scan。因此：state read 后暂停的 launcher 会在 lease 后 recheck
失败；持有 lease 时暂停的 launcher 会阻止迁移；已完成 registry handoff 的 child 会被 scan
看见。commit 或 abort 收尾时才可把 matching closing CAS 回 `open/E+1`，且必须清空
migration binding；历史 epoch lease 永远不能在新 epoch 恢复权限。

queue1 writer fence 固定在 `<hubRoot>/writer-fences/queue-v1/state.json`，lease 位于同目录
`leases/<writerId>.json`，不放在会被迁移的 queue namespace 内。每个 queue1 mutator 在接受
写请求后的第一项 authority 操作必须：读取 open state/epoch，exclusive-create 自己的 lease，
再重读 state 的 revision/generation；三者仍一致才可继续。它在取 queue lock 前和原子发布前
都重新验证 lease identity 以及同一 open epoch，完成或失败后按 generation 隔离自己的 lease。
因此“已经通过检查但尚未登记”的 writer 不存在：登记之前没有写 authority；若它在第一次
state read 后暂停，恢复后创建旧 epoch lease，第二次 state check 会拒绝它。

migrator 只在 verified `initiated.json` 和 matching active state pointer 已落盘后，才可 CAS
`open/E -> closing/E+1` 并绑定 migration ID 与 `initiatedSha256`。closing 后新 lease 一律失败；
旧 epoch lease 必须等 owner 正常退出，或在 exact process identity 已死亡后按 generation
quarantine。只有 lease 集合重读为 0，migrator 才可取得 queue lock。fence 在整个事务中
保持 closing；v2 queue 发布并验证后先 CAS 为 retired，再写 committed receipt。retired
在 committed 存在后永久不可恢复为 open，所有 queue1 writer 因而永久失败；v2 Hub 使用
独立的 writer authority，不绕过或删除 v1 fence。若 retired 后、committed 前崩溃，recovery
只有在 queue hash/revision 仍等于 prepared target 时才能补 commit，或在恢复 v1 后以新
epoch 显式 reopen 并 abort。

若旧 writer 的 publication check 在线性顺序上早于 closing CAS，它仍可完成一次 v1 publish，
但其 durable lease 一直可见，migrator 必须等待它退出后才读取 source queue，因此该写入会被
包含在迁移输入中。check 晚于 closing 的 writer 必须失败。刚读过 open、却在 closing 后才
创建 lease 的进程会在 lease 后重检失败，它从未获得 publish authority；这三种交错都要有
确定性并发测试。

正常 queue1 首次启动用 exclusive create 建立 `open/epoch 1`。迁移时 fence 缺失只在
`previousReleaseId: null`、launcher admission 已按注册协议进入 closing、startup lease 为 0，
且 process registry 与 OS scan 都证明没有 queue1 process 的离线分支可接受；migrator 才可
exclusive-create `closing/epoch 1` 并绑定 initiated receipt。有 selected source release 却缺
fence、不支持 launcher registration、或 scan 不确定都 fail-closed。

所有 launcher/writer/process-registry identity 都必须使用 `ExactProcessIdentityV1`。decoder
只接受 `birthIdPrecision: "exact"` 和当前平台对应的三种 allowlisted source；quarantine 时
必须用同一平台 source 再观察 PID，证明原 birth ID 已死亡或 PID 已属于不同 birth ID。
wall-clock 秒级时间、只有 PID、来源未知或精度降级的 identity 一律不能删除 lease。

两个 state decoder 都是 closed schema。launcher `open` 要求 migration/initiated binding
均为 null；`closing` 要求两者均非 null，并匹配 active initiated，或只在 commit-cleanup
窗口匹配 `lastCommittedMigrationId` 及其 committed/retired chain。writer `open` 要求
migration/initiated/source hash 均为 null；`closing` 要求 migration/initiated 非 null，
source hash 只允许在取得 queue lock 后由 null 单向设为非 null；`retired` 要求三者全部非 null
并匹配 prepared/committed。每次 CAS 的 revision 必须严格递增；open→closing 和重新 open
必须提升 epoch，closing→retired 保持同一 closing epoch，epoch 永不下降。任何其他倒退或部分 binding 都返回
`HUB_QUEUE_WRITER_FENCE_INVALID`/`HUB_QUEUE_MIGRATION_LAUNCHER_UNFENCED`，不得修补默认值。
跨文件分析还要求 launcher state 的 migrationStateRevision/generation 等于当前 state；合法
CAS 窗口中不相等会让普通 startup fail-closed，只有原 migrator或 journaled recovery owner
可以完成下一步并 acknowledgement，不能被普通 launcher 当作 open authority。

state 固定在 `<hubRoot>/migrations/queue-v1-to-v2/state.json`。generation 位于
`<hubRoot>/migrations/queue-v1-to-v2/<migrationId>/`；其中 v1 备份为 `queue.v1.json`，
receipt 分别为 `initiated.json`、`prepared.json`、`committed.json`、`aborted.json`
四种；不再定义其他 terminal receipt。
所有文件都使用 bounded/no-follow 读取和 durable atomic write。receipt 记录 hash、计数、
release ID、文件 generation 和时间，不记录 secret 或任务正文。generation 每次都从已打开
regular-file handle 取得并在 rename/fsync 后重读，不能只用路径再次 stat 一个可能被替换的文件。

合法生命周期只有 `initiated -> prepared -> committed | aborted`；
initiated/prepared 都不可修改，terminal receipt 恰好一个且不可修改。备份已经落盘但
prepared 尚未落盘的 generation 允许直接追加 `aborted.json`，此时
`preparedSha256: null`。`state.json` 的每次变化必须在 maintenance lease 内对 revision
做 CAS；active pointer 只能指向已有且已重读验证的 initiated generation，prepared 随后必须
引用同一个 `initiatedSha256`。

只创建 generation 目录、尚无 initiated 时，任何 admission/fence/state 都不得改变；aborted
使用 `orphanStage: "directory_only"`，initiated/prepared 和两个 backup 字段都为 null。
已有 initiated 但无 backup 时使用 `initiated_only`，`initiatedSha256` 非 null、
`preparedSha256` 和 backup 字段为 null。backup 已验证时使用 `backup_written`，两个 backup
字段和 initiated hash 必须非 null、prepared hash 为 null。`prepared` stage 要求两个 receipt
hash 和 backup 两字段全非 null。其他 null/non-null 组合由 decoder 拒绝。

`QueueMigrationInitiated` 必须验证 activation/install receipt、migrator exact identity、两个
selection generation，以及当时 active-null migration state 与 open launcher state 的交叉绑定。
selected queue1 source 要求三个 initial writer-fence 字段全非 null 且为
open state；no-selection + fence 尚不存在时三者必须全 null。混合 null、target path 不等于
install receipt 所属 generation，target executor generation/content hash 不匹配，或 activation
launcher generation 不匹配当前唯一 managed
launcher 都使 initiated decoder/recovery fail-closed。

本节 queue/migration hash 的输入域固定如下：`sourceQueueHash`、`expectedTargetQueueHash`、
`targetQueueHash`、`backupHash`、`observedQueueHash`、`observedBackupHash` 都是已打开并通过
generation 校验的对应文件 raw bytes；`initiatedSha256`、`preparedSha256` 是完整 decoded
receipt（包含其全部字段）的 RFC 8785 bytes；`targetInstallReceiptHash` 是 install receipt
raw file bytes；`launcherActivationReceiptHash` 是完整 decoded activation receipt 的 RFC 8785
bytes，activation `initialQueue.hash` 是 observation/create 时从 no-follow handle 读取的完整
queue raw bytes，`isolationEvidenceSha256` 是平台 Adapter 固化的不可变 evidence raw bytes；
`targetExecutorHash` 和 `executorContentHash` 是确定性 installed-tree manifest 的 RFC 8785
bytes；`launcherContentHash` 是 deterministic managed-launcher installation manifest 的
RFC 8785 bytes，其中每个 regular file item 的 content hash 取 raw bytes；
`handoffTokenSha256` 是 32-byte raw handoff token。以上 queue/runtime hash 使用裸
64 位小写十六进制，不带 `sha256:`；
§13 的 release evidence hash 使用另一套带 algorithm prefix 的外部合同。

RecoveryLease 的 canonical snapshot 直接内嵌 closed typed values，并显式绑定 backup 与
prepared receipt，不能把它们从目录名或锁前观察补入。transition 中 state/fence/
selection-record 的 expected/next hash 取 decoded closed object 的 RFC 8785 bytes，selection
symlink 取 exact UTF-8 target bytes，queue/backup 取完整 raw file bytes，immutable receipt 取
完整 decoded object 的 RFC 8785 bytes。`expected.kind: "absent"` 表示 resource 必须不存在；
`expected.kind: "present"` 必须带 handle 取得的 generation/value hash，revision 只对有 revision
的 JSON resource 非 null。`next.kind: "present"` 必须带 immutable payload generation/hash；
`next.kind: "absent"` 只允许 selection link/record 的 remove operation。resource、operation、
presence kind 与 hash domain 不匹配时 decoder 拒绝。

present transition 不能只存 next hash，因为 dead-owner successor 必须能执行尚未开始的计划。
owner 先在固定的
`<generation>/recovery-payloads/<attemptId>/<sequence>.bin` 以 queue 文件同等级权限
exclusive-create/fsync/re-read 完整 next bytes，再把该 payload 的绝对 canonical path、
generation 和 hash 写入 lease plan。JSON resource/receipt 使用 RFC 8785 bytes，symlink 使用
exact UTF-8 target bytes，queue/backup 使用完整 raw bytes。plan decoder 要求 payload 位于本
migration generation、sequence/attempt 与 lease 一致且 no-follow handle 的 generation/hash
匹配；执行时只从该 handle 取 bytes。payload 已写但 plan 尚未 CAS 时不改变任何 authority，
只能由 §8.3 terminal cleanup/audit generation-safe 归档；plan 已写后 successor 不得重新计算
next value。

`remove_selection_link`/`remove_selection_record` 不创建 next payload。owner 在 plan 中绑定
present expected generation/hash，随后从已打开 parent directory 对 exact entry 做
generation-safe unlink、fsync parent 并重读确认 absent；崩溃后 present 表示尚未执行，absent
表示只补 acknowledgement，重新出现任意不同 generation/value 是第三状态并 fail-closed。
previousReleaseId 为 null 的 abort 必须对两个 selection carrier 分别使用这两个 remove
operation，不能直接 unlink 或写入 null/空字符串伪装不存在。
若 authoritative/current snapshot 已把某 carrier 记录为 absent，owner 在 maintenance 内再次
从 parent handle 确认 absent 后把该 carrier 视为已满足，不创建 remove transition、也不调用
`compareAndRemove`；另一个仍 present 的 carrier 独立 plan/remove/ack。若 snapshot 原为 present、
plan 前却变成 absent，必须重跑 resolver 更新整个 snapshot，不能把竞态静默当作成功。

release store Module 必须实现上述 `QueueMigrationSelectionPort`；它是由已验证 RecoveryLease
authority 构造的进程内私有 port，不加入普通 release selector 或公共 CLI。`compareAndRemove`
落实上一段的 no-follow/generation/hash/unlink/fsync/re-read 协议；当前只有 select/write、没有
remove 的内部实现要迁入同一组 CAS primitives，不另留 raw unlink 或并行兼容入口。

migration 命令要求 activation 已生成并绑定可解码的 state；缺失时返回
`HUB_QUEUE_MIGRATION_RECOVERY_REQUIRED`，不能在 staged migration bootstrap 中初始化。
state 只能由上述 protocol activation/isolated repair 首次创建；已存在但解码失败的 state
不能用“重新初始化”覆盖。

recovery 分成不授予权限的 discovery 与 maintenance 内的 authoritative resolver。锁前只允许
最小 parser 解析 fixed executor/install receipt 和 untrusted CLI locator，最多定位候选 ID；
不得缓存 selection/fence/terminal/唯一性结论。随后必须先取得 matching maintenance lease，
再从已打开 handle 完整重读 migration state、activation、launcher/writer state 与 leases、
selection 两载体、queue、候选 receipt chain 和全部 generation inventory。closed resolver 只在
该 lease 内产生以下结果：

1. `active`：ID 只来自非 null active pointer；CLI ID 若存在只能做相等检查。
2. `committed_cleanup`：active 为 null 且 launcher closing；ID 必须同时等于 lastCommitted 和
   launcher binding，并验证完整 initiated/prepared/committed、retired writer、selection/queue。
3. `aborted_cleanup`：active 为 null、launcher closing、writer open；ID 只来自 launcher binding，
   并验证 matching initiated/aborted、无 committed sibling、queue/selection 已恢复到 abort
   允许状态且 state lastCommitted 未被该 ID 改写。它只授权 reopen launcher，不重新采用 active、
   不触碰 queue/selection/writer。
4. `initiated_orphan`：active 为 null、两个 admission open、CLI ID 通过 containment 后指向
   无 terminal 的 initiated；当前 executor/install/selection/fence 必须仍等于 initiated 初值，
   且 inventory 中它是唯一 nonterminal generation；其他 directory-only orphan 也必须先 audit。
5. `pending_transition`：active RecoveryLease 存在、exact owner 已死亡且包含未确认 plan；ID、
   mode 和唯一 next action 都来自该 lease。resolver 验证 resource 仍为 expected 或 next，随后
   只允许 generation-safe takeover/执行/ack，不能重新选择动作。
6. `terminal_replay`：不授予 queue authority。committed ID 只从 lastCommitted 派生；aborted
   ID 可由严格 CLI locator 或尚未归档的 RecoveryLease 定位。resolver 验证 immutable terminal
   chain 且该 ID 没有 committed sibling。committed replay 还要求 active null、queue/selection/
   retired fence 与 lastCommitted 最终状态一致；launcher closing 时只允许 committed cleanup。
   aborted replay 要求该 ID 非 active、无 live RecoveryLease（terminal-consistent dead lease
   只能按 generation 归档）、launcher open，并满足二者之一：
   当前仍是合法 v1/open-writer 状态；或当前已是另一个 lastCommitted ID 的完整 migrated-v2
   终态。后者只是证明 abort 后发生了合法单向迁移，不向旧 ID 转移任何 authority。当前存在
   另一个 active migration、部分 v2 或不完整 successor chain 时拒绝 replay。

`active`、`initiated_orphan`、`committed_cleanup`、`aborted_cleanup` 和
`pending_transition` 是需要完成 durable 转换的 authority-bearing 结果。resolver 为它们生成完整
`QueueMigrationResolverSnapshotV1`；进程随后 exclusive-create/re-read
`QueueMigrationRecoveryLease`，把 state、launcher、writer fence、selection 两载体、queue、
backup、prepared、terminal 和按 migration ID 排序的全部 nonterminal generation/stage/directory
generation 绑定在 `resolverSnapshot`，
`currentSnapshot` 初始与它相同。紧接着再次从 handle 重读并重新运行 resolver，第二份
canonical snapshot 必须与 lease 中的 snapshot byte-for-byte 相同，才可执行任何转换。
这样两个锁前 discovery 即使串行取得 maintenance，后一个也不能复用前一个的旧结论。

completed `terminal_replay` 是只读结果，不创建新的 RecoveryLease：resolver 在同一
maintenance 下按上一段再次验证完整 terminal chain，以及 committed 的当前最终状态或 aborted
的 immediate-v1/合法 migrated-v2 successor 状态；
若遗留 dead lease，只可按其 exact generation 原样归档并记录 terminal-state-proven 原因，
不能借机执行或补造转换；返回前还必须完成/重放 unplanned-payload audit，存在对应 archived
attempt 的 live owner 时返回 recovery-in-progress。之后才从 terminal receipt 返回结果。
directory-only/initiated-only audit
也不创建 RecoveryLease，只在 audit
前提仍成立时 exclusive-create 对应 aborted receipt。两条路径都不获得 queue authority。

lease 的 `locatorKind` 记录最初授权来源，`mode` 记录本 attempt 的唯一动作，两者在 takeover
和终态都不改写。decoder 要求 initiated_orphan 只配 resume/abort；active 无 terminal 时只配
resume/abort，已有 committed 时规范化为 finish_commit，已有 aborted 时规范化为 abort；
committed_cleanup 只配 finish_commit，aborted_cleanup 只配 abort。pending-transition successor
必须继承 predecessor 的
locatorKind、mode、authority phase 和唯一 plan。`authorityPhase: "terminal_replay"` 要求
transition 为 null、`terminalResult` 非 null且与 current snapshot 的 terminal 相同；其他 phase
的 `terminalResult` 必须为 null。target/install/executor/owner/maintenance 字段与
authoritative snapshot 不一致时不授予权限。

因此，从 active 开始的 lease 在 clear-active ack 后仍保留 `locatorKind: "active"`，但 current
resolver result 可以是 committed_cleanup/aborted_cleanup；它不需要也不得把 origin 改写。
只有没有 predecessor lease、直接从该 cleanup 状态创建的 attempt 才使用对应 cleanup locator。

正常 migrate 在 §8.4 分配新 ID 前，也必须在 maintenance 内做同一 generation inventory；
active RecoveryLease 集合也必须为空。terminal migration 的遗留 lease 先走 terminal replay/
archive，live owner 返回 recovery-in-progress，nonterminal lease 返回 recovery-required；普通
migrate 不负责顺手清理。任何未被 plan 引用、也尚未有 quarantine audit receipt 的 recovery
payload 同样要求先运行 audit。只要存在任何无 terminal 的 generation（包括空目录、initiated-only、backup-written 或
prepared）就返回 recovery/audit required，不得创建第二个 orphan。若历史
上已有多个 orphan，`release audit-queue-migration <id> --orphan-generation` 可逐个清理：在 maintenance
内确认 active null、两个 admission open且该 ID 没有 RecoveryLease。initiated-only 还要求该
generation 无 backup/prepared/terminal，且 migration state、launcher admission、writer fence
和 active RecoveryLease 当前都不绑定该 ID，才可追加 initiated-only aborted。因为 initiated
落盘时尚未取得 active 或关闭 admission，selection/queue/fence revision 此后发生的、不绑定该
ID 的正常外部变化不妨碍该 append-only 清理，也绝不能被 audit 回滚。directory-only 必须证明
generation 内没有任何 recognized/unknown entry，除目录 generation 外没有可比较的历史值；
它只追加 directory-only aborted，不声称外部 state 从建目录后未变化。该 audit 不采用 active、
不关闭 admission、不获得 queue authority，因此不要求 orphan 唯一。存在 backup/prepared、
unknown entry 或任何当前资源绑定该 ID 时停止人工取证。

```bash
<v0.5GenerationPath>/cpb release audit-queue-migration <migration-id> \
  --orphan-generation --json
```

重复 audit 在同一 aborted hash 上返回相同 JSON；不同 terminal bytes 或同 ID 的 committed
receipt 一律冲突失败，不能覆盖。

payload fsync 后、plan CAS 前的文件不授予 authority，也不能永久遗留为无主状态。migration
进入 completed committed/aborted 终态且 active RecoveryLease 已归档后，terminal cleanup 必须
inventory active/archive lease 的全部 transition 引用；只对不被任何 plan 引用、所属 exact owner
已死亡，或 owner 正是持有 matching maintenance 的 current terminal-replay process，且 attempt
已归档的 payload，逐个运行确定性 audit。

每个 payload 的 `auditId` 是以下 RFC 8785 object 的 SHA-256：固定 format
`cpb-queue-v1-to-v2/recovery-payload-audit-key-v1`、migrationId、attemptId、sequence、固定
sourcePath、sourceGeneration、sourceSha256、terminal kind/receipt hash。`auditId` 使用 64 位
小写十六进制、无 algorithm prefix。plan 固定在
`<generation>/recovery-payload-audits/<auditId>/planned.json`，completed receipt 固定在同目录
`completed.json`，quarantine path 固定为
`<generation>/recovery-payload-quarantine/<attemptId>/<sequence>-<auditId>.bin`。
`planned.json` 使用 `QueueMigrationRecoveryPayloadAuditPlanV1`，还绑定排序后全部 decoded
active/archive lease 的 RFC 8785 inventory hash；移动前必须 exclusive-create/fsync/re-read plan。

执行时只有两个合法状态：source 与 plan 的 generation/hash 一致且 quarantine absent 时，按
generation rename、fsync 两个 parent 并重读；或 source absent 且 quarantine 的 raw hash 与
plan 一致时，只补 `QueueMigrationRecoveryPayloadAuditCompletedV1`。两边同时存在、同时缺失或
任一第三 generation/hash 都 fail-closed。多个 payload 按 attemptId/sequence/auditId 排序、每个
使用独立 auditId；崩溃后先重放已有 plan/completed，再继续下一项，因此“已移动第一个、第二个
未开始”不会生成新批次或重复 receipt。若自动 cleanup 在 plan/rename/completed 任一点崩溃，
以下同一 audit scope 可幂等完成；nonterminal migration、live owner、仍被任一 transition 引用
或 inventory 不完整时只报告并拒绝移动：

```bash
<v0.5GenerationPath>/cpb release audit-queue-migration <migration-id> \
  --unplanned-recovery-payloads --attempt <attempt-id> --json
```

该 quarantine/audit receipt 不是 migration terminal receipt，不改变四种 lifecycle receipt，也不
参与 queue authority。

recovery active lease 固定在
`<hubRoot>/migrations/queue-v1-to-v2/recovery-leases/<migrationId>.json`。同一 migration 只允许
一个 active attempt；exact owner 只要仍活着就始终返回
`HUB_QUEUE_MIGRATION_RECOVERY_IN_PROGRESS`，不因 maintenance generation 过期而抢占。只有
owner exact identity 已死亡且旧 maintenance generation 无效时，新 owner 才能在当前
maintenance 内接管。接管不能先把 active lease rename 走：新 owner 先把旧 lease exact bytes
exclusive-create/re-read 到固定
`recovery-attempts/<old-attemptId>.json`，再以旧 active lease revision/generation 为 expected，
原子 CAS 同一路径为新 attempt。新 attempt 写入 `predecessorAttemptId`，并继承原
locator/mode/authority phase、最后 acknowledged current snapshot 和 pending transition。
若在 archive copy 前后崩溃，旧 active lease 仍在；若在 CAS 后崩溃，新 lease 已完整包含计划。
因此任何时刻都不会出现“pending plan 只在 archive、active slot 为空”的授权空窗。
transition 为 null 时也不得回到更早动作或重新计算 next value。

exact owner 自己若因 maintenance renewal 失败而失去原 generation，必须立刻停止资源操作；
它只能以同一 exact identity 重新取得 maintenance、完整重跑 resolver，并在 resource 仍为
current snapshot 或 pending transition 的 expected/next 值时，CAS lease 仅更新
`maintenanceLeaseRevision`/`maintenanceLeaseGeneration` 后继续。该 self-rebind 不改变
locator/mode/phase/plan；任一外部
值出现第三种状态就 fail-closed。其他进程即使知道 attemptId 也不能走 self-rebind。

每一次 recovery-time migration-state、launcher-admission、writer-fence、selection 或 queue
CAS，以及 backup/prepared/committed/aborted 的 exclusive-create，都使用同一 write-ahead
小协议：owner 先 CAS RecoveryLease revision 写入唯一 `transition`（operation、resource、
closed expected presence/generation/value，以及 present next 的 immutable payload
generation/hash或 absent next）；present payload 按上一段先于 plan 写入，但不改变 authority；
plan CAS 成功后才执行资源 write/CAS/exclusive-create 或 generation-safe remove 并重读；最后
CAS lease acknowledgement，更新 `currentSnapshot` 和 lease
顶层 current state/admission generation并清空 transition。`resolverSnapshot` 保持 immutable，
作为本 attempt 的授权起点证据；
transition 非 null 时，owner 或 dead-owner successor 只有两种权限：资源仍等于 expected
presence/value 时执行该 write/CAS/remove；资源已等于 next presence/value 时只补
acknowledgement；第三种值立即 fail-closed。未清 transition
时不能开始下一步、运行普通 scan 或执行其他修复。

`acquired` lease 只能完成进入所选 mode 所需的前置动作：initiated_orphan 先 journal/CAS 采用
active；active 或刚采用的 orphan 在 launcher open 时再 journal/CAS 为 closing；已经 matching
closing 的 active、以及只需 reopen launcher 的 committed_cleanup/aborted_cleanup 不重复动作。
每项完成
acknowledgement 且 snapshot 重验后才变成 `authority_bound`。该 phase 只授予 mode 和 current
snapshot 明确列出的下一步，不是通用 queue 权限。后续 backup/receipt 写入及 commit/abort
收尾也逐步 plan→write/CAS→ack，因此 lease 不会因 owner 自己的合法变化静默失去权限。

terminal receipt 已写并完成所有相应 cleanup、current snapshot 也重验为唯一最终状态后，
owner 才把 lease CAS 为 `authorityPhase: "terminal_replay"`，写入 immutable
committed/aborted receipt hash并永久移除 queue authority；随后先 exclusive-create/re-read
同 attemptId 的 immutable archive copy，再按 active lease generation 删除 active slot；然后按
§8.3 的规则 quarantine/replay unplanned-payload audit，最后才从 terminal receipt 重建确定性 JSON。
archive copy 后、active 删除前的重复副本必须 byte-for-byte
一致；terminal resolver 可幂等完成删除，不能把它解释为两个 attempt。

若在 terminal receipt write/ack、最后 cleanup、`terminal_replay` phase、归档或 JSON 返回之间
崩溃，下一次调用先取得
maintenance，按 closed resolver 处理 pending transition、committed_cleanup 或
aborted_cleanup；dead lease 可归档，已归档则直接
验证 terminal chain并返回同一 JSON。它不得重新触碰 queue、selection 或 writer fence。
directory-only/initiated-only audit 也从 aborted receipt 重放同一结果。

全 CPB process scan 只忽略两种 exact current owner：initiated 中的原 migrator必须同时是
当前进程并持有 matching maintenance lease；或 mode 为 resume/abort、active state 指向本 ID、
`authority_bound`、transition 已确认为空的 RecoveryLease owner，且 snapshot、target executor、
state/admission 和 maintenance generation 已刚刚重读匹配。按命令名、PID、目录或历史 lease
做 allowlist 都不允许。

### 8.4 完整事务顺序

`<generationPath>/cpb release use <release-id> --migrate-queue-v2` 必须按以下顺序执行：

1. 确认目标 release、固定 install receipt、executor tree hash 和 queue 2 manifest 全部一致，
   但锁前不把 selection/fence/orphan 观察当 authority。
2. 取得 `acquireHubMaintenance(hubRoot, "queue-v1-to-v2")` maintenance lease，验证 activation
   已绑定存在且可解码的 migration state；在锁内 inventory 全部 generation 和 active
   RecoveryLease slot 与 recovery payload inventory，任何 nonterminal generation、active lease
   或未审计 payload 都拒绝新迁移；terminal
   dead lease 必须先由单独 terminal replay 归档，live lease 返回 recovery-in-progress。随后读取
   并记录两个 selection 载体/generation（未选择则 previous
   为 null），要求 Hub/orchestrator 已停止，并做一次活动 leader、worker、assignment 和 queue
   entry 预检。该预检不能替代关闭 admission 后的最终检查。
3. 分配 migration ID，exclusive-create generation 目录；先 durable 写入并重读
   `initiated.json`，绑定 previous/target、target install receipt、executor hash/generation、exact migrator
   identity、launcher activation receipt、两个 selection generation、launcher admission、
   当前 active-null migration-state generation 和初始 writer-fence generation。计算
   `initiatedSha256`。此步前后都尚未关闭任何 admission。
4. 对 migration state 做 revision CAS，把 `activeMigrationId` 从 null 设为本 ID，并重读验证
   matching initiated receipt。所有新 launcher 在 spawn/exec 前也必须检查 active pointer；
   非 null 时失败。若此后崩溃，recorded target 已足以运行 recovery。
5. CAS launcher admission `open/E -> closing/E+1`，绑定 migration ID/initiated hash 和步骤 4
   的 migration-state generation；等待旧
   startup lease 完成交接或退出，并按 §8.1 做 process registry + OS scan。没有 protocol 时
   必须持有外部 isolation capability，否则中止且不进入 writer fence。closing 保持到 commit
   或 abort 收尾。
6. 对 queue1 writer fence 做 CAS：`open/E -> closing/E+1` 并绑定 migration ID/initiated hash；
   离线 no-selection 分支按 §8.3 exclusive-create matching closing state。等待全部旧 epoch
   lease 正常退出，只在 exact identity 已死亡时 quarantine，并两次重读 lease 集合为 0。
7. 在两个 admission 都 closing + maintenance 下取得 queue 独占锁，并持有到步骤 14。再次
   读取 v1，核对 leader、worker、assignment store、queue、process scan 和 selection 都没有
   活动或外部变化；把 source queue raw-byte hash CAS 写入同一 writer fence。任何校验失败
   都不得写 queue。
8. 确定性生成完整 `QueueFileV2`；先 durable 写入 v1 备份，再写 `prepared.json`，其中引用
   exact `initiatedSha256`。每一步都重读验证，此时不能写 terminal receipt。
9. 在 maintenance lease 仍有效时选择目标 queue 2 release。若随后崩溃，新 Hub 会同时被
   launcher closing 和 active pointer 阻止，旧 queue 1 release 不会重新取得选择权。
10. 原子发布 v2 queue，fsync 文件和父目录；重读、运行 runtime decoder 和全部
    QueueAnalysis 不变量，并确认 raw-byte hash 等于 `expectedTargetQueueHash`。
11. 只有步骤 10 全部成功后，把 writer fence 从 matching closing CAS 为 retired，记录并
    重读 fence revision/generation。retired 永久拒绝 queue1 publish。
12. durable 写入并重读 `committed.json`，绑定 initiated/prepared 和 retired fence；这是
    queue commit point。
13. 对 migration state revision 做 CAS：清空 active ID、把 last committed ID 设为本 ID，
    并重读确认 selection、queue、retired fence、committed receipt 和 state 一致。
14. 把 matching launcher admission CAS 回 `open/E+1`、清空 migration binding、绑定步骤 13
    的 migration-state generation 并重读，
    再释放 queue lock 和 maintenance lease。若在步骤 12 后收尾失败，按已提交但需恢复处理；
    recovery 只能补 state/admission 收尾，不能恢复 queue1 admission 或 v1 queue。

startup 不扫描到任意旧 `initiated.json`/`prepared.json` 就永久阻塞。managed launcher 先按
startup lease 协议验证 launcher admission，再读取 migration state 和 queue1 writer fence：
v1 正常运行要求 launcher/writer admission 都 open；迁移中的 closing/retired 阻止 queue1
writer。v2 有两个互斥合法分支：

- fresh v2：queue `migration: null`，state 的 active/lastCommitted 均为 null，selected manifest
  为 queue 2，activation/migration-state binding 有效，activation `initialQueue.kind` 为
  `fresh_v2_created` 或经同级 isolation 复核的 `existing_v2_verified`，writer-fence/lease 与
  migration receipt 全部不存在；该分支不伪造 retired/committed chain。
- migrated v2：queue migration binding、state lastCommitted、selection、matching retired
  writer fence 和 committed chain 全部一致。

fresh v2 若发现任何 legacy writer state/lease/receipt，或 migrated v2 缺任一绑定，都
fail-closed。
fresh queue 只可按 §8.3 作为首次 activation 或 isolated repair 的 pre-commit 步骤：queue path
不存在、activation isolation 与 maintenance 同时持有、process scan/legacy writer namespace
都为空时，platform Adapter 用 exclusive-create 写入空 `QueueFileV2 { migration: null }` 并把
generation/hash 固化进 activation receipt；普通 Hub startup 或已 unmask 的 `release use` 不能
补建。发现任何 v1 queue/backup 时必须走显式迁移，不能把它当 fresh 覆盖。
`activeMigrationId` 非 null 时阻止 spawn/writer，并返回
`HUB_QUEUE_MIGRATION_RECOVERY_REQUIRED`。若 active pointer 不存在对应 initiated、initiated
与 fence hash 不一致、指向 terminal generation、或多个 terminal receipt
并存，同样 fail closed。active 为 null 时，旧 aborted generation 不阻塞；但
当前 queue 为 v2 时，其 migration binding 必须与 state 的 last committed receipt、selection
和 target release 一致，否则仍须恢复。这样既不允许无凭据的新写入，也不会被历史 prepared
文件永久锁死。

### 8.5 重试、崩溃恢复和回退边界

恢复命令先按 §8.3/§9 只做 locator discovery，再取得 maintenance lease；随后完整重读并运行
authoritative resolver。需要 durable 转换的结果必须创建/接管并重验唯一 RecoveryLease
snapshot，所有修复按 transition journal 执行；completed terminal replay 和 audit-only orphan
只按 §8.3 的只读/append-only 特例处理，不创建 repair lease。之后按下表处理，不能只根据
某个文件名存在来猜：

原 migrator 在正常 §8.4 happy path 中不持有 RecoveryLease；但只要它决定从任一 partial state
执行 resume/abort/finish cleanup，就必须先进入同一 resolver 并创建 RecoveryLease，不能以
“还是原进程”为由直接运行 journalled cleanup。只有尚未改变任何 authority 的
directory-only/initiated-only audit 特例不需要 lease。

| 崩溃后可观察状态 | 唯一安全动作 |
|---|---|
| 只有空 generation 目录；无 initiated/active pointer；两个 admission open | 验证目录 generation 和空目录内容，追加 directory-only aborted；不得改变 fence、伪造 initiated 或 backup hash |
| initiated 已验证；active 仍为 null；两个 admission open | maintenance 内重跑 resolver、绑定/recheck snapshot，再用 transition journal CAS 采用为 active 后 resume 或 abort；不得使用锁前结论或在没有 lease 时关闭 admission |
| active 指向 initiated；launcher/writer admission 都 open；queue/selection 仍是 source | 从 launcher closing 继续，或追加 initiated-only aborted 后清除 active；source 可在 writer closing 前重新读取，不能沿用 initiated 时的诊断 hash |
| active 指向 initiated；launcher closing；writer open；无 backup/prepared | 等 startup lease 归零并完成 scan 后继续 writer closing；或追加 initiated-only aborted、清除 active、再 reopen launcher 新 epoch |
| active 指向 initiated；两个 admission closing；无 backup/prepared | 验证两个 fence 都绑定 initiated hash、leases 为 0、queue/selection 未越权变化；继续 snapshot，或追加 initiated-only aborted 后依次 reopen writer、清除 active、再 reopen launcher |
| active 指向 initiated；v1 backup 已落盘；无 prepared | 验证 raw-byte backup/source 与 generation；继续 prepared，或追加 backup-written aborted，再按 abort 收尾；不删除证据 |
| active 指向 prepared；queue 为 source v1；selection 仍为 previous；两个 admission closing | 从 target selection 继续，或执行 abort |
| active 指向 prepared；selection 两载体都指向 target；queue 仍为 source v1；两个 admission closing | 从 v2 queue publish 继续，或先恢复 previous selection 再 abort |
| active 指向 prepared；queue 等于 expected target；writer closing 或 matching retired；无 committed | 重跑 decoder/不变量；closing 先 CAS retired，再补 committed；也可在无 application write 时恢复 v1 并执行完整 abort |
| aborted 已存在；active 仍指向它；writer closing/retired、launcher closing | 验证无 commit、queue/selection 已恢复；按 transition journal reopen writer，再清 active；不得重写 aborted |
| aborted 已存在；active null；writer open、launcher closing | 从 launcher binding + aborted chain 派生 `aborted_cleanup` target，建立/接管 mode=abort 的 RecoveryLease；只按 transition journal reopen launcher并绑定清理后的 state generation，此前 closing 持续阻止 startup |
| committed 已存在；active 仍指向它；writer matching retired；launcher closing | 验证 selection/queue/receipt/fence 后完成 migration state CAS，再 reopen launcher；绝不恢复 v1 或 queue1 writer admission |
| active 已清空且 last committed 一致；writer retired；launcher 仍 closing | 从 lastCommitted + launcher binding 派生 committed-cleanup target，建立 finish_commit RecoveryLease；验证完整 chain 后只 reopen launcher 新 epoch，不改 queue/state receipt |
| active 为 null；last committed、queue binding、selection、committed、retired writer fence 和 open launcher admission 全一致 | terminal replay；归档 dead RecoveryLease（若有），从 committed 重建并返回同一结果，不再转换 |
| aborted 已存在；active null；writer/launcher 都 open；当前为合法 v1/open-writer | 用 CLI ID 或 active lease 作 untrusted locator，maintenance 内验证 chain；只归档 dead lease并从 aborted 返回同一结果，不重新取得 queue authority；selection 后续合法变化不回滚 |
| 历史 aborted 已存在；active null；当前为另一个 lastCommitted ID 的完整 migrated-v2 终态 | 验证旧 ID 无 committed sibling、新 committed chain 完整；只重放旧 aborted JSON，不把 successor 状态解释为旧 migration authority |
| RecoveryLease `transition` 非 null | 先验证 immutable next payload；resource 为 expected 时只执行计划 write/CAS，为 next 时只补 ack；其他值停止。ack 前不得运行下一动作 |
| active lease 已归档但上次 JSON 未返回 | 从 immutable committed/aborted/audit receipt 验证终态并重放同一 JSON；不得创建 repair lease |
| symlink 与 `current.json` 只在 prepared 的 previous/target/absent 三者间不一致 | 默认停止；显式 resume 可用 present→present CAS 修复为 target；abort 在 previous 非 null 时修复为 previous，在 previous null 时用 generation-safe present→absent remove；每个 carrier 独立 plan/ack |
| 任一 closing fence 没有 matching active + initiated hash，或出现 directory-only aborted + changed fence | fail closed 并要求平台隔离下人工取证；不得猜 target、创建伪 initiated 或自动 reopen |
| selector 指向第三个 release、queue v2 已有更高 revision/不同 hash、fence/pointer/receipt/hash/release ID 冲突 | 停止并返回 `HUB_QUEUE_MIGRATION_RECOVERY_REQUIRED`；不得自动选一边 |

resume 必须运行 recorded target generation 内的 launcher：

```bash
<targetGenerationPath>/cpb release recover-queue-migration <migration-id> \
  --resume --repair-selection target \
  --expect-link <observed-id-or-none> --expect-record <observed-id-or-none> --json
```

commit-cleanup 不接受 migration ID，避免把用户输入当 authority：

```bash
<targetGenerationPath>/cpb release recover-queue-migration --finish-commit --json
```

launcher closing 时它只允许 §8.3 从 lastCommitted + launcher binding 派生唯一 ID；launcher
已 open 时只从 lastCommitted 派生 committed terminal replay。两种情况都不接受用户 ID，
任一 chain 不一致即失败。

`--repair-selection` 不是普通 selector fallback：target recovery authority 来自 §8.3 resolver
验证的 `initiated.json`，不是操作者参数；active-null initiated orphan 中 CLI ID 也只负责
定位，不能授予权限。只有该 initiated/prepared 的
previous/target/null 组合可使用，并对两个 observed value、state revision、install receipt、
manifest 和 executor hash 做 CAS。
若观察到第三个 release，命令要求维护者先查明外部选择来源；不接受 `--force`。

“无 application write”只有在当前 v2 queue 的完整 hash 和 revision 都与 prepared 中的
expected target 完全相等，且当前 generation 未被 committed/其他观察证明替换时成立；
仅凭 entry 数量或 migration ID 不足以证明。任何更高
revision 都永久越过 v1 rollback floor，即使看起来只改了无关字段。

本规范没有 supersede 或跨 migration authority handoff。prepared 后来源 v1/hash/generation
发生变化时，旧 generation 不能复用：若完整证据仍满足无 application write 的 abort 条件，
先执行下述完整 abort，reopen writer、清 active、再 reopen launcher并归档 RecoveryLease；然后由一个
全新普通 migrate 命令在 §8.4 的 orphan preflight 通过后创建新 ID/initiated。若 source 在
writer closing、lease 为 0、queue lock 持有期间仍变化，视为 operator/filesystem 越权，直接
fail-closed 并人工取证，不能自动从变化后的 source 生成 successor。

在 `committed.json` 写入前，且上述完整 hash/revision 证明没有 application write 时，
进入 abort/restore 的标准命令形状是：

```bash
<targetGenerationPath>/cpb release recover-queue-migration <migration-id> \
  --abort --repair-selection previous \
  --expect-link <observed-id-or-none> --expect-record <observed-id-or-none> --json
```

若 resolver 已证明当前正是 `aborted_cleanup`（aborted 已写、selection/writer 已恢复、active 已清、
launcher 仍 closing），唯一允许的收尾形状不再携带 selection repair：

```bash
<targetGenerationPath>/cpb release recover-queue-migration <migration-id> \
  --abort --json
```

该短形状在其他 active/initiated 状态不获得 authority；反过来，`aborted_cleanup` 收到
`--repair-selection`/`--expect-*` 必须 fail-closed，并把上述短形状作为 remediation，不能重复
触碰已经恢复的 selection。

标准 abort 在写 terminal 前验证 initiated、backup/source hash、queue generation、install
receipt 和 previous release
manifest；必要时先恢复 v1 queue 和 previous selection并重读，然后 durable 追加并重读
`aborted.json`。接着把 matching closing/retired（仅限无 commit）writer fence CAS 为
`open/E+1`，CAS 清除 active pointer，再把 matching launcher admission CAS 为 `open/E+1`、
清空 migration binding并绑定清理后的 migration-state generation。每个 CAS 都先写
RecoveryLease transition 并在之后 acknowledgement。
previous release 为 null 时，对仍 present 的 carrier 必须以对应
`remove_selection_link`/`remove_selection_record` present→absent transition 清除并逐项 ack；
authoritative snapshot 从一开始就为 absent 的 carrier 按 §8.3 重读后直接跳过 mutation。若崩溃发生在 aborted 已写、writer
已 reopen、state 已清、launcher 已 reopen、lease 归档或 JSON 返回前的任一点，pending
transition、active pointer 或尚未 open 的 launcher admission 继续阻止不安全 startup；特别是
clear-active ack 后、reopen-launcher plan 前的 transition-null 窗口必须由 closed resolver 的
`aborted_cleanup` 从 launcher binding 恢复，不能依赖已清除的 active pointer。完成
终态后按 terminal replay 返回同一结果，不得重写 receipt。正常 selector 仍不得支持 v1。

一旦 committed receipt 存在，或 v2 Hub 已接受任何 queue command，恢复 v1 备份会
丢失新任务，因此永久禁止。此后的代码回退只能选择 manifest 同样支持 queue 2 的
release；如果没有这样的 release，保持 Hub 停止并进入人工恢复，不能启动 v1 或恢复旧备份。

## 9. Readiness Module 与根目录

### 9.1 CpbRoots 的唯一构造路径

```ts
export type CpbRoots = Readonly<{
  executorRoot: string;
  runtimeRoot: string;
  hubRoot: string;
  releaseStoreRoot: string;
}>;

export type CpbExecutorMode = "source" | "managed" | "staged_migration";

export type CpbStartupIntent =
  | Readonly<{ kind: "normal" }>
  | Readonly<{
      kind: "queue_migration";
      targetReleaseId: string;
      installReceiptPath: string;
    }>
  | Readonly<{
      kind: "queue_migration_recovery";
      locator:
        | Readonly<{
            kind: "candidate";
            migrationId: string;
            mode: "resume" | "abort";
          }>
        | Readonly<{
            kind: "committed_cleanup";
            mode: "finish_commit";
          }>;
      selectionRepair:
        | Readonly<{
            direction: "target" | "previous";
            expectedLinkReleaseId: string | null;
            expectedRecordReleaseId: string | null;
          }>
        | null;
      installReceiptPath: string;
    }>
  | Readonly<{
      kind: "queue_migration_audit";
      migrationId: string;
      scope:
        | Readonly<{ kind: "orphan_generation" }>
        | Readonly<{
            kind: "unplanned_recovery_payloads";
            attemptId: string;
          }>;
      installReceiptPath: string;
    }>;

export type CpbBootstrap = Readonly<{
  roots: CpbRoots;
  config: CpbConfig;
  executorMode: CpbExecutorMode;
}>;

export function loadCpbBootstrap(input: Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  executorRoot: string;
  startupIntent: CpbStartupIntent;
}>): CpbBootstrap;
```

`loadCpbBootstrap` 位于 `core/policy/config.ts`，是 launcher 到普通生产代码之间
唯一接收原始环境对象的 Interface。它先构造 roots，再解析其余配置，因此不存在
“config 需要 roots、roots 又需要 config”的循环。

根目录规则固定为：

- `executorRoot` 由正在执行的 launcher 传入，必须包含当前 `package.json` 和已编译 CLI。
  如果环境中的 `CPB_EXECUTOR_ROOT` 与 launcher authority 不同，返回 `CPB_ROOTS_INVALID`，
  不能静默覆盖。
- `runtimeRoot` 来自 `CPB_ROOT`，未设置时为 `~/.cpb`。
- `hubRoot` 来自 `CPB_HUB_ROOT`，未设置时等于 `runtimeRoot`。
- `releaseStoreRoot` 来自新的 `CPB_RELEASE_ROOT`，未设置时为
  `<runtimeRoot>/releases`。
- `CPB_HOME` 从正常配置 schema 删除。若它过去与 `CPB_ROOT` 不同，只能运行
  `cpb migrate roots-v1 --from-home <path> --to-runtime <path> --json` 一次性移动
  release selection、provider 配置和项目运行数据；正常启动遇到 `CPB_HOME` 返回
  `CPB_CONFIG_RETIRED_KEY`，不保留 alias。

显式 root 必须为绝对路径，不能是文件系统根目录。`executorRoot` 只有三种合法模式：

1. source mode：源码 checkout 与每个 writable runtime/hub/release root 都不得相同，也不得
   互为 ancestor/descendant；
2. managed mode：必须是 `releaseStoreRoot` 内已经 committed 的不可变 release
   generation，且与 `<runtimeRoot>/current`、选择记录、release manifest、目录 generation
   和 manifest content hash 全部一致。它不能只是 releaseStoreRoot 下的任意目录。
3. staged migration mode：只允许 `startupIntent.kind` 为 `queue_migration`、
   `queue_migration_recovery` 或 `queue_migration_audit`。executor 必须
   是 install receipt 指向的 committed、不可变 generation，release ID、绝对路径、manifest、
   directory generation 和 content hash 全部匹配，但尚可未被 current selector 选中。
   该 mode 的 command registry 只开放 §8 的 use/migrate/recover/audit；doctor、Hub、worker、
   普通 CLI 和正式 readiness 全部返回 `CPB_EXECUTOR_NOT_SELECTED`。

root launcher 在普通 startup-lease/admission 检查前先运行一个最小 closed 顶层 parser；它只
识别 `recover-queue-migration`、`audit-queue-migration` 及其固定 mode/locator/selection/audit-scope
expectation 形状，
不加载 provider、child command 或 queue port。其他命令全部进入普通 launcher 路径并要求
admission open。recovery 在 closing 下只得到读取 fixed roots/state/install receipt 的 bootstrap
能力，audit 在 open 下只得到 maintenance/audit authority；两者都不能复用普通 launcher
authority。

`startupIntent` 由 root launcher 对上述已解析的顶层命令构造，不从环境或下游 JSON 接受；
staged mode 每次操作都重读 install receipt 和 generation。这样 §8 可以运行明确的 target
executor，却不会把 release store 中任意未选择目录当成普通 managed executor。

recovery intent 只携带 untrusted locator。maintenance 前的 discovery 不作授权结论；持锁后
resolver 按 §8.3 优先使用 active pointer。active 为空时，candidate ID 可定位 initiated orphan
或 aborted terminal replay；committed-cleanup/replay 只从 lastCommitted 及当前 launcher
状态派生 ID。任何 CLI ID/path 都不能直接授予 authority。
该 intent 是 launcher admission closing 下唯一允许进入的命令；进入后仍只有只读 bootstrap
能力，必须取得 matching maintenance lease、持锁重跑 resolver、绑定/recheck snapshot，并在
需要修复时 exclusive-create `QueueMigrationRecoveryLease` 后才获得 authority。terminal replay
若无需修复只可归档 dead lease/返回结果。Hub、worker 和普通 queue 命令不能借用该例外。

`selectionRepair` 也只是 parser 固化的 untrusted CAS expectation：resume 只允许 target、abort
只允许 previous、finish-commit 和已经完成 selection restore 的 aborted_cleanup 必须为 null；
两个 expected release ID 都必须与 maintenance
内实际 observed values 相同，repair 的唯一 next values 仍由 verified initiated/prepared
chain 产生。该对象本身不能选择 migration、release 或下一状态。

audit intent 同样只携带 untrusted migration ID 和由 executor 固定派生的 install receipt；它
要求 launcher admission open、state active 为 null，并在 maintenance 内重新验证 §8.3 的
audit-only 前提。`orphan_generation` 只能 append/replay directory-only 或 initiated-only aborted
receipt；`unplanned_recovery_payloads` 只能处理 §8.3 定义的无 plan payload。两者都不能切换为
recovery intent、关闭 admission、采用 active 或修改 queue/selection/fence/state。

`installReceiptPath` 也不来自 CLI 参数：launcher 对自己的 real `executorRoot` 固定追加
`.cpb-release-commit.json`，bounded/no-follow 读取后验证 receipt 的 generationPath、
releaseId、manifest SHA-256 和实际 directory generation。use/resume/abort/audit 都用这同一解析；
若 fixed receipt 缺失，或命令形状含 release ID 且该 ID 不一致，不能搜索其他 generation 猜测。

因此不能使用“executor 一律不得位于 releaseStoreRoot 内”的祖先判断。
`runtimeRoot === hubRoot` 是允许的，`releaseStoreRoot` 位于 `runtimeRoot` 下也是默认
合法关系。managed executor 因这个默认关系也可能位于 runtime/hub root 之下，但只允许
落在上述经过 manifest 绑定的 release generation；queue、selection 和 release generation
使用固定且互不重叠的子路径。各存储 Module 继续使用 no-follow 和目录 generation 校验，不能只信任
字符串规范化；doctor/迁移 JSON 必须明确报告 source/managed/staged mode 和上述绑定验证结果。

### 9.2 Readiness 的公开 Interface

```ts
export type DoctorCheck = Readonly<{
  id: string;
  category: string;
  applicability: "required" | "conditional" | "optional";
  status: "pass" | "warning" | "error" | "skipped";
  message: string;
  evidence: JsonValue;
  remediation: Readonly<{
    message: string;
    command: string | null;
  }> | null;
}>;

export type DoctorReport = Readonly<{
  schemaVersion: 2;
  command: "cpb doctor";
  generatedAt: string;
  executorMode: "source" | "managed";
  roots: CpbRoots & Readonly<{
    projectRuntimeRoots: Readonly<Record<string, string>>;
  }>;
  summary: Readonly<{
    success: boolean;
    passed: number;
    warnings: number;
    errors: number;
    skipped: number;
  }>;
  checks: readonly DoctorCheck[];
}>;

export async function runReadinessChecks(input: Readonly<{
  roots: CpbRoots;
  config: CpbConfig;
  executorMode: "source" | "managed";
}>): Promise<DoctorReport>;
```

公开 Interface 不接收 `env` 或 probe overrides。真实 Implementation 使用 Node
filesystem、process identity 和本机命令；clock、filesystem 和 command runner 是
Module 内部 Seam，不从正常包入口导出。测试使用临时目录并通过
`runReadinessChecks` 观察完整结果，不能把测试 Adapter 暴露给普通调用方。

`cli/commands/doctor.ts` 必须使用 launcher 已产生的同一个 `CpbBootstrap`；不能再次
读取环境或从 `runtimeRoot` 推测 executor。

### 9.3 依赖与 Node 版本检查

- 读取 `<executorRoot>/package.json`，从 `engines.node` 取得最低 Node 版本并验证当前
  runtime；不得保留独立的 `MIN_NODE_MAJOR = 18`。当前唯一要求是 Node `>=20.0.0`。
- 检查根包实际声明的 runtime dependency 是否可以从 executorRoot 解析。
- 不检查不存在的 `server/package.json` 或 `server/node_modules`，不建议
  `cd server && npm install`。
- npm 修复命令必须来自当前 `package.json.scripts`；CPB 命令必须来自当前 CLI
  command registry。不能输出 registry 中不可达的 `cpb release ...` 命令。

### 9.4 结果分级

`cpb doctor` 用于本地运行健康；release gate 使用 §13 的独立证据。判定规则：

- Hub 已停止：warning，不冒充正在运行。
- Hub 在非 loopback 地址运行但无认证：error。
- Hub 在 loopback 且显式启用匿名开发模式：warning。
- Hub 已停止且尚未配置认证：warning；release check 仍把它列为发布失败。
- 未启用备份时缺少签名密钥：warning；执行备份或 release check 时为 error。
- GitHub App 缺失但 `gh` transport 可用：warning，并明确 effective transport 为 `gh`。
- 已绑定 GitHub 项目但没有任何可用 transport：error。
- 可选 agent 缺失：warning，不把基础 CLI 判为不可用。

`summary.success` 只由当前适用的 error 决定。每个 remediation command 都必须通过
command registry 或 package scripts 校验；没有真实命令时只给文字说明，command 为 null。

### 9.5 删除旧产品面

doctor 和 readiness 中必须直接删除 Web tests、Web build、
`npm --workspace codepatchbay-web ...`、`npm run build:web` 和
`server/node_modules` 检查；不得改成 deprecated warning。

## 10. CpbConfig Module

### 10.1 深 Module Interface

`core/policy/config.ts` 实现 §9 的 `loadCpbBootstrap`。所有支持的 key 在
`core/policy/config-schema.ts` 注册；schema 对每个 key 记录值类型、默认值、敏感级别、
校验器、允许的子进程 intent 和是否属于可重复的 provider family。

```ts
export type ConfigPrimitive = string | number | boolean | readonly string[];

export type PlatformEnvName =
  | "PATH" | "HOME" | "SHELL" | "TERM" | "COLORTERM"
  | "TMPDIR" | "TEMP" | "TMP" | "USER" | "LOGNAME"
  | "LANG" | "LC_ALL" | "LC_CTYPE" | "LC_MESSAGES" | "LC_COLLATE"
  | "LC_MONETARY" | "LC_NUMERIC" | "LC_TIME" | "LC_ADDRESS"
  | "LC_IDENTIFICATION" | "LC_MEASUREMENT" | "LC_NAME" | "LC_PAPER"
  | "LC_TELEPHONE" | "TZ"
  | "HTTP_PROXY" | "HTTPS_PROXY" | "ALL_PROXY" | "NO_PROXY"
  | "http_proxy" | "https_proxy" | "all_proxy" | "no_proxy"
  | "SSL_CERT_FILE" | "SSL_CERT_DIR" | "NODE_EXTRA_CA_CERTS"
  | "NPM_CONFIG_CACHE" | "npm_config_cache" | "CI" | "NODE_ENV"
  | "CODEX_HOME" | "PYTHONDONTWRITEBYTECODE" | "SSH_AUTH_SOCK"
  | "XDG_CONFIG_HOME" | "XDG_CACHE_HOME" | "XDG_DATA_HOME"
  | "XDG_STATE_HOME" | "XDG_RUNTIME_DIR"
  | "USERPROFILE" | "APPDATA" | "LOCALAPPDATA" | "SystemRoot"
  | "COMSPEC" | "PATHEXT";

declare const platformEnvSnapshotBrand: unique symbol;

export type PlatformEnvSnapshot = Readonly<{
  names: readonly PlatformEnvName[];
  [platformEnvSnapshotBrand]: true;
}>;

export type PublicConfigKey<T extends ConfigPrimitive> = Readonly<{
  envName: string;
  sensitivity: "public" | "sensitive";
  valueType: "string" | "number" | "boolean" | "string-list";
  readonly __valueType?: T;
}>;

export interface CpbConfig {
  readonly schemaVersion: 1;
  readonly roots: CpbRoots;
  readonly platformEnv: PlatformEnvSnapshot;
  get<T extends ConfigPrimitive>(key: PublicConfigKey<T>): T;
  has(key: PublicConfigKey<ConfigPrimitive>): boolean;
}

export type AgentRole =
  | "plan"
  | "execute"
  | "verify"
  | "adversarial_verify"
  | "review";

export type ChildProcessIntent =
  | Readonly<{ kind: "orchestrator" }>
  | Readonly<{
      kind: "worker";
      workerId: string;
      projectId: string;
      projectRuntimeRoot: string;
    }>
  | Readonly<{
      kind: "agent";
      agent: string;
      provider: string;
      model: string;
      role: AgentRole;
      workerId: string;
      projectId: string;
    }>
  | Readonly<{
      kind: "stream";
      host: string;
      port: number;
    }>
  | Readonly<{
      kind: "release_gate";
      sessionId: string;
      gateId: string;
    }>;

export async function buildChildConfigEnv(input: Readonly<{
  config: CpbConfig;
  intent: ChildProcessIntent;
}>): Promise<Readonly<Record<string, string>>>;
```

`CpbConfig` 不公开原始 map，也不提供按任意字符串读取。schema 导出的
`PublicConfigKey<T>` 常量决定静态返回类型。secret key 不生成 `PublicConfigKey`，
普通调用方不能通过 `config.get` 取得；只有平台/凭据 Adapter 可按完整 agent intent
解析 secret，并且只在 `buildChildConfigEnv` 的最终结果中短暂出现。

`PlatformEnvSnapshot` 是同一次 `loadCpbBootstrap` 从传入 `env` 捕获的不可变、无 getter
快照；公开的 `names` 只说明哪些已登记名称存在，不公开值，brand 构造器也不导出。
值由 config Module 的 private closure/WeakMap 保存，只有 `buildChildConfigEnv` 和登记过的
credential adapter 能读取；测试也必须通过 `loadCpbBootstrap(testEnv)` 建立快照，不能
导出绕过 constructor 的 fake map。
内部 schema 为上面每个名称记录 POSIX/Windows 适用性、敏感级别和允许的 child intent。
PATH、home、shell/terminal、temp、user、locale、proxy、certificate、npm cache、CI/Node
mode 都只能从这份快照选择；Windows 名称只在 Windows target 传递。proxy value 若含
userinfo 按 sensitive 处理，日志与错误只显示名称。

`buildChildConfigEnv` 不接收 parent env 或自由 allowlist。agent intent 的
agent/provider/model/role 全部必填，凭据选择必须同时使用这些字段；删除当前依赖
动态 key 正则和 `process.env` 合并的隐式行为。不同 provider/平台实现是允许的 Adapter，
但它们都必须满足同一个 secret 传递测试。builder 从 immutable platform snapshot、
typed CPB config 和 credential adapter 三者构造全新的 env object；bootstrap 之后的代码
不得再次读取 parent `process.env` 来“补回”PATH、HOME、TMP、locale 或 proxy。

release gate 的 child intent 只把该 gate 需要的普通配置传给子命令；绝不传 signing
private key 或 trusted-key override。`CPB_RELEASE_GATE_SIGNING_KEY`、
`CPB_RELEASE_GATE_SIGNING_KEY_ID`、`CPB_RELEASE_GATE_TRUSTED_PUBLIC_KEY` 和
`CPB_RELEASE_GATE_TRUSTED_KEY_ID` 必须作为精确 schema keys 注册，其中 private key 只可由
runner 内的 `ReleaseSigningAdapter` 读取，trusted key 只可由 report verifier 读取。

### 10.2 schema 完整性规则

- Phase 2 开始时先生成 `config-env-inventory.json`，列出生产目录中每个静态 env 名称和
  受约束 dynamic family（不只 `CPB_*`）的直接读取位置、写入位置、值类型和子进程目标。
  它必须显式覆盖当前 child-env 使用的 `CODEX_HOME`、`PYTHONDONTWRITEBYTECODE`、
  `NPM_CONFIG_CACHE` 与 `npm_config_cache`。该文件由
  `scripts/config-env-inventory.ts` 从源码生成，不能手写删项。
- inventory 中的 `CPB_*` 由 `core/policy/config-schema.ts` 覆盖，平台名称由
  `platform-env-schema.ts` 覆盖，credential family 由精确 Adapter schema 覆盖。guard 比较
  三者；未分类的源码读取返回 `ENV_INVENTORY_UNCLASSIFIED` 并使 CI 失败，用户输入的未知
  `CPB_*` 仍返回 `CPB_CONFIG_UNKNOWN_KEY`。
- schema family 只能表示真实的 provider/agent 平台差异，并必须给出 name pattern、
  value decoder 和传递目标；不能用宽泛正则把未知 key 自动放行。
- 同一含义只保留一个名称。旧名称通过显式配置迁移改写后，从 schema 和调用点删除；
  正常运行返回 `CPB_CONFIG_RETIRED_KEY`，不保留 alias。
- doctor、日志、receipt 和错误只显示配置名与失败原因，不显示 secret 值。
- 下游只接收完整 `CpbConfig`、明确 typed slice 或 `ChildProcessIntent` 生成的环境；
  不接收原始 `process.env`。

### 10.3 分区收敛与验收

2026-08-03 的生产 TypeScript 基线共有 422 行直接 `process.env` 读取：

| 分区 | 当前行数 | 迁移批次 |
|---|---:|---|
| `server` | 221 | readiness/root 后按 hub、orchestrator、其余 services 分批 |
| `core` | 88 | engine 优先，再迁 agent/provider 与其他 core |
| `cli` | 52 | 先 launcher/context，再迁各 command |
| `bridges` | 32 | 使用 bootstrap/config slice |
| `runtime` | 25 | worker 优先，再迁 evolve |
| `shared` | 4 | 删除隐式读取，改显式参数 |

第一门槛把 `server/orchestrator`、`runtime/worker`、`core/engine` 的 48 行降为 0，
同时迁移 readiness、roots 和 `core/policy/child-env.ts`。第二门槛迁移表中其余调用点。

最终守卫以“精确函数”而不是整个目录作为 allowlist：只有 launcher 调用
`loadCpbBootstrap` 的位置、`core/policy/config.ts` 的解析函数和登记过的平台/凭据
Adapter 可以读取原始环境。其他生产代码直接读取 `process.env` 的数量必须为 0；
inventory 总数、schema 覆盖数、已迁移数和允许数必须满足
`total = migrated + allowed`。新增未授权读取或 inventory 未归类项都使 CI 失败。

## 11. 类型收敛

本规范不要求一次开启全仓 `strict`，但以下发布关键 Module 必须严格类型检查：

- queue v2 contract、`HubQueue` Interface 和 queue persistence Implementation
- `CpbRoots`、Readiness Module 和 doctor formatter
- `CpbConfig`、child environment builder
- mutation progress classification 和 completion decision 输入
- launcher activation/admission/startup lease、queue writer fence/lease、maintenance v2
  capability、全部 migration state/receipt、resolver snapshot/transition/RecoveryLease decoder

具体门槛：

- `hub-queue.ts` 当前约 40 行 `LooseRecord` 使用，在新 queue Interface 中降为 0。
- readiness/doctor 当前约 15 行 `LooseRecord` 使用，在新公开 Interface 和 formatter 输入中降为 0。
- 新增 `tsconfig.strict-runtime-contracts.json` 覆盖这些文件，并新增唯一命令
  `npm run typecheck:strict:runtime-contracts`；§13 的 release gate 必须执行它。
  现有 `typecheck:strict:engine` 继续检查 engine，但不能代替这个新门禁。
- 需要扩展字段时使用已校验的 `JsonValue`/typed metadata，不允许把整个 queue entry、doctor result 或 config 退回 `LooseRecord`。
- 全仓 `LooseRecord` 总数不得增加；每个后续阶段只能持平或下降。

## 12. 正确补丁判定与真实样本复测

### 12.1 mutation progress

agent tool update 必须先标准化再进入 no-edit guard。标准化输入至少记录：

- provider/transport
- raw `kind`
- raw `title`
- raw `toolName`
- raw `serverName`
- normalized operation
- observed paths（如 transport 提供）
- classification reason

标准化结果只有 `read`, `mutation`, `other` 三类。`apply_patch`、`Apply Patch`、`write_file`、`write_text_file`、`create_file` 和实际 Codex audit 中出现的写操作都必须归为 `mutation`。

不能只靠推测扩展正则。每个新签名必须附真实或最小脱敏 audit fixture。

### 12.2 verifier 基础设施失败

- provider/adapter 退出不能自动变成 PASS。
- 只有冻结候选、确定性 evidence ledger 和全部必需 checklist item 都证明通过时，才能从 verifier 基础设施失败恢复成功。
- 证据缺失、冲突或不完整时保持失败，并给出基础设施错误，不得伪造 verifier verdict。

### 12.3 verified-5 复测

使用现有官方评分包中相同的 base commit 和问题：

- `django__django-13343`
- `django__django-13346`
- `django__django-13363`
- `django__django-13401`
- `django__django-13344`（历史上没有源码补丁）

验收要求：

- 前四个样本的 CPB terminal status 为成功，completion gate 为 PASS，且官方 harness 仍为 4/4 resolved。
- `django__django-13344` 不得仅凭测试 diff 或空交付变成成功。
- 每个样本保留 plan、execute、verify、completion gate、audit JSONL、源码 patch 和官方报告引用。
- 结果报告同时列出 `officialResolved` 和 `cpbPassed`，不允许用其中一个覆盖另一个。
- 若任一官方 resolved 样本仍被 CPB 判失败，`flow-4pt` 保持打开，release gate 失败。

## 13. Live release 证据

### 13.1 原始成功不等于发布证据

`tests/evidence/live-e2e/*.json` 是诊断输入。单条 `ok: true` 不能直接复制为正式
live manifest。正式 manifest 固定写到
`<runtimeRoot>/release-evidence/<releaseSourceFingerprint>/external/live-release.json`；
旧的 source-tree 路径 `docs/product/cpb-live-release-validation.json` 在迁移时删除，
verifier 必须拒绝把它当作正式证据，不能保留两个 canonical path。

同一 external 目录中的其他 canonical 文件固定为 `verified-5.json`、
`draft-pr.json` 和 `product.json`。源码树中的历史 JSON 只可作为 fingerprint 覆盖的
diagnostic input；promotion 不得原地改写它们，正式 verifier 也不得把它们直接当成功
manifest。这样生成证据不会反过来改变它所声明的 release source fingerprint。

正式证据必须通过现有 promotion Interface 生成，并包含：

1. 真实 provider 在 plan、execute、verify、adversarial verify 的连通和策略证据。
2. 一个可丢弃仓库中的完整 queue-to-finalizer 成功运行。
3. 一个未合并的 disposable draft PR，包含实际 patch、检查结果和清理记录。
4. 有效产品证据引用及其 SHA-256。
5. 30 天内的时间戳、审计引用和 fail-closed 校验结果。

### 13.2 安全要求

- 凭据只来自本地环境或受控 secret store，不进入仓库和 evidence bundle。
- 临时 PR 不得指向生产仓库或自动合并。
- 运行失败时保存失败证据，但不得 promotion 成正式成功 manifest。
- promotion 必须通过锁、原子发布、签名和重新校验。没有 release signing authority 的
  本地运行只能生成 diagnostic bundle，不能生成正式 manifest 或 `ready: true`。

四个 canonical external 文件共用以下 envelope；签名规则和 pinned trust anchor 与 §13.3
相同，payload 中的路径必须是脱敏相对引用或受控外部 URL，不能嵌入 secret：

```ts
export type SignedExternalEvidence = Readonly<{
  schemaVersion: 1;
  kind: "live_release" | "verified_5" | "draft_pr" | "product";
  releaseSourceFingerprint: string;
  generatedAt: string;
  expiresAt: string;
  payload: JsonValue;
  payloadSha256: string;
  signerKeyId: string;
  signatureAlgorithm: "Ed25519";
  signature: string;
}>;
```

promotion 对去掉 `signature` 的 RFC 8785 canonical JSON 签名，verifier 同时复算 payload
hash、检查 kind/path 对应关系和有效期。仅把 unsigned JSON 放到 external 目录不能升级为
正式证据。

字节合同固定如下，不允许 Adapter 自选编码：

- `CPB_RELEASE_GATE_SIGNING_KEY` 是无 padding base64url 编码的 Ed25519 PKCS#8 DER；
  trusted public key 是无 padding base64url 编码的 Ed25519 SPKI DER。decoder 必须验证
  algorithm OID、DER 全量消费和 key 长度，拒绝 PEM、其他曲线和尾随 bytes。
- `signature` 是无 padding base64url，解码后恰好 64 bytes；`signerKeyId` 匹配
  `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`。
- 本 §13 release evidence、gate receipt、completion 和 source fingerprint 中的所有
  hash/fingerprint 字符串统一为 `sha256:<64 lowercase hex>`。该格式不追溯改变 §7–§8
  queue/runtime 内部使用的裸 64 位十六进制合同。所有时间是带三位毫秒的 UTC ISO-8601，
  且 `generatedAt < expiresAt`。

每个 release hash 的输入字节域固定如下；decoder 必须按字段选择这一行，不能 hash
pretty-printed JSON 或实现自己的 normalization：

| 字段/引用 | 唯一 SHA-256 输入 |
|---|---|
| `SignedExternalEvidence.payloadSha256` | 已由 kind decoder 验证的 `payload` 的 RFC 8785 bytes |
| kind payload 内 audit、artifact、patch、check、cleanup、product record、scoring bundle hash | 从 allowlisted reference 以 bounded/no-follow handle 或受控下载取得的完整 raw bytes；URL 下载结果也必须先固化成不可变 artifact |
| `ReleaseSourceManifest.items[].contentSha256` | 对应 source regular file 的完整 raw bytes |
| `releaseSourceFingerprint` | 不含 fingerprint 字段的完整 `ReleaseSourceManifest` 的 RFC 8785 bytes |
| `stdoutSha256` / `stderrSha256` | child pipe 收到的未解码、未截断、按到达顺序拼接的完整 raw bytes；展示截断不改变 hash |
| `previousReceiptSha256` / `orderedReceiptSha256[]` | 对应完整、已签名 `ReleaseGateReceipt`（包含 `signature`）的 RFC 8785 bytes |
| `externalEvidenceSha256[kind]` | 对应完整、已签名 `SignedExternalEvidence` envelope（包含 `signature`）的 RFC 8785 bytes |
| 任何引用 `ReleaseGateCompletion` 的 completion hash | 完整、已签名 completion（包含 `signature`）的 RFC 8785 bytes |
| deterministic npm package/tarball hash | 实际将安装的 `.tgz` 完整 raw bytes |
| installed executor content hash | deterministic installed-tree manifest 的 RFC 8785 bytes；每个 manifest item 的 content hash 仍取 raw file bytes |

签名输入仍是去掉 `signature` 后的完整对象 RFC 8785 bytes；签名输入与上表“包含 signature
的对象 hash”是两个不同域。verifier 必须保存或重新取得被 hash 的完整 bytes，并先检查 byte
length；只有摘要而没有原 bytes/typed object 的引用不能作为可复核 evidence。

envelope decoder 先拒绝未知/缺失字段，再按 kind 调用唯一 payload decoder：

| kind / canonical path | 唯一 fail-closed decoder | 最低语义检查 |
|---|---|---|
| `live_release` / `live-release.json` | `decodeLiveReleaseEvidenceV1` | 四个 provider role、完整 queue-to-finalizer run、audit/artifact hash、30 天窗口 |
| `verified_5` / `verified-5.json` | `decodeVerified5EvidenceV1` | §12.3 五个固定 sample/base commit、官方 scorer 与 CPB verdict 分列 |
| `draft_pr` / `draft-pr.json` | `decodeDraftPrEvidenceV1` | allowlisted disposable repo、draft 且未合并、patch/check/cleanup evidence |
| `product` / `product.json` | `decodeProductEvidenceV1` | product record/scoring bundle 引用、各自 SHA-256 和 freshness |

四个 decoder 位于 `core/contracts/release-evidence.ts`，返回不同的 typed payload；不能先解成
`JsonValue` 后只检查几个公共字段。promotion 和 report 必须复用同一组 decoder。

### 13.3 同一源码指纹与 gate receipt

发布验证的唯一完整入口是：

```bash
npm run verify:release-gate
```

现有 `verify:stabilization` 的检查迁入该入口并删除旧 script，不保留两个“完整发布
门禁”。各单项命令仍可用于诊断，但单独成功不能生成 `ready: true`。

Local Code Index 的 `snapshotId` 不是发布指纹：build output、外部 evidence 或索引重建
会改变它，用它命名 evidence 会形成自引用。新脚本
`scripts/release-source-fingerprint.ts` 必须生成 `ReleaseSourceManifest`：

- 根文件固定包含 `package*.json`、`tsconfig*.json`、`cpb`、
  `.editorconfig`、`.gitattributes`、`.gitignore`、`.npmignore`、所有 root `*.md`、
  `LICENSE*`、`NOTICE` 和 `codepatchbay-*.json`（存在时）；`.DS_Store` 明确拒绝。
- 递归包含 `cli/`、`core/`、`server/`、`runtime/`、`bridges/`、`shared/`、`scripts/`、
  `tests/`、`cpb-test/`、`profiles/`、`providers/`、`schemas/`、`skills/`、
  `templates/`、`assets/`、`docs/`、`wiki/` 和 `.github/` 中的 regular file；拒绝
  symlink 和越界路径。
- denylist 固定为 `.agents/`、`.antigravitycli/`、`.beads/`、`.claude/`、`.codegraph/`、
  `.codex/`、`.git/`、`.omc/`、`.omx/`、`.test-tmp/`、`.tmp-*/`、`artifacts/`、
  `coverage/`、`dist/`、`dist-tests/`、`hyperframes-video/`、`logs/`、`marketing/`、
  `node_modules/`、`cpb-task/`、`flow-task/`、`undefined/` 和 runtime evidence directory。
  正式 gate/promotion 输出只能写 runtime evidence；若任何 gate 尝试在 source inputs
  内生成 evidence，立即失败。denylist 不得匹配上述 include schema；任何两边都没登记的
  root file/directory 也使 fingerprint 命令失败，不能被静默忽略。
- 每项记录 normalized relative path、executable mode、byte size 和 content SHA-256；按
  UTF-8 bytewise path 排序后，对 canonical JSON 再做 SHA-256，得到
  `releaseSourceFingerprint = sha256:<64 lowercase hex>`。空目录、mtime、inode 和绝对路径不参与。

runner 开始时构建 manifest，并刷新 Local Code Index，要求
available/fresh/exact；index snapshot ID 只作为独立审计字段记录。每个 gate 开始前和
结束后重新计算 source manifest，任何输入变化都使 session 失败。最终 report 前再次
构建索引并验证 fresh/exact，但允许 snapshot ID 因已排除的 build output 改变；最终的
source manifest hash 必须与 session 开始时完全相同。

正式 runner 还必须从 CpbConfig 的 release-gate credential adapter 取得 Ed25519 private
signing key；report 从候选源码之外的 CI/operator trust store 取得 pinned public key 和
key ID，不能信任候选仓库自己提供的新公钥。每个必跑 gate 写一个签名 receipt：

```ts
export type ReleaseGateReceipt = Readonly<{
  schemaVersion: 2;
  sessionId: string;
  sequence: number;
  previousReceiptSha256: string | null;
  gateId: string;
  releaseSourceFingerprint: string;
  indexSnapshotIdAtSessionStart: string;
  command: readonly string[];
  cwd: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  ok: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutArtifactPath: string;
  stderrArtifactPath: string;
  stdoutSha256: string;
  stderrSha256: string;
  evidence: JsonValue;
  signerKeyId: string;
  signatureAlgorithm: "Ed25519";
  signature: string;
}>;

export type ReleaseGateCompletion = Readonly<{
  schemaVersion: 1;
  sessionId: string;
  releaseSourceFingerprint: string;
  indexSnapshotIdAtFinalCheck: string;
  requiredGateIds: readonly string[];
  orderedReceiptSha256: readonly string[];
  externalEvidenceSha256: Readonly<Record<string, string>>;
  completedAt: string;
  signerKeyId: string;
  signatureAlgorithm: "Ed25519";
  signature: string;
}>;
```

receipt/completion 的 key、signature、hash 和 timestamp 编码全部使用 §13.2 的同一字节
合同。签名输入是去掉 `signature` 后的 RFC 8785 canonical JSON。receipt 位于
`<runtimeRoot>/release-evidence/<releaseSourceFingerprint>/<sessionId>/gates/`，sequence
从 1 连续递增，`previousReceiptSha256` 形成 hash chain。runner 使用 exclusive create、
原子 rename 和 fsync 写入；两个 artifact path 必须是 session 内不可越界的相对路径，指向
按 child pipe 原样保存的完整 raw stream，verifier 核对 byte count 与 hash。最后签名
`completion.json`，其中列出固定 gate 顺序、每个
receipt hash 及 live promotion、verified-5、draft-PR、product bundle 的 hash。completion
只能在最终 source manifest 复算和 Local Code Index 重建为 fresh/exact 后生成，并记录
该最终 index snapshot ID。

report verifier 是 runner 进程内的深 Module。bootstrap 的 trust Adapter 解析 pinned public
key 后只构造一个不可序列化、只含 verify 能力的 `ReleaseVerificationTrust`；它没有 sign
能力，也不暴露 key bytes：

```ts
declare const releaseVerificationTrustBrand: unique symbol;

export type ReleaseVerificationTrust = Readonly<{
  keyId: string;
  [releaseVerificationTrustBrand]: true;
}>;

export async function verifyReleaseReadiness(input: Readonly<{
  roots: CpbRoots;
  trust: ReleaseVerificationTrust;
  releaseSourceFingerprint: string;
  sessionId: string;
}>): Promise<JsonValue>;
```

`verifyReleaseReadiness` 必须验证 pinned key、每个签名、连续 sequence/hash chain、
completion manifest、命令、退出码、source manifest 和外部 evidence hash。没有 trusted
key、签名不对、receipt 被删改/重排、source 指纹不同或 evidence 不完整都返回
`RELEASE_GATE_RECEIPT_INVALID`。这里的保证边界是检测没有 signing key 的事后手改和伪造；
它不声称能防住控制 runner 及 private key 的恶意 release maintainer。此信任边界必须写入
operator 文档，不能再用“JSON 文件本身证明不是手写”的绝对表述。

### 13.4 唯一必跑集合与 readiness

`verify:release-gate` 按以下固定 ID 执行，任一失败立即令候选失败，但仍保留已经产生的
失败 receipt：

| gate ID | 唯一命令或内容 |
|---|---|
| `build-node-tests` | `npm run build:node`，随后 `npm run build:tests` |
| `typecheck` | `npm run typecheck` |
| `strict-engine` | `npm run typecheck:strict:engine` |
| `strict-runtime-contracts` | `npm run typecheck:strict:runtime-contracts` |
| `type-debt-engine` | `npm run typecheck:type-debt:engine` |
| `test-main` | `npm run test:main`，其中已包含 shell tests |
| `test-integration` | `npm run test:integration` |
| `test-specialized` | `npm run test:specialized` |
| `dependency-audit` | `npm run verify:dependency-audit` |
| `patch-integrity` | `npm run verify:patch-integrity` |
| `commit-size` | `npm run verify:commit-size` |
| `v2-release-scan` | `npm run verify:v2-release-scan` |
| `enterprise-gate` | `npm run verify:enterprise-gate` |
| `docs-contract` | 新命令 `npm run verify:docs-contract` |
| `product-gate` | `npm run verify:product-gate`，包含 verified-5 新报告 |
| `live-release-evidence` | `npm run verify:live-release-evidence` |
| `release-contracts` | 新命令 `npm run verify:release-contracts`，承接当前精选 contract tests、managed-worker E2E，并生成 deterministic npm-pack file manifest、package SHA-256 与 managed release manifest/content hash 绑定证据 |

当前 `verify-release-gate.ts` 中“先调用 readiness report、再跑精选测试”的顺序必须
拆开：精选测试移到 `verify:release-contracts`。总 runner 最后在同一进程直接调用
`verifyReleaseReadiness`，不得通过 child process 执行 npm report script。这样 trusted
public key 不需要穿过 `ChildProcessIntent`，report 也不会反过来调用尚未完成的 gate。

`npm run report:release-readiness` 只是独立的顶层 CLI wrapper：它自己调用
`loadCpbBootstrap`，由 trust Adapter 构造 verifier 后调用同一 Interface。总 runner 不调用
这个 wrapper。`release_gate` child intent 继续禁止 private key 和 trusted public key，
因此没有 parent-env fallback。

`report:release-readiness` 只读取同一 release source fingerprint、同一 signed session 的
完整 receipt 集合和外部 evidence，
不替代执行。最终输出至少为：

```json
{
  "schemaVersion": 2,
  "sessionId": "gate-...",
  "releaseSourceFingerprint": "sha256:...",
  "signerKeyId": "release-authority-2026",
  "requiredGateIds": ["build-node-tests", "typecheck", "..."],
  "gates": {
    "build-node-tests": { "ok": true },
    "test-main": { "ok": true },
    "test-integration": { "ok": true },
    "test-specialized": { "ok": true },
    "product-gate": { "ok": true },
    "live-release-evidence": { "ok": true }
  },
  "ready": true
}
```

`ready` 只有在全部 17 个 gate ID 存在、`ok: true`、source manifest 一致、签名/hash
chain/completion manifest 有效、全部 external evidence hash 匹配，且 report 运行前后
索引都 fresh/exact 时才为 true。不得因为 patch integrity、产品证据和 live evidence
三项通过就忽略主测试、集成测试或 signing authority 失败。

## 14. 文档与命令一致性

### 14.1 必须修改的文档

- `CONTRIBUTING.md`：删除 Web UI 和 `build:web`，只保留真实 scripts。
- `SECURITY.md`：删除 Web UI、飞书和钉钉入口，描述当前 Hub、stream、agent 执行和凭据风险。
- `README.en.md`：展开 code-index 的实际 positional kind 示例，与中文 README 对齐。
- `AGENTS.md` 与 `CLAUDE.md`：删除固定的“222 文件”数字，改为用 `--list` 获取当前集合；同步代码索引语法和测试分层。
- doctor help/readiness 输出：删除已移除产品面和命令。
- 删除没有调用方的 root `cpb-compat` 转发 launcher；唯一 launcher 名称为 `cpb`。

### 14.2 唯一命令来源

- npm 命令来自 `package.json.scripts`。
- CPB 命令来自 CLI command registry 和各命令 parser。
- 文档不复制固定测试文件数量；需要数量时提供查询命令。
- AGENTS/CLAUDE 中共享的命令块以
  `docs/fragments/repository-command-contract.md` 为唯一文本来源，由
  `scripts/sync-repository-command-docs.ts` 写入两份文件的标记区块。
  `npm run verify:docs-contract` 使用该脚本的 `--check` 模式验证生成结果；
  AGENTS.md 与 CLAUDE.md 仍是独立文件，但共享区块不得手工编辑。

### 14.3 文档测试

新增文档契合测试，至少验证：

- `CONTRIBUTING.md`、`AGENTS.md`、`CLAUDE.md` 中出现的 `npm run <name>` 全部存在。
- README 中列出的 code-index 示例能通过 parser 的 syntax-only 路径。
- 主文档不再出现 `build:web`、`codepatchbay-web`、Feishu、DingTalk 或 Web UI 产品承诺。
- AGENTS/CLAUDE 的共享命令块一致。

测试不得真的启动 Hub、写项目、访问 provider 或创建 PR。

## 15. 测试矩阵

| 层级 | 必须覆盖 |
|---|---|
| Queue contract | v2 decoder 的每个必填字段、未知字段/状态、非有限 JSON、重复 ID、revision、时间、lineage、文件大小和 no-follow 失败 |
| Queue commands | 每个 role port 的合法/越权命令、port acquisition、CAS conflict、enqueue/retry idempotency duplicate 与 payload conflict、evidence field 权限、reserve→handoff→accept、复制 snapshot 不能冒充 worker、raw capability 不落盘/日志、assignment 身份不匹配、终态不可变、原子 fail-and-retry、revision 和 lineage 汇总恒等 |
| Queue migration | 每个必填字段的确定性 v1 映射、legacy key collision；activation state/queue→receipt→open、open→unmask、unmask→success JSON 各崩溃窗口及幂等重放；fresh-v2 receipt binding、missing-state/isolated repair；最小 recovery/audit parser 在普通 admission 前分流且只读；launcher 在 state-read/lease-create/recheck/spawn/registry-handoff 各点暂停，active CAS 发生在 handoff 前时 child 不得获权，spawn 后 launcher 死亡的 child 无 authority，closing 等 startup lease、旧 launcher 无 registration protocol 拒绝；writer 在 state-read/lease-create/recheck/lock/publish 各点暂停，closing 后注册拒绝、非 exact birth identity 不得 quarantine、retired 永久拒绝 v1；directory-only、initiated-only、backup-only orphan，连续 directory/initiated→active 前崩溃、非本 ID 的正常外部变化后 audit-only 清理、多 orphan 逐个清理、directory-only aborted→JSON replay；两个 resolver 锁前并发后串行持锁重验及 snapshot 绑定，lastCommitted commit-cleanup 派生；RecoveryLease acquired→authority_bound、immutable payload→plan→backup/receipt write 或资源 CAS→ack、takeover archive-copy→active CAS、terminal cleanup→terminal_replay→archive→JSON 各点崩溃，recovery process exact scan 豁免、live owner 即使 maintenance 失效仍拒绝抢占、dead owner 继承 locator/mode/phase/pending plan 后 generation-safe 接管；未证明状态/活动任务中止、selector 两载体分裂、queue publish、retire-before-commit、completed aborted/committed replay 不创建 repair lease、历史 aborted 在合法 later v2 终态重放、resume、abort、finish_commit、完整 abort 后新 migration，以及 committed/v2 write 后拒绝 v1 回退 |
| Queue integration | orchestrator reservation、worker handoff/accept、reconciler recovery、cancel、retry 新 entry、Hub/doctor/jobs/task view/observability 同一分析结果 |
| Doctor unit | 四种 root 组合、source/managed/staged mode、非法嵌套、未选择 generation 的命令 allowlist、依赖位于 executorRoot、从 `engines.node` 读取 Node 要求、Hub 停止、认证、GitHub fallback、可选 agent |
| Doctor integration | 源码启动器、selected global symlink、staged target migration launcher、临时 npm 安装、独立 runtime/hub/release roots、`CPB_HOME` 拒绝与一次性 root migration |
| Config unit | 全 env inventory 的 config/platform/credential 分区、类型解析、默认值、未知/退役 key、secret redaction、完整 agent intent、非法根目录、POSIX/Windows snapshot、PATH/HOME/TMP/locale/proxy/cert/CODEX_HOME/PYTHONDONTWRITEBYTECODE/两种 npm cache spelling 的目标 allowlist、bootstrap 后修改 parent env 不影响 child env |
| Type gate | queue/migration/launcher/maintenance/readiness/config strict 通过；未授权 `process.env` 与新增 `LooseRecord` 被拒绝 |
| Verdict unit | 真实 mutation audit fixtures、只读事件、缺字段、provider 基础设施失败、确定性证据恢复 |
| Product replay | verified-5 同批复测与官方 scorer |
| Live | 真实 provider、完整 queue-to-finalizer、disposable draft PR、promotion 与 verification |
| Release receipt | 17 个 gate 齐全、同一 release source fingerprint、source-tree evidence 写入拒绝、build/index snapshot 改变不造成自引用、输入文件中途变化失败、无 signing key 只能 diagnostic、错误 pinned key、签名/hash-chain/completion 缺失/删改/重排/旧 session 拒绝、report 无循环调用 |
| Docs | scripts 存在、CLI syntax、旧产品词删除、canonical fragment 生成、AGENTS/CLAUDE 共享块一致 |

Queue migration 的 fault-injection case 还必须逐项命名覆盖：isolation/maintenance 均在首次
state create 前取得并持续到 open commit；launcher snapshot 内嵌 migration-state binding 陈旧；
maintenance v2 assert/renew generation 变化；clear-active ack 后、reopen-launcher plan 前由
aborted_cleanup 接续；selection link/record 的 present→absent remove 在 plan/remove/ack 三个
窗口崩溃、另一个 carrier 初始 absent 时跳过；payload fsync 后 plan 缺失的 deterministic
per-payload audit，以及 audit plan/rename/completed、多个 payload 部分完成的 quarantine 重放；
aborted_cleanup 的无-repair CLI 与错误 repair 参数拒绝；以及 terminal active lease
未归档时 normal migrate preflight 拒绝。不得用一个笼统“recovery crash”测试替代这些窗口。

旧浅函数的内部测试在新 Module Interface 测试覆盖同一行为后删除，不保留两套重复测试。

## 16. 实施顺序

### Phase 1：确定性状态与诊断

1. 先实现并验证 managed launcher activation/startup registration 与 queue1 durable writer
   registration/fencing epoch；再实现 QueueFileV2 runtime decoder 和锁内 HubQueue Module，
   以 role-scoped ports 作为唯一写入口，通过临时目录、paused-launcher/writer race、activation
   partial-crash 和 capability redaction 测试。
2. 迁移 orchestrator、worker、reconciler、CLI 和所有读侧调用方；删除 `updateEntry`、
   queue v1 loader、散落状态/终态集合和旧浅函数。
3. 把 `release`/`migrate` 接入 CLI registry，实现 §8 的 use/migrate/resume/abort/audit/
   finish-commit、terminal replay、closed recovery resolver 和 RecoveryLease，覆盖所有崩溃窗口；
   此阶段只使用 fixture，不迁移真实运行目录。
4. 实现 `loadCpbBootstrap`、四个 `CpbRoots` 和 Readiness Module 改造。
5. 删除 doctor 旧产品面并补 Node/root/安装测试。
6. 修正文档、canonical command fragment 和文档契合测试。

Phase 1 不需要真实 provider 凭据，必须完全本地可复现。

### Phase 2：配置与类型

1. 生成完整 env inventory，建立 `CpbConfig` schema、typed keys 和 immutable snapshot。
2. 先迁移 orchestrator、worker、engine、readiness、roots 和 child-env，再按 §10.3
   六个分区迁移其余生产读取点。
3. 新增并执行 `typecheck:strict:runtime-contracts`。
4. 删除已经迁移的环境变量别名、`CPB_HOME` 和旧读取函数；启用 inventory/schema/
   未授权 `process.env` 守卫。

### Phase 3：正确性复测

1. 收集真实 Codex mutation audit fixture。
2. 完成 verified-5 新批次。
3. 对比 `officialResolved` 与 `cpbPassed`。
4. 任何不一致回到代码修复，不进入证据 promotion。

### Phase 4：真实发布演练

1. 配置 live provider 和可丢弃 GitHub 仓库。
2. 跑完整 queue-to-finalizer。
3. 创建 disposable draft PR。
4. promotion 正式证据，写到该 release source fingerprint 的 runtime evidence 目录并签名。
5. 从干净 receipt 目录运行唯一的 `npm run verify:release-gate`，确认 17 个 gate
   和最终 readiness report 全部属于同一 signed session/fingerprint。

### Phase 5：发布

1. 停止 Hub，确认没有活动任务；从候选 v0.5 executor 安装 release，完成/验证 managed
   launcher protocol activation，并保存 install JSON 与 activation receipt。
2. 运行 `<generationPath-from-install-json>/cpb release use <release-id> --migrate-queue-v2 --json`，
   保存 committed receipt；不得使用 PATH 中的旧 launcher。
3. 启动 v2 Hub，执行 queue/doctor/readiness 只读检查；任何新写入发生后即进入
   “只能回退到 queue 2 release”的边界。
4. 只有 §17 全部满足后，维护者才可在明确授权下提交、推送并创建 `v0.5.0` tag。
   tag 必须指向通过 receipt 校验的同一 release source fingerprint。

## 17. 最终验收清单

### 17.1 状态和运行

- queue 文件满足完整 `cpb-hub-queue/v2` decoder，file/entry revision 合法。
- 正常 loader 拒绝 v1，迁移不在读取 fallback 中。
- 实际历史两条 queue entry 已迁移，committed receipt 与 queue/release hash 一致，
  initiated/prepared/committed hash chain 完整，queue1 writer fence 为 matching retired，
  launcher admission 已在新 epoch reopen，activation receipt 匹配当前 managed launcher，且
  没有退出 worker claim、writer lease、startup lease、active RecoveryLease 或未审计的
  recovery payload。
- reserve→handoff→accept 的 worker/assignment/attempt 身份一致；raw attempt capability
  未持久化，复制 snapshot 无法取得 worker port；普通调用方无法取得 reconciler/operator
  port，终态重试生成新 lineage。
- Hub total 与全部分类之和相等。
- Hub、doctor、jobs、task view、observability 结果一致。
- `cpb doctor --json` 报告正确 `executorRoot`、`runtimeRoot`、`hubRoot`、
  `releaseStoreRoot` 和 source/managed executor mode，Node 要求来自当前 package `engines.node`。
- doctor 输出中没有无效 Web/server workspace 命令。

### 17.2 代码质量

- `npm run typecheck:strict:runtime-contracts` 通过。
- 这些公开 Interface 没有 `LooseRecord`。
- env inventory 中每一项均已迁移或属于精确允许函数，满足
  `total = migrated + allowed`；生产代码未授权的直接 `process.env` 读取为 0。
- 正常配置拒绝 `CPB_HOME` 和所有退役 key；child env 只由完整 intent、immutable platform
  snapshot、typed config 和 credential adapter 生成。
- Local Code Index 仍为 available/fresh/exact，源码目录没有 `indexes`。
- release source input policy 通过；root `cpb-compat`、`.DS_Store` 和未登记文件已移除。

### 17.3 产品正确性

- verified-5 前四个样本 `officialResolved=4` 且 `cpbPassed=4`。
- 无源码补丁样本未被错误标记成功。
- 每个样本具有完整、脱敏、可校验的 audit 和 artifact 引用。

### 17.4 发布证据

- provider connectivity bundle 有效。
- disposable draft PR bundle 有效且 PR 未合并。
- 正式 live manifest 位于 runtime evidence canonical path；source tree 中不存在旧
  `docs/product/cpb-live-release-validation.json` canonical contract。
- 17 个必跑 gate receipt 全部存在、通过并绑定同一 release source fingerprint、同一
  session、可信 signer 和完整 hash chain/completion manifest。
- patch integrity、product、live、verified-5 和 draft-PR evidence 使用相同 fingerprint，
  且各自 hash 出现在 signed completion manifest。
- `report:release-readiness` 在验证 source manifest、receipt 签名、external evidence 和
  fresh/exact 文件 inventory 后返回 `ready: true`；若任一 gate 声称使用 symbol/reference/call
  关系，还必须验证当次 index coverage 非 file-inventory-only 且不 partial，否则该 gate 失败。

### 17.5 文档和测试

- `npm run verify:docs-contract` 通过，AGENTS/CLAUDE 共享块与 canonical fragment 一致。
- `npm run typecheck` 通过。
- strict/type-debt gate 通过。
- 唯一完整入口 `npm run verify:release-gate` 退出 0；其 receipt 已证明主测试、
  shell、integration、specialized 和 release contracts 全部通过。
- 没有用 fixture、fake、snapshot 或测试替身掩盖生产行为变化。

## 18. 错误码

新增或统一以下错误码：

| 错误码 | 含义 |
|---|---|
| `HUB_QUEUE_SCHEMA_UNSUPPORTED` | 正常运行路径读取到非 v2 queue |
| `HUB_QUEUE_STATUS_UNSUPPORTED` | entry 使用未知状态 |
| `HUB_QUEUE_TRANSITION_INVALID` | 状态跳转不允许 |
| `HUB_QUEUE_CLAIM_INVARIANT` | 状态和 claim 字段不一致 |
| `HUB_QUEUE_AUTHORITY_INVALID` | 调用方没有对应 live role port，或 worker capability/持久化身份不一致 |
| `HUB_QUEUE_IDEMPOTENCY_CONFLICT` | 同一 idempotency key 用于不同 operation 或 payload |
| `HUB_QUEUE_WRITER_FENCE_INVALID` | queue1 writer epoch/lease/admission 与 migration state 不一致 |
| `HUB_QUEUE_INVARIANT_VIOLATION` | 完整文件、revision、lineage、claim 或汇总不变量失败 |
| `HUB_QUEUE_MIGRATION_ACTIVE_WORK` | v1 中仍有活动任务，不能迁移 |
| `HUB_QUEUE_MIGRATION_LEGACY_WRITER_UNFENCED` | 来源 queue1 release 没有 durable writer registration/fencing epoch，不能安全在线迁移 |
| `HUB_QUEUE_MIGRATION_LAUNCHER_UNFENCED` | managed/legacy launcher 没有 durable startup registration，且未取得外部进程隔离能力，不能安全离线迁移 |
| `HUB_QUEUE_MIGRATION_RECOVERY_IN_PROGRESS` | 同一 migration 的 RecoveryLease exact owner 仍活着；无论旧 maintenance generation 是否有效都不得抢占 |
| `HUB_QUEUE_LEGACY_STATE_REVIEW_REQUIRED` | 旧状态没有足够证据可自动映射 |
| `HUB_QUEUE_LEGACY_IDEMPOTENCY_COLLISION` | v1 entryKey 映射到多个 entry 或不同 payload |
| `HUB_QUEUE_MIGRATION_RECOVERY_REQUIRED` | selection、queue、migration receipt、active RecoveryLease 或未审计 recovery payload 需要先恢复/审计 |
| `CPB_ROOTS_INVALID` | executor/runtime/hub/release root 缺失、混用或不安全 |
| `CPB_EXECUTOR_NOT_SELECTED` | 未选择的 staged generation 尝试运行迁移之外的命令 |
| `CPB_LAUNCHER_ACTIVATION_INCOMPLETE` | launcher protocol activation 已开始 durable state/queue 写入但尚未到 open commit point；旧入口继续保持 mask，只能在同级 isolation 下重放 |
| `CPB_CONFIG_UNKNOWN_KEY` | 输入了未登记的 `CPB_*` key |
| `CPB_CONFIG_RETIRED_KEY` | 输入了已移除的 `CPB_HOME` 或其他旧 key |
| `CPB_CONFIG_INVALID` | 配置类型、值或组合非法 |
| `ENV_INVENTORY_UNCLASSIFIED` | 源码直接读取/传递了未在 config、platform 或 credential schema 登记的 env 名称 |
| `RELEASE_SOURCE_CHANGED` | gate session 期间 release source manifest 发生变化 |
| `RELEASE_GATE_SIGNING_AUTHORITY_UNAVAILABLE` | 没有匹配 pinned trust anchor 的正式 signing authority |
| `RELEASE_EVIDENCE_INVALID` | external envelope、byte encoding、kind-specific payload 或有效期不合法 |
| `RELEASE_GATE_RECEIPT_INVALID` | gate/签名/hash chain/completion/evidence 缺失、失败、删改或 fingerprint 不一致 |

错误必须包含可执行的修复方向，但不得包含 secret 值。

## 19. 风险与回退

### 19.1 队列迁移风险

风险最高，因为错误转换会影响重试和历史审计。控制措施是 maintenance lease、durable
launcher startup lease/registry handoff、durable queue1 writer lease/epoch、两个 closing
都等待 lease 归零、exact process identity、活动任务清零、完整校验、hash 备份、先写
initiated 再关闭 admission、active state CAS、prepared 与 terminal receipt 分离、orphan
quarantine、目标 release 先选择、queue 后发布、queue1 fence 先 retired、committed 作为
commit point、closed recovery locator、独占 RecoveryLease、state/admission 可恢复收尾和
startup fail-closed。

恢复 v1 备份只允许在 committed 前、且能证明没有任何 v2 application write 时由
`recover-queue-migration --abort` 执行。一旦 committed 或发生 v2 写入，恢复旧备份会
丢数据，永久禁止；只能回退到支持 queue 2 的代码 release。没有可用 queue 2 release
时保持 Hub 停止并人工恢复。

### 19.2 配置迁移风险

集中解析可能暴露过去被静默接受的拼写错误或非法组合。这是预期行为。实施时提供精确 key 和修复建议，不恢复旧别名。

### 19.3 真实演练风险

真实 provider 会消耗额度，草稿 PR 会改变外部仓库状态。必须使用明确预算、可丢弃仓库和人工授权；失败运行只保存证据，不自动重试到无限次数。

### 19.4 长生命周期进程

正式验收前必须重启仍持有旧 CPB 代码的会话，并记录实际启动版本和 executorRoot。不得把“源码已修复”当作“旧进程已加载修复”。

## 20. 完成定义

本规范完成不等于文件已经写好，也不等于单元测试通过。只有以下条件同时成立才算完成：

1. §17 每一项都有实际命令、文件或外部运行证据。
2. `flow-xxq`、`flow-d97`、`flow-4pt`、`flow-urs`、`flow-c4h`、
   `flow-e68`、`flow-09m` 的本规范范围已完成或被更精确的后续 Bead 取代。
3. `flow-tcf` 只在维护者明确授权并完成 tag 后关闭。
4. release readiness 对准备发布的同一 release source fingerprint、可信 signed session、
   完整 17-gate receipt 与 external evidence 集合返回 `ready: true`。
5. 没有未说明的测试缺口、环境 blocker 或人工假设。
