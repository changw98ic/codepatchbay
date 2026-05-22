import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// The challenge: run-pipeline.mjs runs bridge scripts (planner.sh, etc.) which
// delegate to run-phase.mjs.  run-phase.mjs ALSO validates artifacts before
// printing Plan:/Deliverable: lines.  The pipeline-level PLAN_ARTIFACT_INVALID
// and ISSUE_MISMATCH checks are defense-in-depth, reachable only when the
// bridge prints the ID line despite an invalid artifact.
//
// To test the pipeline-level validation, we create a minimal executor root
// with bypass bridge scripts that always print Plan:/Deliverable: lines,
// delegating validation to the pipeline itself.
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);

// ---------------------------------------------------------------------------
// ACP stub — replaces the ACP client, writes files based on prompt content
// ---------------------------------------------------------------------------

async function writeAcpStub(stubPath, opts) {
  const planContent = (opts.planContent ?? "").replace(/'/g, "'\\''");
  const deliverableContent = (opts.deliverableContent ?? "").replace(/'/g, "'\\''");
  const shouldCreatePlan = opts.planContent !== null;
  const shouldCreateDeliverable = opts.createDeliverable !== false;

  await writeFile(stubPath, `#!/usr/bin/env bash
set -euo pipefail

agent=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --agent) agent="$2"; shift 2 ;;
    --cwd) shift 2 ;;
    *) shift ;;
  esac
done

prompt="$(cat)"
output_file="$(
  printf '%s\\n' "$prompt" |
    sed -n -E 's/^([0-9]+\\. )?Write the (plan|deliverable|verdict) to: (.*)$/\\3/p' |
    tail -1
)"

if [ -z "$output_file" ]; then
  echo "stub could not find output path in prompt" >&2
  exit 1
fi

mkdir -p "$(dirname "$output_file")"

case "$agent" in
  codex)
    if printf '%s\\n' "$prompt" | grep -q "Give a verdict"; then
      printf 'VERDICT: PASS\\nAll acceptance criteria satisfied.\\n' > "$output_file"
    else
      ${shouldCreatePlan ? `printf '%s' '${planContent}' > "$output_file"` : ": # skip plan creation"}
    fi
    ;;
  claude)
    if ${shouldCreateDeliverable ? "true" : "false"}; then
      printf '%s' '${deliverableContent}' > "$output_file"
    fi
    ;;
  *)
    echo "unexpected agent: $agent" >&2
    exit 1
    ;;
esac
`, "utf8");
  await chmod(stubPath, 0o755);
}

// ---------------------------------------------------------------------------
// Bypass bridge scripts — always print ID lines, let pipeline validate
// ---------------------------------------------------------------------------

async function writeBypassPlanner(bridgePath) {
  await writeFile(bridgePath, `#!/usr/bin/env bash
set -euo pipefail
CPB_ROOT="\${CPB_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
PROJECT="\${1:?project required}"
TASK="\$2"

inbox_dir="$CPB_ROOT/wiki/projects/$PROJECT/inbox"
mkdir -p "$inbox_dir"

# Allocate next plan ID
id=1
while [ -f "$inbox_dir/plan-$(printf '%03d' $id).md" ]; do
  id=$((id + 1))
done
plan_id="$(printf '%03d' $id)"
plan_path="$inbox_dir/plan-\${plan_id}.md"

# Build prompt and pipe to ACP client
acp_client="\${CPB_ACP_CLIENT:?CPB_ACP_CLIENT required}"
printf '1. Write the plan to: %s\\nPlan the following task: %s\\n' "$plan_path" "$TASK" \\
  | "$acp_client" --agent codex --cwd "\${CPB_ACP_CWD:-$PWD}"

# Always print Plan: line so pipeline extracts the ID
echo "Plan: $plan_path"
`, "utf8");
  await chmod(bridgePath, 0o755);
}

async function writeBypassExecutor(bridgePath) {
  await writeFile(bridgePath, `#!/usr/bin/env bash
set -euo pipefail
CPB_ROOT="\${CPB_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
PROJECT="\${1:?project required}"
PLAN_ID="\${2:?plan-id required}"

outputs_dir="$CPB_ROOT/wiki/projects/$PROJECT/outputs"
mkdir -p "$outputs_dir"

# Allocate next deliverable ID
id=1
while [ -f "$outputs_dir/deliverable-$(printf '%03d' $id).md" ]; do
  id=$((id + 1))
done
deliverable_id="$(printf '%03d' $id)"
deliverable_path="$outputs_dir/deliverable-\${deliverable_id}.md"

acp_client="\${CPB_ACP_CLIENT:?CPB_ACP_CLIENT required}"
printf '1. Write the deliverable to: %s\\nExecute plan %s\\n' "$deliverable_path" "$PLAN_ID" \\
  | "$acp_client" --agent claude --cwd "\${CPB_ACP_CWD:-$PWD}"

# Always print Deliverable: line
echo "Deliverable: $deliverable_path"
`, "utf8");
  await chmod(bridgePath, 0o755);
}

async function writeBypassVerifier(bridgePath) {
  await writeFile(bridgePath, `#!/usr/bin/env bash
set -euo pipefail
CPB_ROOT="\${CPB_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
PROJECT="\${1:?project required}"
ARTIFACT="\${2:-}"
VERDICT_ID="\${ARTIFACT:-verdict}"

outputs_dir="$CPB_ROOT/wiki/projects/$PROJECT/outputs"
verdict_path="$outputs_dir/verdict-\${VERDICT_ID}.md"

acp_client="\${CPB_ACP_CLIENT:?CPB_ACP_CLIENT required}"
printf '1. Write the verdict to: %s\\nGive a verdict for %s\\n' "$verdict_path" "$ARTIFACT" \\
  | "$acp_client" --agent codex --cwd "\${CPB_ACP_CWD:-$PWD}"
`, "utf8");
  await chmod(bridgePath, 0o755);
}

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

async function readJobEvents(cpbRoot, project) {
  const eventsDir = path.join(cpbRoot, "cpb-task", "events", project);
  const [eventFileName] = await readdir(eventsDir);
  const eventFile = await readFile(path.join(eventsDir, eventFileName), "utf8");
  return eventFile
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Create a minimal executor root with bypass bridge scripts and symlinked
 * server/ directory from the real project so that job-store.js etc. resolve.
 */
async function setupEnv(root, project) {
  const cpbRoot = path.join(root, "cpb");
  const executorRoot = path.join(root, "executor");
  const sourcePath = path.join(root, "source");
  const stubPath = path.join(root, "acp-stub.sh");
  const bridgesDir = path.join(executorRoot, "bridges");

  // Source path
  await mkdir(sourcePath, { recursive: true });

  // CPB root wiki structure
  await mkdir(path.join(cpbRoot, "wiki", "system"), { recursive: true });
  await writeFile(
    path.join(cpbRoot, "wiki", "system", "dashboard.md"),
    "# Dashboard\n",
    "utf8",
  );
  await mkdir(path.join(cpbRoot, "wiki", "projects", project, "inbox"), { recursive: true });
  await mkdir(path.join(cpbRoot, "wiki", "projects", project, "outputs"), { recursive: true });

  // Executor root: symlink server/ from real project for job-store.js etc.
  await mkdir(bridgesDir, { recursive: true });
  await symlink(path.join(PROJECT_ROOT, "server"), path.join(executorRoot, "server"));
  await symlink(path.join(PROJECT_ROOT, "bridges", "common.sh"), path.join(bridgesDir, "common.sh"));
  await symlink(path.join(PROJECT_ROOT, "bridges", "run-phase.mjs"), path.join(bridgesDir, "run-phase.mjs"));
  await symlink(path.join(PROJECT_ROOT, "bridges", "run-pipeline.mjs"), path.join(bridgesDir, "run-pipeline.mjs"));
  await symlink(path.join(PROJECT_ROOT, "bridges", "project-worker.mjs"), path.join(bridgesDir, "project-worker.mjs"));
  await symlink(path.join(PROJECT_ROOT, "bridges", "job-runner.mjs"), path.join(bridgesDir, "job-runner.mjs"));
  await symlink(path.join(PROJECT_ROOT, "package.json"), path.join(executorRoot, "package.json"));

  // Write bypass bridge scripts
  await writeBypassPlanner(path.join(bridgesDir, "planner.sh"));
  await writeBypassExecutor(path.join(bridgesDir, "executor.sh"));
  await writeBypassVerifier(path.join(bridgesDir, "verifier.sh"));

  return { cpbRoot, executorRoot, sourcePath, stubPath };
}

async function runPipeline(cpbRoot, executorRoot, sourcePath, stubPath, project, task, extraEnv = {}) {
  return execFileAsync(process.execPath, [
    path.join(PROJECT_ROOT, "bridges", "run-pipeline.mjs"),
    "--project", project,
    "--task", task,
    "--source-path", sourcePath,
    "--max-retries", "1",
  ], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      CPB_ROOT: cpbRoot,
      CPB_EXECUTOR_ROOT: executorRoot,
      CPB_ACP_CLIENT: stubPath,
      CPB_WORKER_DISPATCH_ENABLED: "0",
      CPB_USE_WORKTREE: "0",
      ...extraEnv,
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("empty plan artifact fails with PLAN_ARTIFACT_INVALID before execute", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-artifact-empty-"));
  const project = "empty-plan";

  try {
    const { cpbRoot, executorRoot, sourcePath, stubPath } = await setupEnv(root, project);

    // ACP stub creates an empty plan file
    await writeAcpStub(stubPath, {
      planContent: "",
      createDeliverable: true,
      deliverableContent: "# Deliverable\n\nGenerated by stub.\n",
    });

    await assert.rejects(
      () => runPipeline(cpbRoot, executorRoot, sourcePath, stubPath, project, "empty plan test"),
      (err) => {
        assert.ok(err, "pipeline should fail non-zero");
        return true;
      },
    );

    const events = await readJobEvents(cpbRoot, project);
    const failed = events.find((e) => e.type === "job_failed");
    assert.ok(failed, "job_failed event must exist");
    assert.equal(failed.code, "PLAN_ARTIFACT_INVALID");
    assert.equal(failed.phase, "plan");

    const executeStarted = events.some(
      (e) => e.type === "phase_started" && e.phase === "execute",
    );
    assert.ok(!executeStarted, "execute phase must not start when plan is invalid");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing plan artifact fails with PLAN_ARTIFACT_INVALID before execute", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-artifact-missing-"));
  const project = "missing-plan";

  try {
    const { cpbRoot, executorRoot, sourcePath, stubPath } = await setupEnv(root, project);

    // ACP stub does NOT create the plan file
    await writeAcpStub(stubPath, {
      planContent: null,
      createDeliverable: true,
      deliverableContent: "# Deliverable\n\nGenerated by stub.\n",
    });

    await assert.rejects(
      () => runPipeline(cpbRoot, executorRoot, sourcePath, stubPath, project, "missing plan test"),
      (err) => {
        assert.ok(err, "pipeline should fail non-zero");
        return true;
      },
    );

    const events = await readJobEvents(cpbRoot, project);
    const failed = events.find((e) => e.type === "job_failed");
    assert.ok(failed, "job_failed event must exist");
    assert.equal(failed.code, "PLAN_ARTIFACT_INVALID");
    assert.equal(failed.phase, "plan");

    const executeStarted = events.some(
      (e) => e.type === "phase_started" && e.phase === "execute",
    );
    assert.ok(!executeStarted, "execute phase must not start when plan artifact is missing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("wrong-issue deliverable fails with ISSUE_MISMATCH", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-artifact-wrongissue-"));
  const project = "wrong-issue";

  try {
    const { cpbRoot, executorRoot, sourcePath, stubPath } = await setupEnv(root, project);

    // ACP stub creates valid plan but deliverable with wrong issue
    await writeAcpStub(stubPath, {
      planContent: "# Plan: artifact integrity test\n\nAcceptance-Criteria:\n- correct issue check\n",
      createDeliverable: true,
      deliverableContent: "# Deliverable\n\nTask-Ref: GitHub issue #32\n\nGenerated by wrong-issue stub.\n",
    });

    await assert.rejects(
      () =>
        runPipeline(cpbRoot, executorRoot, sourcePath, stubPath, project, "wrong issue test", {
          CPB_ISSUE_NUMBER: "63",
        }),
      (err) => {
        assert.ok(err, "pipeline should fail non-zero for issue mismatch");
        return true;
      },
    );

    const events = await readJobEvents(cpbRoot, project);
    const failed = events.find((e) => e.type === "job_failed");
    assert.ok(failed, "job_failed event must exist");
    assert.equal(failed.code, "ISSUE_MISMATCH");
    assert.equal(failed.phase, "execute");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("correct-issue deliverable passes validation and pipeline succeeds", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-artifact-correctissue-"));
  const project = "correct-issue";

  try {
    const { cpbRoot, executorRoot, sourcePath, stubPath } = await setupEnv(root, project);

    // ACP stub creates valid plan and deliverable with matching issue
    await writeAcpStub(stubPath, {
      planContent: "# Plan: artifact integrity test\n\nAcceptance-Criteria:\n- issue numbers match\n",
      createDeliverable: true,
      deliverableContent: "# Deliverable\n\nTask-Ref: GitHub issue #63\n\nGenerated by correct-issue stub.\n",
    });

    // Should succeed
    await runPipeline(cpbRoot, executorRoot, sourcePath, stubPath, project, "correct issue test", {
      CPB_ISSUE_NUMBER: "63",
    });

    const events = await readJobEvents(cpbRoot, project);
    const completed = events.find((e) => e.type === "job_completed");
    assert.ok(completed, "job should complete successfully when issue matches");

    const failed = events.find((e) => e.type === "job_failed");
    assert.ok(!failed, "no job_failed event should exist for a passing pipeline");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
