export interface LooseRecord {
  [key: string]: unknown;
  id?: string | null;
  jobId?: string | null;
  project?: string | null;
  projectId?: string | null;
  phase?: string | null;
  status?: string | null;
  type?: string | null;
  kind?: string | null;
  reason?: string | null;
  code?: string | number | null;
  task?: string | null;
  workflow?: string | null;
  planMode?: string;
  mode?: string;
  sourcePath?: string | null;
  cwd?: string | null;
  dataRoot?: string | null;
  hubRoot?: string | null;
  cpbRoot?: string | null;
  executorRoot?: string | null;
  controlRoot?: string | null;
  workerId?: string | null;
  sessionId?: string | null;
  dispatchId?: string | null;
  queueEntryId?: string | null;
  assignmentId?: string | null;
  originJobId?: string | null;
  repo?: string | null;
  issueUrl?: string | null;
  issueNumber?: number | string | null;
  number?: number;
  title?: string;
  body?: string;
  actor?: LooseRecord | string;
  command?: string;
  args?: string[];
  agent?: string | null;
  role?: string | null;
  message?: string | null;
  note?: string;
  file?: string;
  system?: string;
  protocol?: string;
  displayCommand?: string;
  fullName?: string;
  full_name?: string;
  login?: string;
  npm?: LooseRecord;
  brew?: LooseRecord;
  npxPkg?: string;
  pinnedCommandTemplate?: string;
  installed?: boolean;
  connectCommand?: string;
  statusCommand?: string;
  methods?: LooseRecord;
  providers?: LooseRecord;
  providerHealth?: LooseRecord;
  connectionLeases?: LooseRecord | null;
  triggers?: unknown[];
  ok?: boolean;
  total?: number;
  pending?: number;
  inProgress?: number;
  enabledProjectCount?: number;
  projectCount?: number;
  active?: number;
  maxConcurrency?: number;
  model?: string | null;
  runtime?: string | null;
  queueId?: string | null;
  queuePriority?: number | null;
  concurrencyKey?: string | null;
  rateLimitedUntil?: string | number | null;
  heartbeatAt?: string | null;
  progressKind?: string | null;
  blocker?: string | null;
  nextEligibleAt?: string | number;
  totalTokens?: number;
  tokens?: number;
  riskLevel?: string | null;
  domains?: unknown[];
  adversarialFocus?: unknown[];
  adversarialRequired?: boolean;
  phaseBudgetPolicy?: LooseRecord | null;
  evidenceRequirements?: unknown[];
  required?: boolean;
  confidence?: number | string | null;
  criterion?: string;
  previousOutput?: string;
  failureKind?: string | null;
  failureReason?: string | null;
  attemptId?: string | null;
  workspaceId?: string;
  path?: string | null;
  artifact?: LooseRecord | string | null;
  artifactId?: string | null;
  artifactKind?: string | null;
  name?: string | null;
  url?: string;
  ts?: string;
  createdAt?: string | number;
  updatedAt?: string | number;
  metadata?: LooseRecord | null;
  meta?: LooseRecord | null;
  sourceContext?: LooseRecord | string | null;
  externalRepair?: LooseRecord | null;
  routingFeedback?: LooseRecord | null;
  phaseAgentSelections?: LooseRecord[];
  approval?: LooseRecord | null;
  runtimeContext?: LooseRecord | null;
  auditFinalized?: LooseRecord | null;
  attemptBoundary?: LooseRecord | null;
  pr?: unknown;
  retryContext?: LooseRecord | null;
  retry?: LooseRecord | null;
  reviewLoop?: LooseRecord | null;
  previousFailure?: LooseRecord | null;
  dagResume?: LooseRecord | null;
  routing?: LooseRecord | null;
  effective?: LooseRecord | null;
  effectiveRoute?: LooseRecord | null;
  contextPack?: LooseRecord | null;
  planCache?: LooseRecord | null;
  finalDiffGuard?: LooseRecord | null;
  guardResult?: LooseRecord | null;
  completionGate?: LooseRecord | null;
  completionReport?: LooseRecord | null;
  checklist?: LooseRecord | null;
  checklistStatus?: LooseRecord | null;
  agents?: LooseRecord | null;
  artifacts?: LooseRecord | null;
  items?: LooseRecord[];
  nodes?: LooseRecord[];
  nodeStates?: { [nodeId: string]: LooseRecord };
  phaseStates?: { [phase: string]: LooseRecord | string };
  completedNodes?: string[];
  runningNodes?: string[];
  blockedNodes?: string[];
  consumedRedirectIds?: string[];
  edges?: unknown[];
  tests?: unknown[];
  verdict?: LooseRecord | string | null;
  deliverable?: LooseRecord | string | null;
  plan?: LooseRecord | string | null;
  diffStat?: string;
  route?: LooseRecord | null;
  escalation?: LooseRecord | null;
  actorTrust?: LooseRecord | null;
  jobResult?: LooseRecord | null;
  failure?: LooseRecord | null;
  latest?: LooseRecord | null;
  evidence?: LooseRecord | LooseRecord[] | null;
  request?: LooseRecord | null;
  budget?: LooseRecord | null;
  idempotency?: LooseRecord | null;
  params?: LooseRecord | null;
  options?: LooseRecord | null;
  output?: string | null;
  stdout?: string | null;
  stderr?: string | null;
  usedAcpCalls?: number;
  maxAcpCalls?: number;
  usedPromptBytes?: number;
  maxPromptBytes?: number;
  maxRounds?: number;
  round?: number;
  feedback?: string;
  observation?: LooseRecord;
  verificationMethod?: string;
  queryId?: string;
  matchCount?: number | null;
  allowedFiles?: string[];
  changedFilesInScope?: string[];
  stdoutSha256?: string;
  stderrSha256?: string;
  head?: string | null;
  worktreeHead?: string | null;
  diffHash?: string | null;
  emitFailedClaim?: boolean;
  retryQueueEntryId?: string | null;
  bundleId?: string;
  source?: LooseRecord | string | null;
  sourceType?: string;
  worktree?: string | LooseRecord | null;
  worktreeBaseBranch?: string;
  worktreeBranch?: string;
  failurePhase?: string;
  failedNodeId?: string;
  resumeTarget?: LooseRecord | string | null;
  nodeId?: string | null;
  dagCoverage?: LooseRecord | null;
  checklistOutcome?: LooseRecord | string | null;
  workflowDag?: LooseRecord | null;
  isDag?: boolean;
  executor?: unknown;
  handoff?: unknown;
  panicType?: string;
  finalWorktree?: string | LooseRecord | null;
  reasons?: string[];
  changedFiles?: unknown[];
  entry?: LooseRecord;
  job?: LooseRecord | string | null;
  original?: unknown;
  childTaskIds?: string[];
  protectedScopes?: Array<LooseRecord | string>;
  completedNodeIds?: string[];
}

export function isRecord(value: unknown): value is LooseRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function recordValue(value: unknown): LooseRecord {
  return isRecord(value) ? value : {};
}

/**
 * Canonical phase-execution result. Consolidates the local `type PhaseResult`
 * definitions that were scattered across core/engine (run-phase as the source
 * of truth via phasePassed/phaseFailed, plus provider-quota-fallback /
 * phase-retry / dag-node-failure / poisoned-session-gate / phase-result-events
 * / adversarial-verdict-events / runtime-artifact-events). Shape is based on
 * what phasePassed/phaseFailed return (core/contracts/phase-result.ts) plus
 * the failure fields read by quota-fallback / retry consumers. Event helpers
 * may still narrow locally for their own field access; this type is the
 * cross-file contract for runPhase signatures.
 */
export type PhaseFailure = {
  kind?: string | null;
  reason?: string | null;
  retryable?: boolean;
  cause?: unknown;
  code?: string | number | null;
  [key: string]: unknown;
};

export type PhaseArtifact = {
  name?: string | null;
  path?: string | null;
  id?: string | null;
  kind?: string | null;
  [key: string]: unknown;
};

export type PhaseResult = {
  schemaVersion?: number;
  phase?: string | null;
  status?: string | null;
  artifact?: PhaseArtifact | null;
  failure?: PhaseFailure | null;
  diagnostics?: Record<string, unknown>;
  createdAt?: string;
  [key: string]: unknown;
};
