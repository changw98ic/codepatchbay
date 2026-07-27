/**
 * TaskView field boundary — the frozen forbidden-set + whitelist that govern
 * what a public TaskView may contain.
 *
 * See `task-view.ts` for the TaskView type. This module is the ENFORCEMENT
 * layer: `sanitizeTaskView` strips forbidden fields from a raw projection,
 * and `PUBLIC_TASKVIEW_FIELDS` is the 1:1 whitelist of the type's keys (used
 * by the contract test to catch drift).
 */

/**
 * Fields that MUST NEVER appear on a public TaskView.
 *
 * Each leaks internal execution detail that a product consumer cannot act on
 * and, in some cases, MUST NOT see (secrets, host filesystem layout):
 *
 *   jobId / attemptId    — internal lifecycle identifiers; `taskId` (the queue
 *                          entry id) is the only identifier a public consumer
 *                          may hold. Leaking jobId implies a 1:1 task-to-job
 *                          registry that explicitly does NOT exist.
 *
 *   provider / agent     — WHICH provider/agent executed is an implementation
 *                          choice; the product surface conveys only lifecycle
 *                          state, never the execution backend.
 *
 *   lease / leaseId      — runtime concurrency primitives; never user-visible.
 *
 *   session / sessionId  — ACP session identity; never user-visible.
 *
 *   PID / pid            — OS process state; cannot be acted on by a user and
 *                          reveals host process layout.
 *
 *   prompt / promptBytes — the full prompt is a private artifact (and may
 *                          include task/context the user did not author for
 *                          display); the product surface exposes `summary`.
 *
 *   env / environment /  — environment variables may contain secrets (tokens,
 *     environmentVariables paths); never surface them, even as a key list.
 *
 *   cwd / sourcePath /   — absolute runtime paths expose the host's filesystem
 *     runtimePath /        layout (and on shared machines, other users'
 *     worktreePath /       directories). Only repo-relative `changedFiles`
 *     cpbRoot / hubRoot /  are public.
 *     executorRoot /
 *     controlRoot /
 *     dataRoot
 *
 * The set is frozen as the source of truth. `sanitizeTaskView` enforces it at
 * the projection boundary. Adding a new forbidden name requires a contract
 * change (and a test case proving it is stripped).
 */
export const FORBIDDEN_TASKVIEW_FIELDS: readonly string[] = Object.freeze([
  // internal lifecycle identifiers
  "jobId",
  "attemptId",
  "originJobId",
  "retryJobId",
  // execution backend identity
  "provider",
  "agent",
  // runtime concurrency primitives
  "lease",
  "leaseId",
  "session",
  "sessionId",
  // OS process state
  "PID",
  "pid",
  // private prompt artifacts
  "prompt",
  "promptBytes",
  // environment (may carry secrets)
  "env",
  "environment",
  "environmentVariables",
  // absolute runtime paths
  "cwd",
  "sourcePath",
  "runtimePath",
  "worktreePath",
  "cpbRoot",
  "hubRoot",
  "executorRoot",
  "controlRoot",
  "dataRoot",
]);

/**
 * The COMPLETE whitelist of public TaskView field names.
 *
 * MUST stay in 1:1 sync with the keys of the `TaskView` interface in
 * `task-view.ts`. The contract test asserts that a sample TaskView contains
 * exactly these keys and no others — adding a field to `TaskView` without
 * adding it here fails the test, and vice versa. Sorted to make the
 * deep-equal assertion in the test order-independent.
 */
export const PUBLIC_TASKVIEW_FIELDS: readonly string[] = Object.freeze([
  "changedFiles",
  "checks",
  "createdAt",
  "nextAction",
  "progress",
  "schemaVersion",
  "state",
  "summary",
  "taskId",
  "updatedAt",
]);

const FORBIDDEN_SET: ReadonlySet<string> = new Set(FORBIDDEN_TASKVIEW_FIELDS);

/**
 * Return a shallow copy of `raw` with every forbidden field removed.
 *
 * BLACKLIST semantics: only the names in FORBIDDEN_TASKVIEW_FIELDS are
 * stripped; every other key — including unknown future public fields — is
 * preserved. This is intentional: sanitize must not silently drop a field the
 * contract intentionally added. The whitelist (PUBLIC_TASKVIEW_FIELDS) is a
 * separate assertion about a CONSTRUCTED TaskView, not a sanitizer mode.
 *
 * Operates shallowly: nested objects inside public fields (e.g. `progress`,
 * `checks[]`, `nextAction`) pass through verbatim — the contract forbids
 * specific TOP-LEVEL keys, not arbitrary nested data.
 *
 * Idempotent and non-mutating: the input object is never modified, and
 * sanitizing twice yields the same output as sanitizing once.
 */
export function sanitizeTaskView(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (FORBIDDEN_SET.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * True iff `name` is in the forbidden set. Exposed for callers that want to
 * check a single field without constructing a full sanitize pass (e.g. a
 * projector that asserts it never writes a forbidden key).
 */
export function isForbiddenTaskViewField(name: string): boolean {
  return FORBIDDEN_SET.has(name);
}
