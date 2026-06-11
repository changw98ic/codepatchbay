export const BOUNDARY_VERSION = "1.0.0";

export const CONTRACT = {
  jobInput: {
    required: ["project", "jobId", "task", "workflow", "sourcePath", "worktree", "envRefs"],
  },
  artifactOutput: {
    description: "Runner produces artifacts written to the project output directory",
    required: ["kind", "path", "sha256", "createdAt", "producerAgent"],
  },
  eventStream: {
    description: "Runner emits structured events to the job event log",
    required: ["type", "jobId", "project", "ts"],
  },
  secretBoundary: {
    description: "Secrets must be passed as envRefs references, never as raw values in job input",
    allowedSecretInputs: ["envRefs"],
    forbiddenSecretInputs: ["secrets"],
  },
  cancellation: {
    description: "Runner supports cancellation via AbortSignal or lease expiry",
    mechanisms: ["abortSignal", "cancelRequestedEvent", "leaseExpiry"],
  },
};

const REQUIRED_JOB_INPUT_FIELDS = CONTRACT.jobInput.required;

function validateJobInput(input: Record<string, any>) {
  if (!input || typeof input !== "object") {
    throw new Error("jobInput: must be a non-null object");
  }
  const missing = REQUIRED_JOB_INPUT_FIELDS.filter((f) => input[f] === undefined);
  if (missing.length > 0) {
    throw new Error(`jobInput: missing required fields: ${missing.join(", ")}`);
  }
  if ("secrets" in input) {
    throw new Error("secret: raw secrets in job input are forbidden; use envRefs references instead");
  }
}

export function validateRunnerAdapter(adapter: Record<string, any>) {
  if (!adapter || typeof adapter !== "object") {
    throw new Error("adapter: must be a non-null object");
  }
  if (typeof adapter.mode !== "string" || adapter.mode.length === 0) {
    throw new Error("adapter: must have a non-empty string 'mode'");
  }
  if (typeof adapter.kind !== "string" || adapter.kind.length === 0) {
    throw new Error("adapter: must have a non-empty string 'kind'");
  }
  if (typeof adapter.run !== "function") {
    throw new Error("adapter: must have a 'run' function");
  }
  return adapter;
}

export function createLocalRunnerAdapter(runnerFn: (input: Record<string, any>) => unknown | Promise<unknown>) {
  if (typeof runnerFn !== "function") {
    throw new Error("adapter: local runner requires a function");
  }
  const adapter = {
    contractVersion: BOUNDARY_VERSION,
    mode: "local",
    kind: "local",
    async run(input) {
      validateJobInput(input);
      return runnerFn(input);
    },
  };
  validateRunnerAdapter(adapter);
  return adapter;
}
