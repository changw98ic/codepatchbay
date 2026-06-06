export interface Project {
  id?: string;
  name: string;
  path?: string;
  pipelineState?: PipelineState;
  projectIndex?: ProjectIndex;
  inbox?: number;
  outputs?: number;
  recentLog?: string[];
  worker?: WorkerStatus;
}

export type PipelineStatusValue =
  | 'idle'
  | 'pending'
  | 'queued'
  | 'running'
  | 'retrying'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancelled';

export interface PipelineNode {
  id: string;
  phase?: string;
  status?: PipelineStatusValue | string;
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
}

export interface PipelineState {
  project?: string;
  task?: string;
  status?: PipelineStatusValue | string;
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
  nodes?: PipelineNode[];
}

export interface ProjectIndex {
  state: 'indexed' | 'indexing' | 'none' | 'error';
  branch?: string;
  fileCount?: number;
  lastIndexed?: string;
}

export interface WorkerStatus {
  status: 'idle' | 'busy' | 'offline';
  agent?: string;
  currentJob?: string;
}

export interface HubDashboard {
  status: { projectCount: number };
  registryProjects: HubProject[];
  acp: AcpStatus;
  knowledgePolicy: unknown;
  queueStatus: QueueStatus;
  queueEntries: QueueEntry[];
  dispatches: Dispatch[];
  observability: unknown;
  taskLedger: TaskLedger | null;
}

export interface HubProject {
  id: string;
  name: string;
  sourcePath?: string;
  workerDerivedStatus: string;
  worker: WorkerStatus;
}

export interface AcpStatus {
  pools: Record<string, { size: number; active: number }>;
}

export interface QueueStatus {
  total?: number;
  pending: number;
  scheduled?: number;
  inProgress?: number;
  running: number;
  completed: number;
  failed: number;
  failedEntries?: number;
  failedTargets?: number;
  retryingFailedTargets?: number;
  retriedFailedTargets?: number;
  unretriedFailedTargets?: number;
  blocked?: number;
  cancelled?: number;
}

export interface QueueEntry {
  id: string;
  project: string;
  projectId?: string;
  status: string;
  instruction: string;
  createdAt: string;
}

export interface Dispatch {
  id: string;
  project: string;
  projectId?: string;
  agent: string;
  status: string;
  startedAt: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface TaskLedger {
  total: number;
  open: number;
  inProgress: number;
  done: number;
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

export interface ArtifactIndex {
  schemaVersion: number;
  project: string;
  jobId: string;
  generatedAt?: string;
  entries: ArtifactIndexEntry[];
  brokenReferences: ArtifactIndexEntry[];
}

export interface VerdictDetail {
  status: string;
  confidence: string | number | null;
  reason: string | null;
  blockingCount: number;
  fixScope: string[];
  path: string;
  artifactId: string | null;
  source: string | null;
}

export interface ArtifactWarning {
  kind: string;
  id: string | null;
  path: string | null;
  message: string;
}

export interface JobArtifactDetailResponse {
  project: string;
  jobId: string;
  artifactIndex: ArtifactIndex;
  verdict: VerdictDetail | null;
  warnings: ArtifactWarning[];
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
  reviewRounds?: ReviewRound[];
  createdAt: string;
  updatedAt: string;
}

export interface ReviewRound {
  round: number;
  issues: ReviewIssue[];
  verdict: 'PASS' | 'FAIL' | 'PARTIAL';
}

export interface ReviewIssue {
  severity: 'critical' | 'major' | 'minor';
  file: string;
  line?: number;
  message: string;
}

export interface InboxFile {
  name: string;
  path: string;
  modified: string;
  size: number;
}

export interface OutputFile {
  name: string;
  path: string;
  modified: string;
  size: number;
}

// --- Inbox / Audit Workbench types ---

export type InboxRequestType = 'pipeline' | 'queued' | 'review';
export type InboxPriority = 'P0' | 'P1' | 'P2';
export type InboxStatus = 'queued' | 'running' | 'completed' | 'failed' | 'blocked' | 'passed' | 'pr-opened' | 'cancelled';

export interface RequestSource {
  type: string;
  label: string;
  issueNumber?: number | null;
  repo?: string | null;
  channel?: string | null;
}

export interface NextHumanAction {
  kind: string;
  label: string;
}

export interface InboxRequestRow {
  id: string;
  type: InboxRequestType;
  project: string;
  task: string;
  status: InboxStatus | string;
  rawStatus: string | null;
  priority: InboxPriority;
  phase: string | null;
  currentPhase: string | null;
  retryCount: number;
  source: RequestSource;
  nextHumanAction: NextHumanAction | null;
  pr: { url?: string; number?: number } | null;
  failureCode: string | null;
  failurePhase: string | null;
  cancelRequested: boolean;
  redirectContext: unknown;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string | null;
  lastActivityMessage: string | null;
}

export interface InboxResponse {
  items: InboxRequestRow[];
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

export interface InboxReviewBundle {
  schemaVersion?: number;
  bundleType?: string;
  generatedAt?: string;
  status?: {
    jobStatus?: string;
    completedPhases?: string[];
    failureCode?: string | null;
    failurePhase?: string | null;
  };
  links?: {
    eventLog?: string | null;
    artifacts: Array<{
      kind?: string;
      phase?: string | null;
      path?: string;
      broken?: boolean;
      reason?: string | null;
    }>;
  };
  artifacts: Array<{
    id?: string;
    kind?: string;
    phase?: string | null;
    path?: string;
    broken?: boolean;
    reason?: string | null;
  }>;
  evidence: {
    plan: { path: string | null; content: string } | null;
    deliverable: { path: string | null; content: string } | null;
    verdict: unknown;
    review: string | null;
    diffStat: string | null;
    changedFiles: string[];
  };
  timeline: Array<{
    type?: string;
    ts?: string | null;
    phase?: string | null;
    agent?: string | null;
    status?: string | null;
  }>;
  error?: string;
}

export interface ReviewLoopRound {
  round: number;
  verdict: 'accepted' | 'rejected' | string;
  feedback?: string | null;
  retryQueueEntryId?: string | null;
  bundleId?: string | null;
  actor?: string | null;
  createdAt?: string | null;
}

export interface ReviewLoopState {
  rounds: ReviewLoopRound[];
  latest?: ReviewLoopRound | null;
}

export interface InboxArtifactDrilldown {
  plan: ({ path?: string | null; content: string; broken?: boolean; reason?: string | null } | null);
  deliverable: ({ path?: string | null; content: string; broken?: boolean; reason?: string | null } | null);
  verdict: ({ path?: string | null; parsed: unknown; broken?: boolean; reason?: string | null } | null);
  review: ({ path?: string | null; content: string; broken?: boolean; reason?: string | null } | null);
}

export interface InboxRequestDetail extends InboxRequestRow {
  pipelineState?: PipelineState;
  retryChain?: RetryChainEntry[];
  reviewBundle?: InboxReviewBundle;
  reviewLoop?: ReviewLoopState;
  workflow?: string;
  research?: { codex?: string; claude?: string };
  plan?: string | null;
  deliverable?: string | null;
  verdict?: unknown;
  artifacts?: InboxArtifactDrilldown;
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
