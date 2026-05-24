import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildArtifactIndex } from "./artifact-index.js";
import { eventFileFor } from "./event-store.js";
import {
  completeJob,
  completePhase,
  createJob,
  getJob,
  startPhase,
} from "./job-store.js";

const execFileAsync = promisify(execFile);

function nowSafe() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

async function bestEffortGitInit(sourcePath) {
  try {
    await execFileAsync("git", ["init", "-b", "main"], { cwd: sourcePath, timeout: 10_000 });
    await execFileAsync("git", ["config", "user.email", "demo@example.invalid"], { cwd: sourcePath, timeout: 10_000 });
    await execFileAsync("git", ["config", "user.name", "CodePatchBay Demo"], { cwd: sourcePath, timeout: 10_000 });
    await execFileAsync("git", ["add", "."], { cwd: sourcePath, timeout: 10_000 });
    await execFileAsync("git", ["commit", "-m", "demo toy repo"], { cwd: sourcePath, timeout: 10_000 });
  } catch {
    // The demo remains useful without git; artifacts and event logs are the core contract.
  }
}

async function writeToyRepo(sourcePath) {
  await mkdir(path.join(sourcePath, "src"), { recursive: true });
  await writeFile(
    path.join(sourcePath, "package.json"),
    `${JSON.stringify({
      name: "codepatchbay-demo-toy-repo",
      private: true,
      type: "module",
      scripts: { test: "node src/sum.test.js" },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(sourcePath, "src", "sum.js"), "export function sum(a, b) {\n  return a + b;\n}\n", "utf8");
  await writeFile(
    path.join(sourcePath, "src", "sum.test.js"),
    "import assert from 'node:assert/strict';\nimport { sum } from './sum.js';\n\nassert.equal(sum(2, 3), 5);\n",
    "utf8",
  );
  await writeFile(path.join(sourcePath, "README.md"), "# CodePatchBay Demo Toy Repo\n", "utf8");
  await bestEffortGitInit(sourcePath);
}

async function writeProject(cpbRoot, project, sourcePath) {
  const wikiDir = path.join(cpbRoot, "wiki", "projects", project);
  await mkdir(path.join(wikiDir, "inbox"), { recursive: true });
  await mkdir(path.join(wikiDir, "outputs"), { recursive: true });
  await writeFile(
    path.join(wikiDir, "project.json"),
    `${JSON.stringify({
      id: project,
      name: project,
      sourcePath,
      policy: { useWorktree: false },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(wikiDir, "context.md"), `# ${project}\n\nLocal demo toy repo: ${sourcePath}\n`, "utf8");
  await writeFile(path.join(wikiDir, "decisions.md"), `# ${project} Decisions\n`, "utf8");
  return wikiDir;
}

export async function runDemo({
  project = `demo-${nowSafe()}`,
  task = "Run the CodePatchBay local demo.",
} = {}) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-demo-"));
  const cpbRoot = path.join(tempRoot, "cpb-root");
  const sourcePath = path.join(tempRoot, "toy-repo");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(sourcePath, { recursive: true });
  await writeToyRepo(sourcePath);

  const wikiDir = await writeProject(cpbRoot, project, sourcePath);
  const dataRoot = cpbRoot;
  const job = await createJob(cpbRoot, {
    project,
    task,
    workflow: "standard",
    dataRoot,
    sourceContext: { type: "demo", sourcePath },
  });

  const planPath = path.join(wikiDir, "inbox", "plan-001.md");
  const deliverablePath = path.join(wikiDir, "outputs", "deliverable-001.md");
  const verdictPath = path.join(wikiDir, "outputs", "verdict-001.md");

  await startPhase(cpbRoot, project, job.jobId, { phase: "plan", attempt: 1, dataRoot });
  await writeFile(
    planPath,
    `# Demo Plan\n\nTask: ${task}\n\n## Acceptance Criteria\n- Toy repo exists.\n- Mock deliverable is produced.\n- Mock verifier returns pass.\n`,
    "utf8",
  );
  await completePhase(cpbRoot, project, job.jobId, { phase: "plan", artifact: "plan-001.md", dataRoot });

  await startPhase(cpbRoot, project, job.jobId, { phase: "execute", attempt: 1, dataRoot });
  await writeFile(
    deliverablePath,
    "# Demo Deliverable\n\nPlan-Ref: 001\n\nThe local demo created a toy repo and exercised the CodePatchBay job/artifact path without real provider credentials.\n",
    "utf8",
  );
  await completePhase(cpbRoot, project, job.jobId, { phase: "execute", artifact: "deliverable-001.md", dataRoot });

  await startPhase(cpbRoot, project, job.jobId, { phase: "verify", attempt: 1, dataRoot });
  await writeFile(
    verdictPath,
    `${JSON.stringify({
      status: "pass",
      confidence: 1,
      layers: {
        fast: { status: "pass", detail: "Toy repo and mock artifacts were created." },
        changed: { status: "not_run", detail: "Demo does not mutate a user project." },
        regression: { status: "skipped", detail: "Demo is a mock pipeline smoke." },
        acceptance: { status: "pass", detail: "Mock plan, execute, and verify phases completed." },
      },
      blocking: [],
      diff_summary: "demo artifacts only",
      task_goal: task,
      executor_summary: "Mock executor wrote a demo deliverable.",
      reason: "CodePatchBay demo completed without provider credentials.",
      fix_scope: [],
    }, null, 2)}\n`,
    "utf8",
  );
  await completePhase(cpbRoot, project, job.jobId, { phase: "verify", artifact: "verdict-001.md", dataRoot });
  const completedJob = await completeJob(cpbRoot, project, job.jobId, { dataRoot });

  const eventLog = eventFileFor(cpbRoot, project, job.jobId, { dataRoot });
  const artifactIndex = await buildArtifactIndex(cpbRoot, project, job.jobId, { dataRoot, wikiDir });
  const finalJob = completedJob || await getJob(cpbRoot, project, job.jobId, { dataRoot });

  return {
    ok: true,
    name: "codepatchbay-demo",
    project,
    task,
    tempRoot,
    cpbRoot,
    sourcePath,
    eventLog,
    job: finalJob,
    artifacts: {
      plan: { id: "plan-001", path: planPath },
      deliverable: { id: "deliverable-001", path: deliverablePath },
      verdict: { id: "verdict-001", path: verdictPath },
    },
    artifactIndex,
  };
}
