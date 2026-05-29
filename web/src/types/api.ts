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

export interface PipelineState {
  status: 'idle' | 'running' | 'completed' | 'failed' | 'blocked';
  phase?: string;
  error?: string;
  jobId?: string;
  startedAt?: string;
  updatedAt?: string;
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
  status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'waiting.approval';
  phase?: string;
  createdAt: string;
  updatedAt: string;
  leaseId?: string;
  artifacts?: Artifact[];
  approval?: ApprovalInfo;
}

export interface ApprovalInfo {
  operation: string | null;
  phase: string | null;
  channels: string[];
  reason: string | null;
  requestedAt: string | null;
  timeoutAt: string | null;
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
