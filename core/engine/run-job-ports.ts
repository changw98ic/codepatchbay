import type { LooseRecord } from "../contracts/types.js";
import type { BrokerArtifactIndex } from "../../shared/orchestrator/artifact-index.js";
import type {
  ProviderAgents,
  ProviderPool,
  ProviderServices,
} from "./provider-handoff.js";
import type {
  AppendEvent,
  BlockJob,
  CompleteJob,
  CompletePhase,
  FailJob,
  JobRecord,
  ProgressReporter,
} from "./run-job-shared.js";

export type CreateJobPort = (
  cpbRoot: string,
  input: LooseRecord,
) => Promise<JobRecord> | JobRecord;

export type StartPhasePort = (
  cpbRoot: string,
  project: string,
  jobId: string,
  payload: LooseRecord,
) => Promise<unknown> | unknown;

export type PrepareTaskPort = (
  cpbRoot: string,
  input: LooseRecord,
) => Promise<LooseRecord> | LooseRecord;

export type RunJobArtifactIndex = BrokerArtifactIndex;

export type GetArtifactIndexPort = (
  cpbRoot: string,
  project: string,
  jobId: string,
  options?: LooseRecord,
) => Promise<RunJobArtifactIndex | null> | RunJobArtifactIndex | null;

export type RunJobProcessHooks = {
  registerChild?: (pid: number) => void | Promise<void>;
};

/**
 * Infrastructure capabilities consumed by the core job state machine.
 *
 * The server composition root supplies the complete production set. A few
 * capabilities remain optional because the core also supports focused test
 * harnesses and explicit fallback behavior for phase/block/artifact handling.
 */
export type RunJobPorts = {
  createJob: CreateJobPort;
  startPhase?: StartPhasePort;
  completePhase: CompletePhase;
  completeJob: CompleteJob;
  failJob: FailJob;
  blockJob?: BlockJob;
  appendEvent: AppendEvent;
  getPool: () => ProviderPool | null | undefined;
  prepareTask?: PrepareTaskPort;
  getArtifactIndex?: GetArtifactIndexPort;
  providerServices?: ProviderServices | null;
  processHooks?: RunJobProcessHooks;
  onProgress?: ProgressReporter | null;
};

export type RunJobState = {
  cpbRoot: string;
  hubRoot?: string | null;
  project: string;
  task: string;
  jobId?: string | null;
  workflow?: string;
  planMode?: string;
  sourcePath?: string | null;
  managedWorktree?: unknown;
  sourceContext?: LooseRecord | null;
  dataRoot?: string | null;
  maxRetries?: number;
  timeoutMin?: number;
  timeouts?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  scope?: unknown;
  signal?: AbortSignal;
  agent?: string | null;
  agents?: ProviderAgents | null;
  dynamicAgentPlan?: unknown;
  routing?: LooseRecord | null;
  agentAvailability?: LooseRecord | null;
  agentHealth?: LooseRecord | null;
  teamPolicy?: LooseRecord | null;
  _jobId?: string;
  _attemptId?: string;
  _currentPhase?: string | null;
};

export type RunJobContext = RunJobState & RunJobPorts;
