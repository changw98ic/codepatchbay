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
  pending: number;
  running: number;
  completed: number;
  failed: number;
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
