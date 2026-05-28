import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildArtifactIndex } from "./artifact-index.js";
import { appendEvent, eventFileFor } from "./event-store.js";
import {
  completeJob,
  completePhase,
  createJob,
  getJob,
  startPhase,
} from "./job-store.js";

const execFileAsync = promisify(execFile);

const INITIAL_SUM_SOURCE = "export function sum(a, b) {\n  return a - b;\n}\n";
const FIXED_SUM_SOURCE = "export function sum(a, b) {\n  return a + b;\n}\n";
const SUM_TEST_SOURCE = "import assert from 'node:assert/strict';\nimport { sum } from './sum.js';\n\nassert.equal(sum(2, 3), 5);\nassert.equal(sum(-1, 4), 3);\nconsole.log('ok - sum handles positive and negative integers');\n";
const STORY_ORDER = ["plan", "diff", "tests", "verdict", "risk"];

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
  await writeFile(path.join(sourcePath, "src", "sum.js"), INITIAL_SUM_SOURCE, "utf8");
  await writeFile(path.join(sourcePath, "src", "sum.test.js"), SUM_TEST_SOURCE, "utf8");
  await writeFile(path.join(sourcePath, "README.md"), "# CodePatchBay Demo Toy Repo\n", "utf8");
  await bestEffortGitInit(sourcePath);
}

function demoDiffPatch() {
  return `diff --git a/src/sum.js b/src/sum.js
index 6fbc235..e741ad8 100644
--- a/src/sum.js
+++ b/src/sum.js
@@ -1,3 +1,3 @@
 export function sum(a, b) {
-  return a - b;
+  return a + b;
 }
`;
}

async function captureToyDiff(sourcePath) {
  try {
    const result = await execFileAsync("git", ["diff", "--", "src/sum.js"], {
      cwd: sourcePath,
      timeout: 10_000,
    });
    if (result.stdout) {
      return result.stdout;
    }
  } catch {
    // Fall back to stable demo evidence if git is unavailable in the runtime.
  }
  return demoDiffPatch();
}

async function runToyTests(sourcePath) {
  const started = Date.now();
  const command = "node src/sum.test.js";
  try {
    const result = await execFileAsync(process.execPath, ["src/sum.test.js"], {
      cwd: sourcePath,
      timeout: 10_000,
    });
    return {
      command,
      status: "pass",
      exitCode: 0,
      durationMs: Date.now() - started,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    return {
      command,
      status: "fail",
      exitCode: error.code ?? 1,
      durationMs: Date.now() - started,
      stdout: error.stdout || "",
      stderr: error.stderr || error.message || "",
    };
  }
}

function formatTestReport(result) {
  const stdout = result.stdout.trim() || "(no stdout)";
  const stderr = result.stderr.trim() || "(no stderr)";
  return `# TESTS

Command: ${result.command}
Status: ${result.status}
Exit Code: ${result.exitCode}
Duration: ${result.durationMs}ms

## Stdout

${stdout}

## Stderr

${stderr}
`;
}

function makeRiskSummary(sourcePath) {
  return {
    level: "low",
    summary: "Demo-only temporary toy repo; no user project, network provider, or credentialed agent is touched.",
    factors: [
      "All files are created under a temporary demo directory.",
      "The patch is limited to src/sum.js in the toy repo.",
      "Validation uses the local Node.js runtime and has no package install step.",
      `Cleanup is removal of the temp root that contains ${sourcePath}.`,
    ],
  };
}

function formatRiskReport(risk) {
  return `# RISK

Level: ${risk.level}
Summary: ${risk.summary}

## Factors
${risk.factors.map((factor) => `- ${factor}`).join("\n")}
`;
}

function storyEntries({ planPath, diffPath, testsPath, verdictPath, riskPath, testResult, risk }) {
  const summaries = {
    plan: "Planner defines a one-file toy fix and local acceptance checks.",
    diff: "Patch changes src/sum.js from subtraction to addition.",
    tests: `${testResult.command} completed with status ${testResult.status}.`,
    verdict: "Verifier verdict records passing evidence for the local demo.",
    risk: `${risk.level} risk: ${risk.summary}`,
  };
  const paths = {
    plan: planPath,
    diff: diffPath,
    tests: testsPath,
    verdict: verdictPath,
    risk: riskPath,
  };
  return STORY_ORDER.map((name) => ({
    name,
    label: name.toUpperCase(),
    summary: summaries[name],
    path: paths[name],
  }));
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
  const diffPath = path.join(wikiDir, "outputs", "diff-001.patch");
  const testsPath = path.join(wikiDir, "outputs", "tests-001.txt");
  const verdictPath = path.join(wikiDir, "outputs", "verdict-001.md");
  const riskPath = path.join(wikiDir, "outputs", "risk-001.md");

  await startPhase(cpbRoot, project, job.jobId, { phase: "plan", attempt: 1, dataRoot });
  await writeFile(
    planPath,
    `# PLAN

Task: ${task}

## Change Strategy
- Fix the toy repo's \`sum(a, b)\` implementation so it adds both operands.
- Capture the exact patch as local diff evidence.
- Run the toy repo's Node.js test command and preserve the output.
- Produce a verifier verdict and risk assessment that explain the demo boundary.

## Acceptance Criteria
- Toy repo exists.
- Diff artifact shows the one-file source change.
- Test artifact shows the local command passed.
- Verdict status is pass.
- Risk is low because the demo only touches a temporary toy repo.
`,
    "utf8",
  );
  await completePhase(cpbRoot, project, job.jobId, { phase: "plan", artifact: "plan-001.md", dataRoot });

  await startPhase(cpbRoot, project, job.jobId, { phase: "execute", attempt: 1, dataRoot });
  await writeFile(path.join(sourcePath, "src", "sum.js"), FIXED_SUM_SOURCE, "utf8");
  await writeFile(diffPath, await captureToyDiff(sourcePath), "utf8");
  const testResult = await runToyTests(sourcePath);
  await writeFile(testsPath, formatTestReport(testResult), "utf8");
  await writeFile(
    deliverablePath,
    `# Demo Deliverable

Plan-Ref: 001

The local demo fixed the toy repo sum implementation and exercised the CodePatchBay job/artifact path without real provider credentials.

## Evidence
- Diff: ${diffPath}
- Tests: ${testsPath}
`,
    "utf8",
  );
  await appendEvent(cpbRoot, project, job.jobId, {
    type: "artifact_created",
    jobId: job.jobId,
    project,
    phase: "execute",
    kind: "diff",
    artifact: "diff-001.patch",
    ts: new Date().toISOString(),
  }, { dataRoot });
  await appendEvent(cpbRoot, project, job.jobId, {
    type: "artifact_created",
    jobId: job.jobId,
    project,
    phase: "execute",
    kind: "tests",
    artifact: "tests-001.txt",
    ts: new Date().toISOString(),
  }, { dataRoot });
  await completePhase(cpbRoot, project, job.jobId, { phase: "execute", artifact: "deliverable-001.md", dataRoot });

  await startPhase(cpbRoot, project, job.jobId, { phase: "verify", attempt: 1, dataRoot });
  const risk = makeRiskSummary(sourcePath);
  await writeFile(riskPath, formatRiskReport(risk), "utf8");
  await writeFile(
    verdictPath,
    `${JSON.stringify({
      status: testResult.status === "pass" ? "pass" : "fail",
      confidence: testResult.status === "pass" ? 1 : 0.4,
      layers: {
        fast: { status: testResult.status, detail: "Toy repo tests were executed locally." },
        changed: { status: "not_run", detail: "Demo does not mutate a user project." },
        regression: { status: "skipped", detail: "Demo is a mock pipeline smoke." },
        acceptance: { status: testResult.status, detail: "Plan, diff, tests, verdict, and risk artifacts were produced." },
      },
      blocking: testResult.status === "pass" ? [] : ["Toy repo tests failed."],
      diff_summary: "1 file changed, 1 insertion(+), 1 deletion(-)",
      task_goal: task,
      executor_summary: "Mock executor fixed src/sum.js and captured diff/test evidence.",
      reason: "CodePatchBay demo completed without provider credentials.",
      fix_scope: ["temporary toy repo src/sum.js"],
      test_summary: {
        command: testResult.command,
        status: testResult.status,
        exitCode: testResult.exitCode,
        report: testsPath,
      },
      risk,
      risk_story: risk.factors,
    }, null, 2)}\n`,
    "utf8",
  );
  await appendEvent(cpbRoot, project, job.jobId, {
    type: "artifact_created",
    jobId: job.jobId,
    project,
    phase: "verify",
    kind: "risk",
    artifact: "risk-001.md",
    ts: new Date().toISOString(),
  }, { dataRoot });
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
      diff: { id: "diff-001", path: diffPath },
      tests: { id: "tests-001", path: testsPath },
      verdict: { id: "verdict-001", path: verdictPath },
      risk: { id: "risk-001", path: riskPath },
    },
    story: storyEntries({ planPath, diffPath, testsPath, verdictPath, riskPath, testResult, risk }),
    artifactIndex,
  };
}
