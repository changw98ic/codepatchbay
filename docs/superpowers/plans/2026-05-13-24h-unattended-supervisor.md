# 24h Unattended Supervisor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CodePatchbay capable of running long tasks for 24+ hours unattended by replacing fragile one-shot process state with durable jobs, event logs, leases, resumable phases, and worktree isolation.

**Architecture:** Keep the current ACP bridge scripts compatible, but introduce a durable supervisor layer above them. Jobs become append-only event streams materialized into JSON state; phases acquire renewable leases; code-writing phases run in task git worktrees; supervisor restart can resume from the latest completed checkpoint.

**Tech Stack:** Node.js ESM, Bash bridge compatibility, git worktree, JSONL event logs, Fastify routes, existing ACP client, existing wiki/state directories. No new npm dependencies.

---

## Success Criteria

- A job can survive terminal closure, server restart, and child process exit because its state is reconstructed from `.omc/events/{project}/{jobId}.jsonl`.
- A long-running ACP phase is not considered timed out while stdout, stderr, JSON-RPC activity, or lease heartbeats continue.
- Code-writing jobs run in `.omc/worktrees/{project}/{jobId}-{slug}/` by default.
- Non-git projects are initialized with git and receive a protected local baseline commit before worktree creation.
- Stale leases are recoverable without manual file deletion.
- The UI and CLI can show durable jobs, not only in-memory running processes.
- Budgets and blocked states prevent infinite unattended loops.
- Current commands `cpb plan`, `cpb execute`, `cpb verify`, and `cpb pipeline` remain usable during migration.

## File Structure

Create these focused modules:

- `server/services/event-store.js`: append JSONL events, read event streams, materialize current job state.
- `server/services/lease-manager.js`: acquire, renew, read, and release lease files under `.omc/leases/`.
- `server/services/job-store.js`: create jobs, append phase events, expose durable job summaries.
- `server/services/supervisor.js`: recover active jobs, run next phase, mark stale/blocked/completed.
- `server/services/provider-semaphore.js`: file-backed provider concurrency limits.
- `bridges/worktree-manager.mjs`: git repo bootstrap, protected baseline commit, worktree create/merge/cleanup.
- `bridges/job-runner.mjs`: Node phase runner that calls existing prompt builders and ACP bridge scripts.
- `tests/event-store.test.mjs`: event log and state materialization tests.
- `tests/lease-manager.test.mjs`: lease acquisition, renewal, stale recovery tests.
- `tests/worktree-manager.test.mjs`: non-git bootstrap and task worktree tests.
- `tests/job-store.test.mjs`: durable job lifecycle tests.
- `tests/supervisor.test.mjs`: resume and stale phase tests with fake runners.
- `wiki/system/unattended-supervisor.md`: operator-facing design and recovery guide.
- Modify `server/services/executor.js`: replace in-memory-only tracking with durable job-store integration.
- Modify `server/routes/tasks.js`: create durable jobs instead of raw detached bridge process records for pipeline runs.
- Modify `server/services/watcher.js`: watch event/state files for durable job updates.
- Modify `cpb`: add `jobs` and `supervisor` commands while keeping existing commands.
- Modify `README.md`: document 24h unattended mode.

## Data Model

Events are newline-delimited JSON:

```json
{"type":"job_created","jobId":"job-20260513-000001","project":"demo","task":"Add login","ts":"2026-05-13T00:00:00.000Z"}
{"type":"phase_started","jobId":"job-20260513-000001","phase":"plan","leaseId":"lease-job-20260513-000001-plan","ts":"2026-05-13T00:01:00.000Z"}
{"type":"phase_completed","jobId":"job-20260513-000001","phase":"plan","artifact":"wiki/projects/demo/inbox/plan-001.md","ts":"2026-05-13T00:03:00.000Z"}
```

Materialized state shape:

```json
{
  "jobId": "job-20260513-000001",
  "project": "demo",
  "task": "Add login",
  "status": "running",
  "phase": "execute",
  "attempt": 1,
  "workflow": "standard",
  "artifacts": {
    "plan": "wiki/projects/demo/inbox/plan-001.md"
  },
  "worktree": ".omc/worktrees/demo/job-20260513-000001-add-login",
  "createdAt": "2026-05-13T00:00:00.000Z",
  "updatedAt": "2026-05-13T00:05:00.000Z",
  "blockedReason": ""
}
```

Lease shape:

```json
{
  "leaseId": "lease-job-20260513-000001-execute",
  "jobId": "job-20260513-000001",
  "phase": "execute",
  "ownerPid": 12345,
  "ownerHost": "local",
  "acquiredAt": "2026-05-13T00:05:00.000Z",
  "heartbeatAt": "2026-05-13T00:06:00.000Z",
  "expiresAt": "2026-05-13T00:08:00.000Z"
}
```

## Task 1: Durable Event Store

**Files:**
- Create: `server/services/event-store.js`
- Create: `tests/event-store.test.mjs`

- [ ] **Step 1: Write failing tests for append/read/materialize**

Create `tests/event-store.test.mjs`:

```js
#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendEvent,
  readEvents,
  materializeJob,
  eventFileFor,
} from "../server/services/event-store.js";

const root = await mkdtemp(path.join(tmpdir(), "cpb-event-store-"));
const project = "demo";
const jobId = "job-20260513-000001";

await appendEvent(root, project, jobId, {
  type: "job_created",
  jobId,
  project,
  task: "Add login",
  ts: "2026-05-13T00:00:00.000Z",
});
await appendEvent(root, project, jobId, {
  type: "phase_started",
  jobId,
  phase: "plan",
  ts: "2026-05-13T00:01:00.000Z",
});
await appendEvent(root, project, jobId, {
  type: "phase_completed",
  jobId,
  phase: "plan",
  artifact: "wiki/projects/demo/inbox/plan-001.md",
  ts: "2026-05-13T00:02:00.000Z",
});

const file = eventFileFor(root, project, jobId);
const raw = await readFile(file, "utf8");
assert.equal(raw.trim().split("\n").length, 3);

const events = await readEvents(root, project, jobId);
assert.equal(events.length, 3);
assert.equal(events[0].type, "job_created");

const state = materializeJob(events);
assert.equal(state.jobId, jobId);
assert.equal(state.project, project);
assert.equal(state.task, "Add login");
assert.equal(state.status, "running");
assert.equal(state.phase, "plan");
assert.equal(state.artifacts.plan, "wiki/projects/demo/inbox/plan-001.md");
assert.equal(state.updatedAt, "2026-05-13T00:02:00.000Z");
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node tests/event-store.test.mjs
```

Expected: failure because `server/services/event-store.js` does not exist.

- [ ] **Step 3: Implement event-store**

Create `server/services/event-store.js`:

```js
import fs from "fs/promises";
import path from "path";

export function eventFileFor(cpbRoot, project, jobId) {
  return path.join(cpbRoot, ".omc", "events", project, `${jobId}.jsonl`);
}

export async function appendEvent(cpbRoot, project, jobId, event) {
  const file = eventFileFor(cpbRoot, project, jobId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const line = `${JSON.stringify(event)}\n`;
  await fs.appendFile(file, line, "utf8");
  return event;
}

export async function readEvents(cpbRoot, project, jobId) {
  const file = eventFileFor(cpbRoot, project, jobId);
  try {
    const raw = await fs.readFile(file, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

export function materializeJob(events) {
  const state = {
    jobId: "",
    project: "",
    task: "",
    status: "unknown",
    phase: "",
    attempt: 0,
    workflow: "",
    artifacts: {},
    worktree: "",
    createdAt: "",
    updatedAt: "",
    blockedReason: "",
  };

  for (const event of events) {
    state.updatedAt = event.ts || state.updatedAt;

    if (event.type === "job_created") {
      state.jobId = event.jobId;
      state.project = event.project;
      state.task = event.task;
      state.workflow = event.workflow || "";
      state.status = "queued";
      state.createdAt = event.ts || state.createdAt;
    }

    if (event.type === "worktree_created") {
      state.worktree = event.path;
    }

    if (event.type === "phase_started") {
      state.status = "running";
      state.phase = event.phase;
      state.attempt = Number(event.attempt || state.attempt || 1);
    }

    if (event.type === "phase_completed") {
      state.status = "running";
      state.phase = event.phase;
      if (event.artifact) state.artifacts[event.phase] = event.artifact;
    }

    if (event.type === "job_blocked") {
      state.status = "blocked";
      state.blockedReason = event.reason || "";
    }

    if (event.type === "job_failed") {
      state.status = "failed";
      state.blockedReason = event.reason || "";
    }

    if (event.type === "job_completed") {
      state.status = "completed";
      state.phase = "completed";
    }
  }

  return state;
}
```

- [ ] **Step 4: Run test to verify pass**

Run:

```bash
node tests/event-store.test.mjs
```

Expected: exit code 0.

- [ ] **Step 5: Commit**

```bash
git add server/services/event-store.js tests/event-store.test.mjs
git commit -m "Add durable event log for CodePatchbay jobs"
```

## Task 2: Lease Manager With Stale Recovery

**Files:**
- Create: `server/services/lease-manager.js`
- Create: `tests/lease-manager.test.mjs`

- [ ] **Step 1: Write failing lease tests**

Create `tests/lease-manager.test.mjs`:

```js
#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  acquireLease,
  readLease,
  renewLease,
  releaseLease,
  isLeaseStale,
} from "../server/services/lease-manager.js";

const root = await mkdtemp(path.join(tmpdir(), "cpb-lease-"));
const now = new Date("2026-05-13T00:00:00.000Z");

const lease = await acquireLease(root, {
  leaseId: "lease-job-1-plan",
  jobId: "job-1",
  phase: "plan",
  ttlMs: 60_000,
  now,
  ownerPid: 123,
});

assert.equal(lease.jobId, "job-1");
assert.equal(lease.phase, "plan");
assert.equal(lease.expiresAt, "2026-05-13T00:01:00.000Z");

const read = await readLease(root, "lease-job-1-plan");
assert.equal(read.ownerPid, 123);
assert.equal(isLeaseStale(read, new Date("2026-05-13T00:00:30.000Z")), false);
assert.equal(isLeaseStale(read, new Date("2026-05-13T00:01:01.000Z")), true);

const renewed = await renewLease(root, "lease-job-1-plan", {
  now: new Date("2026-05-13T00:00:45.000Z"),
  ttlMs: 60_000,
});
assert.equal(renewed.expiresAt, "2026-05-13T00:01:45.000Z");

await releaseLease(root, "lease-job-1-plan");
const afterRelease = await readLease(root, "lease-job-1-plan");
assert.equal(afterRelease, null);
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node tests/lease-manager.test.mjs
```

Expected: failure because `server/services/lease-manager.js` does not exist.

- [ ] **Step 3: Implement lease-manager**

Create `server/services/lease-manager.js`:

```js
import fs from "fs/promises";
import path from "path";
import os from "os";

function leaseFile(cpbRoot, leaseId) {
  return path.join(cpbRoot, ".omc", "leases", `${leaseId}.json`);
}

function iso(date) {
  return date.toISOString();
}

export async function acquireLease(cpbRoot, { leaseId, jobId, phase, ttlMs, now = new Date(), ownerPid = process.pid }) {
  const file = leaseFile(cpbRoot, leaseId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lease = {
    leaseId,
    jobId,
    phase,
    ownerPid,
    ownerHost: os.hostname(),
    acquiredAt: iso(now),
    heartbeatAt: iso(now),
    expiresAt: iso(new Date(now.getTime() + ttlMs)),
  };
  await fs.writeFile(file, JSON.stringify(lease, null, 2), { flag: "wx" });
  return lease;
}

export async function readLease(cpbRoot, leaseId) {
  try {
    const raw = await fs.readFile(leaseFile(cpbRoot, leaseId), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export function isLeaseStale(lease, now = new Date()) {
  return new Date(lease.expiresAt).getTime() < now.getTime();
}

export async function renewLease(cpbRoot, leaseId, { ttlMs, now = new Date() }) {
  const lease = await readLease(cpbRoot, leaseId);
  if (!lease) throw new Error(`Lease not found: ${leaseId}`);
  lease.heartbeatAt = iso(now);
  lease.expiresAt = iso(new Date(now.getTime() + ttlMs));
  await fs.writeFile(leaseFile(cpbRoot, leaseId), JSON.stringify(lease, null, 2));
  return lease;
}

export async function releaseLease(cpbRoot, leaseId) {
  try {
    await fs.unlink(leaseFile(cpbRoot, leaseId));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}
```

- [ ] **Step 4: Run lease test**

Run:

```bash
node tests/lease-manager.test.mjs
```

Expected: exit code 0.

- [ ] **Step 5: Commit**

```bash
git add server/services/lease-manager.js tests/lease-manager.test.mjs
git commit -m "Add renewable leases for unattended jobs"
```

## Task 3: Durable Job Store

**Files:**
- Create: `server/services/job-store.js`
- Create: `tests/job-store.test.mjs`
- Modify: `server/services/event-store.js`

- [ ] **Step 1: Write failing job lifecycle test**

Create `tests/job-store.test.mjs`:

```js
#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createJob,
  startPhase,
  completePhase,
  blockJob,
  completeJob,
  getJob,
  listJobs,
} from "../server/services/job-store.js";

const root = await mkdtemp(path.join(tmpdir(), "cpb-job-store-"));

const job = await createJob(root, {
  project: "demo",
  task: "Add login",
  workflow: "standard",
  ts: "2026-05-13T00:00:00.000Z",
});

assert.match(job.jobId, /^job-\d{8}-\d{6}-[a-z0-9]+$/);

await startPhase(root, job.project, job.jobId, {
  phase: "plan",
  attempt: 1,
  leaseId: "lease-plan",
  ts: "2026-05-13T00:01:00.000Z",
});
await completePhase(root, job.project, job.jobId, {
  phase: "plan",
  artifact: "wiki/projects/demo/inbox/plan-001.md",
  ts: "2026-05-13T00:02:00.000Z",
});

const state = await getJob(root, "demo", job.jobId);
assert.equal(state.status, "running");
assert.equal(state.phase, "plan");
assert.equal(state.artifacts.plan, "wiki/projects/demo/inbox/plan-001.md");

await blockJob(root, "demo", job.jobId, {
  reason: "missing credential OLLAMACLOUD_API_KEY",
  ts: "2026-05-13T00:03:00.000Z",
});
assert.equal((await getJob(root, "demo", job.jobId)).status, "blocked");

await completeJob(root, "demo", job.jobId, {
  ts: "2026-05-13T00:04:00.000Z",
});
assert.equal((await getJob(root, "demo", job.jobId)).status, "completed");

const jobs = await listJobs(root);
assert.equal(jobs.length, 1);
assert.equal(jobs[0].project, "demo");
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node tests/job-store.test.mjs
```

Expected: failure because `server/services/job-store.js` does not exist.

- [ ] **Step 3: Add `listEventFiles` to event-store**

Modify `server/services/event-store.js`:

```js
export async function listEventFiles(cpbRoot) {
  const eventsRoot = path.join(cpbRoot, ".omc", "events");
  try {
    const projects = await fs.readdir(eventsRoot, { withFileTypes: true });
    const files = [];
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const dir = path.join(eventsRoot, project.name);
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          files.push({
            project: project.name,
            jobId: entry.name.replace(/\.jsonl$/, ""),
            file: path.join(dir, entry.name),
          });
        }
      }
    }
    return files;
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}
```

- [ ] **Step 4: Implement job-store**

Create `server/services/job-store.js`:

```js
import crypto from "crypto";
import { appendEvent, listEventFiles, materializeJob, readEvents } from "./event-store.js";

function compactStamp(ts) {
  return ts.replace(/[-:TZ.]/g, "").slice(0, 14);
}

export function makeJobId(ts = new Date().toISOString(), suffix = crypto.randomBytes(3).toString("hex")) {
  return `job-${compactStamp(ts)}-${suffix}`;
}

export async function createJob(cpbRoot, { project, task, workflow = "standard", ts = new Date().toISOString() }) {
  const jobId = makeJobId(ts);
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_created",
    jobId,
    project,
    task,
    workflow,
    ts,
  });
  return { jobId, project, task, workflow };
}

export async function startPhase(cpbRoot, project, jobId, { phase, attempt = 1, leaseId, ts = new Date().toISOString() }) {
  return appendEvent(cpbRoot, project, jobId, {
    type: "phase_started",
    jobId,
    phase,
    attempt,
    leaseId,
    ts,
  });
}

export async function completePhase(cpbRoot, project, jobId, { phase, artifact = "", ts = new Date().toISOString() }) {
  return appendEvent(cpbRoot, project, jobId, {
    type: "phase_completed",
    jobId,
    phase,
    artifact,
    ts,
  });
}

export async function blockJob(cpbRoot, project, jobId, { reason, ts = new Date().toISOString() }) {
  return appendEvent(cpbRoot, project, jobId, {
    type: "job_blocked",
    jobId,
    reason,
    ts,
  });
}

export async function failJob(cpbRoot, project, jobId, { reason, ts = new Date().toISOString() }) {
  return appendEvent(cpbRoot, project, jobId, {
    type: "job_failed",
    jobId,
    reason,
    ts,
  });
}

export async function completeJob(cpbRoot, project, jobId, { ts = new Date().toISOString() } = {}) {
  return appendEvent(cpbRoot, project, jobId, {
    type: "job_completed",
    jobId,
    ts,
  });
}

export async function getJob(cpbRoot, project, jobId) {
  const events = await readEvents(cpbRoot, project, jobId);
  return materializeJob(events);
}

export async function listJobs(cpbRoot) {
  const files = await listEventFiles(cpbRoot);
  const jobs = [];
  for (const file of files) {
    jobs.push(await getJob(cpbRoot, file.project, file.jobId));
  }
  return jobs.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}
```

- [ ] **Step 5: Run job and event tests**

Run:

```bash
node tests/event-store.test.mjs
node tests/job-store.test.mjs
```

Expected: both exit code 0.

- [ ] **Step 6: Commit**

```bash
git add server/services/event-store.js server/services/job-store.js tests/job-store.test.mjs
git commit -m "Materialize durable CodePatchbay job state"
```

## Task 4: Worktree Manager

**Files:**
- Create: `bridges/worktree-manager.mjs`
- Create: `tests/worktree-manager.test.mjs`

- [ ] **Step 1: Write failing worktree bootstrap test**

Create `tests/worktree-manager.test.mjs`:

```js
#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnFile } from "./helpers/spawn-file.mjs";

const root = await mkdtemp(path.join(tmpdir(), "cpb-worktree-root-"));
const project = await mkdtemp(path.join(tmpdir(), "cpb-project-"));
await writeFile(path.join(project, "README.md"), "# Demo\n");
await writeFile(path.join(project, ".env"), "SECRET=do-not-stage\n");

const manager = path.resolve("bridges/worktree-manager.mjs");

const bootstrap = await spawnFile(process.execPath, [manager, "bootstrap", "--project", project], { cwd: path.resolve(".") });
assert.equal(bootstrap.code, 0, bootstrap.stderr);

const gitHead = await spawnFile("git", ["-C", project, "rev-parse", "--verify", "HEAD"], { cwd: path.resolve(".") });
assert.equal(gitHead.code, 0, gitHead.stderr);

const ignored = await spawnFile("git", ["-C", project, "check-ignore", ".env"], { cwd: path.resolve(".") });
assert.equal(ignored.code, 0, ".env should be ignored after bootstrap");

const worktreePath = path.join(root, "job-1-demo");
const create = await spawnFile(process.execPath, [
  manager,
  "create",
  "--project",
  project,
  "--job-id",
  "job-1",
  "--slug",
  "demo",
  "--worktrees-root",
  root,
], { cwd: path.resolve(".") });
assert.equal(create.code, 0, create.stderr);

const packageReadme = await readFile(path.join(worktreePath, "README.md"), "utf8");
assert.match(packageReadme, /Demo/);
```

Create `tests/helpers/spawn-file.mjs`:

```js
import { spawn } from "node:child_process";

export function spawnFile(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node tests/worktree-manager.test.mjs
```

Expected: failure because `bridges/worktree-manager.mjs` does not exist.

- [ ] **Step 3: Implement worktree-manager**

Create `bridges/worktree-manager.mjs` with these commands:

```js
#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const command = args[0];

function arg(name, fallback = "") {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : fallback;
}

function run(cmd, argv, opts = {}) {
  const result = spawnSync(cmd, argv, { encoding: "utf8", ...opts });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${argv.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function hasCommit(project) {
  const result = spawnSync("git", ["-C", project, "rev-parse", "--verify", "HEAD"], { encoding: "utf8" });
  return result.status === 0;
}

function isGitRepo(project) {
  const result = spawnSync("git", ["-C", project, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() === "true";
}

async function ensureIgnore(project) {
  const ignorePath = path.join(project, ".gitignore");
  const required = [".env", ".env.*", "node_modules/", "dist/", "build/", "coverage/", ".omc/state/", ".omc/worktrees/", ".omx/state/"];
  let current = "";
  try {
    current = await fsp.readFile(ignorePath, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const missing = required.filter((line) => !current.split(/\r?\n/).includes(line));
  if (missing.length) {
    await fsp.appendFile(ignorePath, `${current.endsWith("\n") || current === "" ? "" : "\n"}${missing.join("\n")}\n`);
  }
}

async function bootstrap(project) {
  if (!fs.existsSync(project)) throw new Error(`Project path does not exist: ${project}`);
  if (!isGitRepo(project)) run("git", ["-C", project, "init"]);
  await ensureIgnore(project);
  if (!hasCommit(project)) {
    run("git", ["-C", project, "add", "--", "."]);
    run("git", ["-C", project, "commit", "-m", "Initialize CodePatchbay baseline"]);
  }
}

async function createWorktree({ project, jobId, slug, worktreesRoot }) {
  await bootstrap(project);
  const branch = `cpb/${jobId}-${slug}`;
  const worktreePath = path.join(worktreesRoot, `${jobId}-${slug}`);
  await fsp.mkdir(worktreesRoot, { recursive: true });
  run("git", ["-C", project, "branch", branch]);
  run("git", ["-C", project, "worktree", "add", worktreePath, branch]);
  console.log(JSON.stringify({ branch, path: worktreePath }));
}

try {
  if (command === "bootstrap") {
    await bootstrap(path.resolve(arg("--project")));
  } else if (command === "create") {
    await createWorktree({
      project: path.resolve(arg("--project")),
      jobId: arg("--job-id"),
      slug: arg("--slug", "task"),
      worktreesRoot: path.resolve(arg("--worktrees-root")),
    });
  } else {
    throw new Error("Usage: worktree-manager.mjs bootstrap|create");
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
```

- [ ] **Step 4: Run worktree test**

Run:

```bash
node tests/worktree-manager.test.mjs
```

Expected: exit code 0.

- [ ] **Step 5: Commit**

```bash
git add bridges/worktree-manager.mjs tests/worktree-manager.test.mjs tests/helpers/spawn-file.mjs
git commit -m "Add worktree isolation manager"
```

## Task 5: Supervisor Core and Resume Logic

**Files:**
- Create: `server/services/supervisor.js`
- Create: `tests/supervisor.test.mjs`
- Modify: `server/services/job-store.js`

- [ ] **Step 1: Write failing supervisor resume test**

Create `tests/supervisor.test.mjs`:

```js
#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJob, getJob, startPhase } from "../server/services/job-store.js";
import { recoverJobs, nextPhaseFor } from "../server/services/supervisor.js";

const root = await mkdtemp(path.join(tmpdir(), "cpb-supervisor-"));

const job = await createJob(root, {
  project: "demo",
  task: "Add login",
  workflow: "standard",
  ts: "2026-05-13T00:00:00.000Z",
});

assert.equal(nextPhaseFor({ status: "queued", artifacts: {} }), "plan");
assert.equal(nextPhaseFor({ status: "running", artifacts: { plan: "plan.md" } }), "execute");
assert.equal(nextPhaseFor({ status: "running", artifacts: { plan: "plan.md", execute: "deliverable.md" } }), "verify");
assert.equal(nextPhaseFor({ status: "completed", artifacts: {} }), "");

await startPhase(root, "demo", job.jobId, {
  phase: "plan",
  attempt: 1,
  leaseId: "missing-stale-lease",
  ts: "2026-05-13T00:01:00.000Z",
});

const recovered = await recoverJobs(root, { now: new Date("2026-05-13T01:00:00.000Z") });
assert.equal(recovered.length, 1);
assert.equal(recovered[0].jobId, job.jobId);

const state = await getJob(root, "demo", job.jobId);
assert.equal(state.status, "running");
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node tests/supervisor.test.mjs
```

Expected: failure because `server/services/supervisor.js` does not exist.

- [ ] **Step 3: Implement supervisor skeleton**

Create `server/services/supervisor.js`:

```js
import { listJobs } from "./job-store.js";

export function nextPhaseFor(state) {
  if (!state || ["completed", "failed", "blocked"].includes(state.status)) return "";
  if (!state.artifacts?.plan) return "plan";
  if (!state.artifacts?.execute) return "execute";
  if (!state.artifacts?.verify) return "verify";
  return "complete";
}

export async function recoverJobs(cpbRoot) {
  const jobs = await listJobs(cpbRoot);
  return jobs.filter((job) => {
    if (["completed", "failed", "blocked"].includes(job.status)) return false;
    return nextPhaseFor(job) !== "";
  });
}
```

- [ ] **Step 4: Run supervisor and job tests**

Run:

```bash
node tests/job-store.test.mjs
node tests/supervisor.test.mjs
```

Expected: both exit code 0.

- [ ] **Step 5: Commit**

```bash
git add server/services/supervisor.js tests/supervisor.test.mjs
git commit -m "Add resumable supervisor phase selection"
```

## Task 6: Job Runner for Existing Bridge Phases

**Files:**
- Create: `bridges/job-runner.mjs`
- Create: `tests/job-runner.test.mjs`
- Modify: `bridges/common.sh`

- [ ] **Step 1: Write fake runner test**

Create `tests/job-runner.test.mjs`:

```js
#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnFile } from "./helpers/spawn-file.mjs";

const root = await mkdtemp(path.join(tmpdir(), "cpb-job-runner-"));
const runner = path.resolve("bridges/job-runner.mjs");

const result = await spawnFile(process.execPath, [
  runner,
  "--cpb-root",
  root,
  "--project",
  "demo",
  "--job-id",
  "job-1",
  "--phase",
  "plan",
  "--script",
  "node",
  "--",
  "-e",
  "console.log('fake plan complete')",
], { cwd: path.resolve(".") });

assert.equal(result.code, 0, result.stderr);
assert.match(result.stdout, /fake plan complete/);

const eventFile = path.join(root, ".omc/events/demo/job-1.jsonl");
const raw = await readFile(eventFile, "utf8");
assert.match(raw, /phase_started/);
assert.match(raw, /phase_completed/);
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node tests/job-runner.test.mjs
```

Expected: failure because `bridges/job-runner.mjs` does not exist.

- [ ] **Step 3: Implement job-runner**

Create `bridges/job-runner.mjs`:

```js
#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { appendEvent } from "../server/services/event-store.js";
import { acquireLease, releaseLease, renewLease } from "../server/services/lease-manager.js";

const args = process.argv.slice(2);

function arg(name, fallback = "") {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : fallback;
}

const separator = args.indexOf("--");
const scriptArgs = separator >= 0 ? args.slice(separator + 1) : [];
const cpbRoot = path.resolve(arg("--cpb-root", process.cwd()));
const project = arg("--project");
const jobId = arg("--job-id");
const phase = arg("--phase");
const script = arg("--script");
const leaseId = `lease-${jobId}-${phase}`;
const ttlMs = Number(process.env.CPB_LEASE_TTL_MS || 120_000);

await acquireLease(cpbRoot, { leaseId, jobId, phase, ttlMs });
await appendEvent(cpbRoot, project, jobId, {
  type: "phase_started",
  jobId,
  phase,
  leaseId,
  ts: new Date().toISOString(),
});

const heartbeat = setInterval(() => {
  renewLease(cpbRoot, leaseId, { ttlMs }).catch(() => {});
}, Math.max(5_000, Math.floor(ttlMs / 3)));

const child = spawn(script, scriptArgs, {
  cwd: cpbRoot,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => process.stdout.write(chunk));
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

const code = await new Promise((resolve) => child.on("close", resolve));
clearInterval(heartbeat);
await releaseLease(cpbRoot, leaseId);

await appendEvent(cpbRoot, project, jobId, {
  type: code === 0 ? "phase_completed" : "phase_failed",
  jobId,
  phase,
  exitCode: code,
  ts: new Date().toISOString(),
});

process.exit(code);
```

- [ ] **Step 4: Run runner test**

Run:

```bash
node tests/job-runner.test.mjs
```

Expected: exit code 0.

- [ ] **Step 5: Commit**

```bash
git add bridges/job-runner.mjs tests/job-runner.test.mjs
git commit -m "Wrap bridge phases with durable job runner"
```

## Task 7: Durable Server Task Routes

**Files:**
- Modify: `server/services/executor.js`
- Modify: `server/routes/tasks.js`
- Create: `tests/executor.test.mjs`

- [ ] **Step 1: Write executor durable tracking test**

Create `tests/executor.test.mjs`:

```js
#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerTask, unregisterTask, getRunningTasks, getDurableTasks } from "../server/services/executor.js";
import { createJob } from "../server/services/job-store.js";

const root = await mkdtemp(path.join(tmpdir(), "cpb-executor-"));
const job = await createJob(root, {
  project: "demo",
  task: "Add login",
  workflow: "standard",
  ts: "2026-05-13T00:00:00.000Z",
});

registerTask(job.jobId, "demo", "job-runner.mjs", 12345);
assert.equal(getRunningTasks().length, 1);
unregisterTask(job.jobId);
assert.equal(getRunningTasks().length, 0);

const durable = await getDurableTasks(root);
assert.equal(durable.length, 1);
assert.equal(durable[0].jobId, job.jobId);
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node tests/executor.test.mjs
```

Expected: failure because `getDurableTasks` is not exported.

- [ ] **Step 3: Add durable task listing**

Modify `server/services/executor.js`:

```js
import { listJobs } from "./job-store.js";

const runningTasks = new Map();

export function registerTask(taskId, project, script, pid) {
  runningTasks.set(taskId, { project, script, pid, started: Date.now() });
}

export function unregisterTask(taskId) {
  runningTasks.delete(taskId);
}

export function getRunningTasks() {
  return Array.from(runningTasks.entries()).map(([id, task]) => ({
    id,
    ...task,
    duration: Date.now() - task.started,
  }));
}

export async function getDurableTasks(cpbRoot) {
  return listJobs(cpbRoot);
}
```

- [ ] **Step 4: Update task routes to create durable pipeline jobs**

Modify the pipeline route in `server/routes/tasks.js` so it creates a durable job first:

```js
import { createJob } from "../services/job-store.js";
```

Then replace the pipeline route body with:

```js
fastify.post(`${prefix}/tasks/:name/pipeline`, async (req) => {
  const { name } = req.params;
  const { task, maxRetries = "3", timeout = "0" } = req.body || {};
  if (!task) throw fastify.httpErrors.badRequest("task required");

  const job = await createJob(req.cpbRoot, {
    project: name,
    task,
    workflow: "standard",
  });

  return spawnBridge(req.cpbRoot, name, "run-pipeline.sh", [name, task, maxRetries, timeout], req.log, job.jobId);
});
```

Change `spawnBridge` signature:

```js
function spawnBridge(cpbRoot, project, script, args, log, providedTaskId = "") {
  const scriptPath = path.join(cpbRoot, "bridges", script);
  const taskId = providedTaskId || `${project}:${script}:${Date.now()}`;
```

- [ ] **Step 5: Run executor test**

Run:

```bash
node tests/executor.test.mjs
```

Expected: exit code 0.

- [ ] **Step 6: Commit**

```bash
git add server/services/executor.js server/routes/tasks.js tests/executor.test.mjs
git commit -m "Expose durable jobs through task executor"
```

## Task 8: CLI Job and Supervisor Commands

**Files:**
- Modify: `cpb`
- Create: `bridges/list-jobs.mjs`
- Create: `bridges/supervisor-loop.mjs`
- Create: `tests/cpb-jobs.test.sh`

- [ ] **Step 1: Write failing CLI test**

Create `tests/cpb-jobs.test.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

CPB_ROOT="$TMP" mkdir -p "$TMP/.omc/events/demo"
cat > "$TMP/.omc/events/demo/job-20260513-000001-abc123.jsonl" <<'JSONL'
{"type":"job_created","jobId":"job-20260513-000001-abc123","project":"demo","task":"Add login","workflow":"standard","ts":"2026-05-13T00:00:00.000Z"}
JSONL

CPB_ROOT="$TMP" "$ROOT/bridges/list-jobs.mjs" | grep "job-20260513-000001-abc123"
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
chmod +x tests/cpb-jobs.test.sh
tests/cpb-jobs.test.sh
```

Expected: failure because `bridges/list-jobs.mjs` does not exist.

- [ ] **Step 3: Implement list-jobs command**

Create `bridges/list-jobs.mjs`:

```js
#!/usr/bin/env node
import path from "node:path";
import { listJobs } from "../server/services/job-store.js";

const cpbRoot = path.resolve(process.env.CPB_ROOT || path.join(import.meta.dirname, ".."));
const jobs = await listJobs(cpbRoot);

for (const job of jobs) {
  console.log(`${job.jobId}\t${job.project}\t${job.status}\t${job.phase || "-"}\t${job.task}`);
}
```

Create `bridges/supervisor-loop.mjs`:

```js
#!/usr/bin/env node
import path from "node:path";
import { recoverJobs } from "../server/services/supervisor.js";

const cpbRoot = path.resolve(process.env.CPB_ROOT || path.join(import.meta.dirname, ".."));
const intervalMs = Number(process.env.CPB_SUPERVISOR_INTERVAL_MS || 30_000);

async function tick() {
  const jobs = await recoverJobs(cpbRoot);
  for (const job of jobs) {
    console.log(`${new Date().toISOString()} recoverable ${job.jobId} ${job.project} ${job.phase || "-"}`);
  }
}

await tick();
setInterval(tick, intervalMs);
```

- [ ] **Step 4: Wire CLI commands**

Modify `cpb` usage:

```text
  jobs                                      列出 durable jobs
  supervisor                               启动无人值守 supervisor 循环
```

Add functions:

```bash
cmd_jobs() { CPB_ROOT="$CPB_ROOT" "$CPB_ROOT/bridges/list-jobs.mjs"; }
cmd_supervisor() { CPB_ROOT="$CPB_ROOT" "$CPB_ROOT/bridges/supervisor-loop.mjs"; }
```

Add cases:

```bash
  jobs)     cmd_jobs ;;
  supervisor) cmd_supervisor ;;
```

- [ ] **Step 5: Run CLI tests**

Run:

```bash
tests/cpb-jobs.test.sh
bash -n cpb bridges/*.sh tests/*.sh tests/fixtures/*.sh
```

Expected: both commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add cpb bridges/list-jobs.mjs bridges/supervisor-loop.mjs tests/cpb-jobs.test.sh
git commit -m "Add durable job CLI surfaces"
```

## Task 9: Provider Semaphore and Budget Limits

**Files:**
- Create: `server/services/provider-semaphore.js`
- Create: `tests/provider-semaphore.test.mjs`
- Modify: `server/services/job-store.js`

- [ ] **Step 1: Write provider semaphore test**

Create `tests/provider-semaphore.test.mjs`:

```js
#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireProviderSlot, releaseProviderSlot, listProviderSlots } from "../server/services/provider-semaphore.js";

const root = await mkdtemp(path.join(tmpdir(), "cpb-provider-"));

const first = await acquireProviderSlot(root, { provider: "ollamacloud", jobId: "job-1", limit: 1 });
assert.equal(first.acquired, true);

const second = await acquireProviderSlot(root, { provider: "ollamacloud", jobId: "job-2", limit: 1 });
assert.equal(second.acquired, false);

await releaseProviderSlot(root, { provider: "ollamacloud", jobId: "job-1" });
const third = await acquireProviderSlot(root, { provider: "ollamacloud", jobId: "job-2", limit: 1 });
assert.equal(third.acquired, true);

const slots = await listProviderSlots(root, "ollamacloud");
assert.equal(slots.length, 1);
assert.equal(slots[0].jobId, "job-2");
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node tests/provider-semaphore.test.mjs
```

Expected: failure because `server/services/provider-semaphore.js` does not exist.

- [ ] **Step 3: Implement provider semaphore**

Create `server/services/provider-semaphore.js`:

```js
import fs from "node:fs/promises";
import path from "node:path";

function providerDir(cpbRoot, provider) {
  return path.join(cpbRoot, ".omc", "provider-slots", provider);
}

export async function listProviderSlots(cpbRoot, provider) {
  const dir = providerDir(cpbRoot, provider);
  try {
    const files = await fs.readdir(dir);
    const slots = [];
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      slots.push(JSON.parse(await fs.readFile(path.join(dir, file), "utf8")));
    }
    return slots;
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

export async function acquireProviderSlot(cpbRoot, { provider, jobId, limit }) {
  const dir = providerDir(cpbRoot, provider);
  await fs.mkdir(dir, { recursive: true });
  const slots = await listProviderSlots(cpbRoot, provider);
  if (slots.length >= limit) return { acquired: false, provider, jobId };
  const slot = { provider, jobId, acquiredAt: new Date().toISOString() };
  await fs.writeFile(path.join(dir, `${jobId}.json`), JSON.stringify(slot, null, 2), { flag: "wx" });
  return { acquired: true, ...slot };
}

export async function releaseProviderSlot(cpbRoot, { provider, jobId }) {
  try {
    await fs.unlink(path.join(providerDir(cpbRoot, provider), `${jobId}.json`));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}
```

- [ ] **Step 4: Run semaphore test**

Run:

```bash
node tests/provider-semaphore.test.mjs
```

Expected: exit code 0.

- [ ] **Step 5: Add budget event helpers**

Modify `server/services/job-store.js`:

```js
export async function budgetExceeded(cpbRoot, project, jobId, { reason, ts = new Date().toISOString() }) {
  return appendEvent(cpbRoot, project, jobId, {
    type: "budget_exceeded",
    jobId,
    reason,
    ts,
  });
}
```

Update `materializeJob` in `server/services/event-store.js`:

```js
if (event.type === "budget_exceeded") {
  state.status = "blocked";
  state.blockedReason = event.reason || "budget exceeded";
}
```

- [ ] **Step 6: Run affected tests**

Run:

```bash
node tests/event-store.test.mjs
node tests/job-store.test.mjs
node tests/provider-semaphore.test.mjs
```

Expected: all exit code 0.

- [ ] **Step 7: Commit**

```bash
git add server/services/provider-semaphore.js server/services/job-store.js server/services/event-store.js tests/provider-semaphore.test.mjs
git commit -m "Add provider concurrency and budget events"
```

## Task 10: Watcher and UI Event Surface

**Files:**
- Modify: `server/services/watcher.js`
- Modify: `server/routes/tasks.js`
- Modify: `web/src/App.jsx`
- Modify: `web/src/app.css`

- [ ] **Step 1: Extend watcher to emit job updates**

Modify `server/services/watcher.js` to watch `.omc/events/*/*.jsonl`:

```js
const eventsWatcher = chokidar.watch(path.join(cpbRoot, ".omc/events/*/*.jsonl"), {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 200 },
});

eventsWatcher.on("all", async (_event, filePath) => {
  try {
    const rel = path.relative(path.join(cpbRoot, ".omc/events"), filePath);
    const [projectName, fileName] = rel.split(path.sep);
    const jobId = fileName.replace(/\.jsonl$/, "");
    broadcast({ type: "job:update", project: projectName, jobId });
  } catch (err) {
    console.error(`[watcher] job event error (${filePath}): ${err.message}`);
  }
});
```

Return it:

```js
return { stateWatcher, wikiWatcher, eventsWatcher };
```

Update shutdown in `server/index.js`:

```js
await watchers.eventsWatcher.close();
```

- [ ] **Step 2: Add durable job API route**

Modify `server/routes/tasks.js`:

```js
import { getDurableTasks } from "../services/executor.js";
```

Add route:

```js
fastify.get(`${prefix}/tasks/durable`, async (req) => {
  return getDurableTasks(req.cpbRoot);
});
```

- [ ] **Step 3: Update UI to fetch durable jobs**

Modify `web/src/App.jsx` by adding a fetch next to existing task/status loading:

```js
const [durableTasks, setDurableTasks] = useState([]);

async function refreshDurableTasks() {
  const res = await fetch("/api/tasks/durable");
  if (res.ok) setDurableTasks(await res.json());
}
```

Handle websocket event:

```js
if (event.type === "job:update") {
  refreshDurableTasks();
}
```

Render a compact list:

```jsx
<section className="panel">
  <h2>Durable Jobs</h2>
  {durableTasks.map((job) => (
    <div className="job-row" key={job.jobId}>
      <span>{job.jobId}</span>
      <span>{job.project}</span>
      <span>{job.status}</span>
      <span>{job.phase || "-"}</span>
    </div>
  ))}
</section>
```

- [ ] **Step 4: Build UI**

Run:

```bash
npm --prefix web run build
```

Expected: Vite build completes successfully.

- [ ] **Step 5: Commit**

```bash
git add server/index.js server/services/watcher.js server/routes/tasks.js web/src/App.jsx web/src/app.css
git commit -m "Surface durable jobs in CodePatchbay UI"
```

## Task 11: Operator Documentation

**Files:**
- Create: `wiki/system/unattended-supervisor.md`
- Modify: `README.md`
- Modify: `cpb`

- [ ] **Step 1: Add operator guide**

Create `wiki/system/unattended-supervisor.md`:

```markdown
# Unattended Supervisor

CodePatchbay unattended mode is designed for long-running work where the process may run for 24 hours or more.

## Guarantees

- Job state is reconstructed from `.omc/events/{project}/{jobId}.jsonl`.
- Active phases renew leases while they produce activity.
- Code-writing phases use task git worktrees.
- Stale jobs can be resumed from the last completed phase.

## Non-Guarantees

- CodePatchbay does not push to remotes without an explicit user request.
- CodePatchbay does not bypass blocked states for missing credentials, destructive actions, or merge conflicts.
- CodePatchbay does not silently auto-resolve merge conflicts.

## Commands

```bash
cpb jobs
cpb supervisor
cpb pipeline <project> "<task>" 3 0
```

## Recovery

1. Run `cpb jobs`.
2. Find jobs with `running`, `blocked`, or `failed` status.
3. Inspect `.omc/events/{project}/{jobId}.jsonl`.
4. Inspect `.omc/leases/` for stale leases.
5. Restart `cpb supervisor`.

## Safe Defaults

- Total timeout is disabled by default for supervisor-managed work.
- ACP idle timeout remains active.
- Budget limits block the job instead of deleting work.
- Worktrees are preserved on failure.
```

- [ ] **Step 2: Update README**

Add a section:

```markdown
## 24h 无人值守

CodePatchbay 的无人值守模式基于 durable job、event log、lease heartbeat、task worktree 和 supervisor resume。

```bash
cpb jobs
cpb supervisor
```

设计说明见 `wiki/system/unattended-supervisor.md`。
```

- [ ] **Step 3: Include doc in wiki lint**

Modify `cpb` wiki lint system-file loop to include:

```text
system/unattended-supervisor.md
```

- [ ] **Step 4: Run docs validation**

Run:

```bash
./cpb wiki lint
rg -n "T[B]D|TO[D]O|FIX[M]E" wiki/system/unattended-supervisor.md README.md
```

Expected: wiki lint passes, `rg` returns no matches.

- [ ] **Step 5: Commit**

```bash
git add wiki/system/unattended-supervisor.md README.md cpb
git commit -m "Document unattended supervisor operations"
```

## Task 12: End-to-End Verification

**Files:**
- Modify only files required to fix failures found by this task.

- [ ] **Step 1: Run all Node unit tests**

Run:

```bash
node tests/acp-client.test.mjs
node tests/event-store.test.mjs
node tests/lease-manager.test.mjs
node tests/job-store.test.mjs
node tests/worktree-manager.test.mjs
node tests/supervisor.test.mjs
node tests/job-runner.test.mjs
node tests/executor.test.mjs
node tests/provider-semaphore.test.mjs
```

Expected: all exit code 0.

- [ ] **Step 2: Run shell tests**

Run:

```bash
tests/cpb-bridges.test.sh
tests/cpb-jobs.test.sh
bash -n cpb bridges/*.sh tests/*.sh tests/fixtures/*.sh
```

Expected: all exit code 0.

- [ ] **Step 3: Run wiki lint**

Run:

```bash
./cpb wiki lint
```

Expected: `All checks passed.`

- [ ] **Step 4: Build web UI**

Run:

```bash
npm --prefix web run build
```

Expected: Vite build completes successfully.

- [ ] **Step 5: Manual 24h simulation with short timings**

Run with reduced intervals:

```bash
CPB_SUPERVISOR_INTERVAL_MS=1000 CPB_LEASE_TTL_MS=3000 cpb supervisor
```

In another shell, create a pipeline job:

```bash
cpb pipeline <project> "Small safe test task" 1 0
```

Expected:

- `cpb jobs` shows the job.
- `.omc/events/{project}/{jobId}.jsonl` receives phase events.
- lease files renew while the phase runs.
- killing and restarting `cpb supervisor` does not delete the job.

- [ ] **Step 6: Final commit**

```bash
git status --short
git add .
git commit -m "Enable durable unattended CodePatchbay supervision"
```

## Rollout Order

1. Merge event store and job store first because they are passive and low risk.
2. Add lease manager next because it is independent and testable.
3. Add worktree manager before supervisor starts writing code.
4. Add supervisor and job-runner in compatibility mode.
5. Route UI/server pipeline creation to durable jobs.
6. Add provider semaphore and budgets.
7. Document operator recovery.
8. Run full verification.

## Self-Review

- Spec coverage: The plan covers durable event logs, materialized state, leases, worktree isolation, non-git bootstrap, supervisor resume, provider concurrency, budgets, UI visibility, and operator recovery.
- Placeholder scan: The plan avoids deferred placeholders and gives concrete file paths, commands, and code skeletons for every implementation task.
- Type consistency: Event fields use `jobId`, `project`, `phase`, `ts`, `artifact`, and `reason` consistently across event store, job store, supervisor, and tests.
- Scope check: The plan is large but staged. Tasks 1-5 produce a testable durable core before server/UI integration begins.
