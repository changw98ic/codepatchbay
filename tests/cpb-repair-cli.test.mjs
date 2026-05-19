import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import test from "node:test";
import { materializeJob, readEvents } from "../server/services/event-store.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(".");

async function writeRepairStub(stubPath) {
  await writeFile(stubPath, `#!/usr/bin/env bash
set -euo pipefail

agent=""
cwd=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --agent) agent="$2"; shift 2 ;;
    --cwd) cwd="$2"; shift 2 ;;
    *) shift ;;
  esac
done

prompt="$(cat)"
printf '%s\\n' "$agent" > "$CPB_TEST_AGENT"
printf '%s\\n' "$cwd" > "$CPB_TEST_CWD"
printf '%s\\n' "$prompt" > "$CPB_TEST_PROMPT"

output_file="$(
  printf '%s\\n' "$prompt" |
    sed -n -E 's/^Write the repair report to: (.*)$/\\1/p' |
    tail -1
)"

[ "$agent" = "claude" ] || { echo "unexpected agent: $agent" >&2; exit 1; }
[ -n "$output_file" ] || { echo "missing repair report path" >&2; exit 1; }

mkdir -p "$(dirname "$output_file")"
printf 'REPAIR: FIXED\\n\\nStub repair report.\\n' > "$output_file"
`, "utf8");
  await chmod(stubPath, 0o755);
}

async function setupRepairFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-repair-cli-"));
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  const sourcePath = path.join(root, "source");
  const stateDir = path.join(root, "state");
  const stubPath = path.join(root, "acp-client-stub.sh");
  const project = "repairproj";
  const jobId = "job-20260519-010203-abcdef";
  const originQueueEntryId = "q-origin";
  const task = "Repair channel task body";
  const wikiDir = path.join(cpbRoot, "wiki", "projects", project);
  const eventsDir = path.join(cpbRoot, "cpb-task", "events", project);
  const eventFile = path.join(eventsDir, `${jobId}.jsonl`);
  const eventMarker = "UNIQUE_EVENT_BODY_SHOULD_NOT_BE_EMBEDDED";

  await mkdir(path.join(wikiDir, "inbox"), { recursive: true });
  await mkdir(path.join(wikiDir, "outputs"), { recursive: true });
  await mkdir(path.join(cpbRoot, "wiki", "system"), { recursive: true });
  await mkdir(path.join(hubRoot, "queue"), { recursive: true });
  await mkdir(sourcePath, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(eventsDir, { recursive: true });

  await writeFile(path.join(wikiDir, "project.json"), JSON.stringify({ sourcePath }, null, 2), "utf8");
  await writeFile(path.join(wikiDir, "context.md"), "# Context\n", "utf8");
  await writeFile(path.join(wikiDir, "decisions.md"), "# Decisions\n", "utf8");
  await writeFile(path.join(wikiDir, "log.md"), "# Log\n", "utf8");
  await writeFile(path.join(cpbRoot, "wiki", "system", "dashboard.md"), "# Dashboard\n", "utf8");
  await writeFile(eventFile, [
    JSON.stringify({
      type: "job_created",
      project,
      jobId,
      task,
      ts: "2026-05-19T00:00:00.000Z",
    }),
    JSON.stringify({
      type: "job_failed",
      project,
      jobId,
      reason: eventMarker,
      code: "FATAL",
      phase: "verify",
      ts: "2026-05-19T00:01:00.000Z",
    }),
  ].join("\n") + "\n", "utf8");
  await writeFile(path.join(hubRoot, "queue", "queue.json"), JSON.stringify({
    version: 1,
    entries: [{
      id: originQueueEntryId,
      projectId: project,
      sourcePath,
      sessionId: null,
      workerId: null,
      cwd: sourcePath,
      executionBoundary: "worktree",
      type: "pipeline",
      status: "failed",
      priority: "P0",
      description: task,
      metadata: {},
      claimedBy: null,
      claimedAt: null,
      createdAt: "2026-05-19T00:00:00.000Z",
      updatedAt: "2026-05-19T00:01:00.000Z",
    }],
  }, null, 2) + "\n", "utf8");
  await writeRepairStub(stubPath);

  return {
    root,
    cpbRoot,
    hubRoot,
    sourcePath,
    stateDir,
    stubPath,
    project,
    jobId,
    originQueueEntryId,
    task,
    wikiDir,
    eventFile,
    eventMarker,
    promptPath: path.join(stateDir, "prompt.txt"),
    agentPath: path.join(stateDir, "agent.txt"),
    cwdPath: path.join(stateDir, "cwd.txt"),
  };
}

test("cpb repair records audit events and creates a new lineage queue task", async () => {
  const fixture = await setupRepairFixture();
  try {
    const { stdout } = await execFileAsync("./cpb", ["repair", fixture.project, fixture.jobId], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CPB_ROOT: fixture.cpbRoot,
        CPB_EXECUTOR_ROOT: repoRoot,
        CPB_HUB_ROOT: fixture.hubRoot,
        CPB_ACP_CLIENT: fixture.stubPath,
        CPB_TEST_PROMPT: fixture.promptPath,
        CPB_TEST_AGENT: fixture.agentPath,
        CPB_TEST_CWD: fixture.cwdPath,
      },
    });

    assert.match(stdout, /Repair: .*repair-001\.md/);
    assert.match(stdout, /New task:/);

    const prompt = await readFile(fixture.promptPath, "utf8");
    assert.equal((await readFile(fixture.agentPath, "utf8")).trim(), "claude");
    assert.equal((await readFile(fixture.cwdPath, "utf8")).trim(), repoRoot);
    assert.ok(prompt.includes(`Job event log: ${fixture.eventFile}`));
    assert.ok(prompt.includes(`Target project root: ${fixture.sourcePath}`));
    assert.ok(!prompt.includes(fixture.eventMarker));

    const job = materializeJob(await readEvents(fixture.cpbRoot, fixture.project, fixture.jobId));
    assert.equal(job.status, "failed");
    assert.equal(job.externalRepairStatus, "FIXED");
    assert.equal(job.externalRepairArtifact, "repair-001");

    const queue = JSON.parse(await readFile(path.join(fixture.hubRoot, "queue", "queue.json"), "utf8"));
    assert.equal(queue.entries.length, 2);
    const followup = queue.entries.find((entry) => entry.id !== fixture.originQueueEntryId);
    assert.ok(followup);
    assert.equal(followup.status, "pending");
    assert.equal(followup.projectId, fixture.project);
    assert.equal(followup.description, fixture.task);
    assert.equal(followup.metadata.originJobId, fixture.jobId);
    assert.equal(followup.metadata.originQueueEntryId, fixture.originQueueEntryId);
    assert.equal(followup.metadata.repairArtifact, "repair-001");
    assert.equal(followup.metadata.repairStatus, "FIXED");
    assert.equal(followup.metadata.lineageReason, "external_repair_fixed_cpb_self_bug");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
