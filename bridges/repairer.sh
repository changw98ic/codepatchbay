#!/usr/bin/env bash
set -euo pipefail

# repairer.sh - ACP + RTK: external CPB self-repair
# Usage: repairer.sh <project> <job-id>

CPB_EXECUTOR_ROOT="${CPB_EXECUTOR_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CPB_ROOT="${CPB_ROOT:-$CPB_EXECUTOR_ROOT}"
# shellcheck source=common.sh
source "$CPB_EXECUTOR_ROOT/bridges/common.sh"

PROJECT="${1:?Usage: repairer.sh <project> <job-id>}"
JOB_ID="${2:?Usage: repairer.sh <project> <job-id>}"
WIKI_DIR="$CPB_ROOT/wiki/projects/$PROJECT"
EVENT_FILE="$CPB_ROOT/cpb-task/events/$PROJECT/$JOB_ID.jsonl"

require_safe_name "$PROJECT"
require_safe_name "$JOB_ID"
require_project "$PROJECT"
require_file "$EVENT_FILE"

LOCK_DIR="$CPB_ROOT/cpb-task/repair-locks/$PROJECT/$JOB_ID.lock"
mkdir -p "$(dirname "$LOCK_DIR")"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Repair already running for $PROJECT/$JOB_ID" >&2
  exit 1
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

REPAIR_ID="$(next_id "$WIKI_DIR/outputs" "repair")"
REPAIR_FILE="$WIKI_DIR/outputs/repair-${REPAIR_ID}.md"
REPAIR_ARTIFACT="repair-${REPAIR_ID}"

record_repair_event() {
  local event_type="$1"
  local repair_status="${2:-}"
  local error_msg="${3:-}"
  CPB_REPAIR_EVENT_TYPE="$event_type" \
  CPB_REPAIR_STATUS="$repair_status" \
  CPB_REPAIR_ERROR="$error_msg" \
  CPB_REPAIR_ARTIFACT="$REPAIR_ARTIFACT" \
  CPB_REPAIR_FILE="$REPAIR_FILE" \
  CPB_REPAIR_PROJECT="$PROJECT" \
  CPB_REPAIR_JOB_ID="$JOB_ID" \
  CPB_ROOT="$CPB_ROOT" \
  CPB_EXECUTOR_ROOT="$CPB_EXECUTOR_ROOT" \
  node --input-type=module - <<'NODE'
import path from "node:path";

const cpbRoot = path.resolve(process.env.CPB_ROOT);
const executorRoot = path.resolve(process.env.CPB_EXECUTOR_ROOT || cpbRoot);
const project = process.env.CPB_REPAIR_PROJECT;
const jobId = process.env.CPB_REPAIR_JOB_ID;
const type = process.env.CPB_REPAIR_EVENT_TYPE;
const status = process.env.CPB_REPAIR_STATUS || undefined;
const error = process.env.CPB_REPAIR_ERROR || undefined;
const artifact = process.env.CPB_REPAIR_ARTIFACT;
const file = process.env.CPB_REPAIR_FILE;

const { appendEvent, checkpointJob } = await import(path.join(executorRoot, "server/services/event-store.js"));
const { readEvents, materializeJob } = await import(path.join(executorRoot, "server/services/event-store.js"));
const { updateJobsIndexEntry } = await import(path.join(executorRoot, "server/services/jobs-index.js"));

const event = {
  type,
  jobId,
  project,
  artifact,
  file,
  ts: new Date().toISOString(),
};
if (status) event.repairStatus = status;
if (error) event.error = error;

await appendEvent(cpbRoot, project, jobId, event);
await checkpointJob(cpbRoot, project, jobId).catch(() => {});
const state = materializeJob(await readEvents(cpbRoot, project, jobId));
await updateJobsIndexEntry(cpbRoot, project, jobId, state).catch(() => {});
NODE
}

create_lineage_task() {
  local repair_status="$1"
  CPB_REPAIR_STATUS="$repair_status" \
  CPB_REPAIR_ARTIFACT="$REPAIR_ARTIFACT" \
  CPB_REPAIR_PROJECT="$PROJECT" \
  CPB_REPAIR_JOB_ID="$JOB_ID" \
  CPB_ROOT="$CPB_ROOT" \
  CPB_EXECUTOR_ROOT="$CPB_EXECUTOR_ROOT" \
  CPB_HUB_ROOT="${CPB_HUB_ROOT:-}" \
  node --input-type=module - <<'NODE'
import { readFile } from "node:fs/promises";
import path from "node:path";

const cpbRoot = path.resolve(process.env.CPB_ROOT);
const executorRoot = path.resolve(process.env.CPB_EXECUTOR_ROOT || cpbRoot);
const project = process.env.CPB_REPAIR_PROJECT;
const jobId = process.env.CPB_REPAIR_JOB_ID;
const repairStatus = process.env.CPB_REPAIR_STATUS;
const repairArtifact = process.env.CPB_REPAIR_ARTIFACT;

const { materializeJob, readEvents } = await import(path.join(executorRoot, "server/services/event-store.js"));
const { resolveHubRoot } = await import(path.join(executorRoot, "server/services/hub-registry.js"));
const { enqueue, listQueue } = await import(path.join(executorRoot, "server/services/hub-queue.js"));

const job = materializeJob(await readEvents(cpbRoot, project, jobId));
if (!job?.task) {
  throw new Error(`job task missing: ${jobId}`);
}

const hubRoot = resolveHubRoot(cpbRoot);
const entries = await listQueue(hubRoot, { projectId: project });
const origin =
  entries.find((entry) => entry.metadata?.jobId === jobId) ||
  entries.find((entry) => entry.description === job.task && entry.status === "failed") ||
  entries.find((entry) => entry.description === job.task) ||
  null;

let sourcePath = origin?.sourcePath || "";
if (!sourcePath) {
  try {
    const metaFile = path.join(cpbRoot, "wiki", "projects", project, "project.json");
    const meta = JSON.parse(await readFile(metaFile, "utf8"));
    sourcePath = meta.sourcePath || "";
  } catch {}
}

const entry = await enqueue(hubRoot, {
  projectId: project,
  sourcePath,
  sessionId: origin?.sessionId || null,
  workerId: origin?.workerId || null,
  cwd: origin?.cwd || sourcePath,
  executionBoundary: origin?.executionBoundary || "worktree",
  type: origin?.type || "pipeline",
  priority: origin?.priority || "P2",
  description: job.task,
  metadata: {
    ...(origin?.metadata || {}),
    originJobId: jobId,
    originQueueEntryId: origin?.id || null,
    repairArtifact,
    repairStatus,
    lineageReason: "external_repair_fixed_cpb_self_bug",
  },
});

console.log(`New task: ${entry.id}`);
NODE
}

echo "Repairing [$PROJECT] $JOB_ID..."
echo "Repair: $REPAIR_FILE"

record_repair_event "external_repair_started"

CPB_ACP_CWD="$CPB_EXECUTOR_ROOT"
export CPB_ACP_CWD

PROMPT="$(rtk_repairer "$PROJECT" "$JOB_ID" "$REPAIR_FILE")"
set +e
printf '%s' "$PROMPT" | acp_run claude 2>&1
ACP_RC=$?
set -e

if [ "$ACP_RC" -ne 0 ]; then
  record_repair_event "external_repair_failed" "" "repairer exited $ACP_RC"
  exit "$ACP_RC"
fi

if [ ! -s "$REPAIR_FILE" ]; then
  record_repair_event "external_repair_failed" "" "repair report not created"
  echo "Repair report not created: $REPAIR_FILE" >&2
  exit 1
fi

REPAIR_STATUS="$(sed -n -E '1s/^REPAIR:[[:space:]]*([A-Z_]+).*$/\1/p' "$REPAIR_FILE")"
case "$REPAIR_STATUS" in
  FIXED|NOOP|BLOCKED) ;;
  *)
    record_repair_event "external_repair_failed" "" "invalid repair status: ${REPAIR_STATUS:-missing}"
    echo "Invalid repair status in $REPAIR_FILE" >&2
    exit 1
    ;;
esac

record_repair_event "external_repair_completed" "$REPAIR_STATUS"

if [ "$REPAIR_STATUS" = "FIXED" ]; then
  create_lineage_task "$REPAIR_STATUS"
fi
