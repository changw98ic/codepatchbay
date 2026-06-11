export interface Project {
  id?: string;
  name: string;
  path?: string;
  pipelineState?: PipelineState;
  inbox?: number;
  outputs?: number;
  recentLog?: string[];
  worker?: WorkerStatus;
}

export interface PipelineState {
  project?: string;
  task?: string;
  status?: string;
  phase?: string | null;
  phases?: string[];
  error?: string | null;
  jobId?: string;
  retryCount?: number;
  maxRetries?: number | null;
  started?: string;
  updated?: string;
  startedAt?: string;
  updatedAt?: string;
  lastActivityAt?: string | null;
  lastActivityMessage?: string | null;
  completedNodes?: string[];
  runningNodes?: string[];
  blockedNodes?: string[];
  nodes?: Array<{
    id: string;
    phase?: string;
    status?: string;
    attempt?: number | null;
    artifact?: string | null;
    reason?: string | null;
    error?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
    failedAt?: string | null;
    retryingAt?: string | null;
    skippedAt?: string | null;
    cancelledAt?: string | null;
    blockedAt?: string | null;
    durationMs?: number | null;
  }>;
  workflowDag?: {
    name?: string;
    nodes?: Array<Record<string, unknown>>;
    edges?: Array<Record<string, unknown>>;
  } | null;
  riskMap?: Record<string, unknown> | null;
  riskLevel?: string | null;
  verificationDepth?: string | null;
  adversarialRequired?: boolean;
  dynamicAgentPlan?: Record<string, unknown> | null;
  adversarialVerdict?: Record<string, unknown> | null;
}

export interface WorkerStatus {
  status: 'idle' | 'busy' | 'offline';
  agent?: string;
  currentJob?: string;
}

export interface HubDashboard {
  status: { projectCount: number };
  registryProjects: HubProject[];
  acp: { pools: Record<string, { size: number; active: number }> };
  knowledgePolicy: unknown;
  queueStatus: { total?: number; pending: number; scheduled?: number; inProgress?: number; running: number; completed: number; failed: number; failedEntries?: number; failedTargets?: number; retryingFailedTargets?: number; retriedFailedTargets?: number; unretriedFailedTargets?: number; blocked?: number; cancelled?: number };
  queueEntries: Array<{ id: string; project: string; projectId?: string; status: string; instruction: string; createdAt: string }>;
  dispatches: Array<{ id: string; project: string; projectId?: string; agent: string; status: string; startedAt: string; createdAt?: string; updatedAt?: string }>;
  observability: unknown;
  taskLedger: { total: number; open: number; inProgress: number; done: number } | null;
}

export type AttentionSeverity = 'critical' | 'warning' | 'info';

export type AttentionKind =
  | 'workflow_failed'
  | 'dag_node_failed'
  | 'waiting_approval'
  | 'codegraph_unavailable'
  | 'agent_rate_limited'
  | 'jobs_index_divergent'
  | 'stale_runtime'
  | 'review_ready';

export interface AttentionItem {
  id: string;
  severity: AttentionSeverity;
  kind: AttentionKind;
  project: string | null;
  title: string;
  reason: string;
  impact: string;
  ageMs: number | null;
  updatedAt: string | null;
  nextHumanAction: {
    label: string;
    href: string;
    kind: string;
  };
  evidence: Array<{ type: string; id: string; path?: string }>;
}

export interface HubProject {
  id: string;
  name: string;
  sourcePath?: string;
  workerDerivedStatus: string;
  worker: WorkerStatus;
}

export interface DurableJob {
  jobId: string;
  project: string;
  agent: string;
  instruction: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked';
  phase?: string;
  createdAt: string;
  updatedAt: string;
  leaseId?: string;
  artifacts?: Artifact[];
}

export interface Artifact {
  name: string;
  type: string;
  path: string;
  verdict?: 'PASS' | 'FAIL' | 'PARTIAL';
}

export interface ArtifactIndexEntry {
  id: string;
  kind: string;
  phase: string | null;
  path: string;
  sha256: string | null;
  createdAt: string | null;
  producerAgent: string | null;
  exists: boolean;
  broken: boolean;
  reason: string | null;
  eventType: string | null;
}

export interface JobArtifactDetailResponse {
  project: string;
  jobId: string;
  artifactIndex: ArtifactIndexEntry[];
  verdict: { status: string; confidence: string | number | null; reason: string | null; blockingCount: number; fixScope: string[]; path: string; artifactId: string | null; source: string | null } | null;
  warnings: Array<{ kind: string; id: string | null; path: string | null; message: string }>;
}

export interface Agent {
  name: string;
  type: string;
  status: 'available' | 'busy' | 'offline';
  pools: string[];
  jobsCompleted: number;
  jobsFailed: number;
  lastJobAt?: string;
}

export interface ReviewSession {
  id: string;
  project: string;
  status: 'queued' | 'researching' | 'user_review' | 'approved' | 'rejected' | 'cancelled';
  instruction: string;
  research?: { codex?: string; claude?: string };
  plan?: string;
  reviewRounds?: Array<{ round: number; issues: Array<{ severity: string; file: string; line?: number; message: string }>; verdict: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface InboxRequestRow {
  id: string;
  type: string;
  project: string | null;
  task: string;
  status: string;
  rawStatus: string | null;
  priority: string;
  phase: string | null;
  currentPhase: string | null;
  retryCount: number;
  source: { type: string; label: string; issueNumber?: number | null; repo?: string | null; channel?: string | null };
  nextHumanAction: { kind: string; label: string; href?: string } | null;
  attention?: AttentionItem | null;
  pr: { url?: string; number?: number } | null;
  failureCode: string | null;
  failurePhase: string | null;
  cancelRequested: boolean;
  redirectContext: unknown;
  riskLevel: string | null;
  verificationDepth: string | null;
  adversarialRequired: boolean;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string | null;
  lastActivityMessage: string | null;
}

export interface InboxResponse {
  items: InboxRequestRow[];
  attention?: AttentionItem[];
  attentionItems?: AttentionItem[];
  projects: string[];
  statusCounts: Record<string, number>;
  total: number;
}

export interface RetryChainEntry {
  jobId: string;
  status: string;
  phase: string | null;
  failureCode: string | null;
  failurePhase: string | null;
  retryCount: number;
  attempt: number | null;
  createdAt: string;
  updatedAt: string;
  isCurrent: boolean;
}

export interface InboxRequestDetail extends InboxRequestRow {
  pipelineState?: PipelineState;
  retryChain?: RetryChainEntry[];
  reviewBundle?: {
    schemaVersion?: number;
    bundleType?: string;
    generatedAt?: string;
    status?: { jobStatus?: string; completedPhases?: string[]; failureCode?: string | null; failurePhase?: string | null };
    links?: { eventLog?: string | null; artifacts: Array<{ kind?: string; phase?: string | null; path?: string; broken?: boolean; reason?: string | null }> };
    artifacts: Array<{ id?: string; kind?: string; phase?: string | null; path?: string; broken?: boolean; reason?: string | null }>;
    evidence: { plan: { path: string | null; content: string } | null; deliverable: { path: string | null; content: string } | null; verdict: unknown; review: string | null; diffStat: string | null; changedFiles: string[] };
    timeline: Array<{ type?: string; ts?: string | null; phase?: string | null; agent?: string | null; status?: string | null }>;
    error?: string;
  };
  reviewLoop?: {
    rounds: Array<{ round: number; verdict: string; feedback?: string | null; retryQueueEntryId?: string | null; bundleId?: string | null; actor?: string | null; createdAt?: string | null }>;
    latest?: { round: number; verdict: string; feedback?: string | null; retryQueueEntryId?: string | null; bundleId?: string | null; actor?: string | null; createdAt?: string | null } | null;
  };
  workflow?: string;
  research?: { codex?: string; claude?: string };
  plan?: string | null;
  deliverable?: string | null;
  verdict?: unknown;
  artifacts?: {
    plan: ({ path?: string | null; content: string; broken?: boolean; reason?: string | null } | null);
    deliverable: ({ path?: string | null; content: string; broken?: boolean; reason?: string | null } | null);
    verdict: ({ path?: string | null; parsed: unknown; broken?: boolean; reason?: string | null } | null);
    review: ({ path?: string | null; content: string; broken?: boolean; reason?: string | null } | null);
  };
  reviewRounds?: Array<{
    round: number;
    codex?: string | null;
    claude?: string | null;
    issues: Array<{ severity: string; description: string; file?: string | null; line?: number | null }>;
  }>;
  budget?: {
    maxRounds: number;
    maxPromptBytes: number;
    maxAcpCalls: number;
    usedAcpCalls: number;
    usedPromptBytes: number;
  };
  userVerdict?: string | null;
  metadata?: Record<string, unknown>;
}

export interface InboxProjectSummary {
  name: string;
  counts: {
    total: number;
    running: number;
    failed: number;
    blocked: number;
    completed: number;
    queued: number;
  };
}
