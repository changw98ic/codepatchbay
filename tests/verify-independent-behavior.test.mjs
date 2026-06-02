import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { runVerify } from "../core/phases/verify.js";
import { FailureKind } from "../core/contracts/failure.js";

const execFile = promisify(execFileCb);

async function withGitProject(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-verify-independent-"));
  const cpbRoot = path.join(root, "cpb");
  const sourcePath = path.join(root, "source");

  try {
    await mkdir(cpbRoot, { recursive: true });
    await mkdir(path.join(sourcePath, "src"), { recursive: true });
    await writeFile(path.join(sourcePath, "src", "app.mjs"), "export const value = 1;\n", "utf8");
    await execFile("git", ["init"], { cwd: sourcePath });
    await execFile("git", ["add", "."], { cwd: sourcePath });
    await execFile("git", ["commit", "-m", "baseline"], {
      cwd: sourcePath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "cpb-test",
        GIT_AUTHOR_EMAIL: "cpb-test@example.com",
        GIT_COMMITTER_NAME: "cpb-test",
        GIT_COMMITTER_EMAIL: "cpb-test@example.com",
      },
    });

    return await fn({ cpbRoot, sourcePath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writePlanArtifact(cpbRoot, name, content = "## Plan\n- Verify src/app.mjs against the requested behavior.\n") {
  const filePath = path.join(cpbRoot, `${name}.md`);
  await writeFile(filePath, content, "utf8");
  return { kind: "plan", name, path: filePath };
}

function passingVerifier(prompts) {
  return {
    async execute(_agent, prompt) {
      prompts.push(prompt);
      return `\`\`\`json
{
  "status": "ok",
  "verdict": "pass",
  "reason": "Plan, diff, changed files, and hard gates corroborate the implementation.",
  "details": "Independent verification evidence is present.",
  "confidence": 0.9
}
\`\`\``;
    },
  };
}

describe("verify independent behavior", () => {
  it("includes plan reference and diff evidence without using deliverable as verification basis", async () => {
    await withGitProject(async ({ cpbRoot, sourcePath }) => {
      await writeFile(path.join(sourcePath, "src", "app.mjs"), "export const value = 2;\n", "utf8");

      const prompts = [];
      const result = await runVerify({
        project: "proj",
        cpbRoot,
        sourcePath,
        jobId: "job-independent-prompt",
        task: "Change src/app.mjs so value is exported as 2.",
        previousResults: [
          { phase: "plan", status: "passed", artifact: await writePlanArtifact(cpbRoot, "plan-independent") },
          { phase: "execute", status: "passed", artifact: { kind: "deliverable", name: "deliverable-self-report" } },
        ],
        pool: passingVerifier(prompts),
      });

      assert.equal(result.status, "passed");
      assert.equal(prompts.length, 1);
      assert.match(prompts[0], /Plan[^\n]*plan-independent/);
      assert.match(prompts[0], /src\/app\.mjs/);
      assert.match(prompts[0], /export const value = 2/);
      assert.doesNotMatch(prompts[0], /^Deliverable:\s*deliverable-self-report\b/m);
    });
  });

  it("fails when verifier cannot corroborate deliverable success from plan and diff evidence", async () => {
    await withGitProject(async ({ cpbRoot, sourcePath }) => {
      await writeFile(path.join(sourcePath, "README.md"), "No source implementation changed.\n", "utf8");

      const result = await runVerify({
        project: "proj",
        cpbRoot,
        sourcePath,
        jobId: "job-self-report-only",
        task: "Change src/app.mjs so value is exported as 2.",
        previousResults: [
          { phase: "plan", status: "passed", artifact: await writePlanArtifact(cpbRoot, "plan-expects-src-app") },
          {
            phase: "execute",
            status: "passed",
            artifact: {
              kind: "deliverable",
              name: "deliverable-claims-success",
              metadata: { summary: "Changed src/app.mjs and all tests pass." },
            },
          },
        ],
        pool: {
          async execute(_agent, prompt) {
            const hasPlan = /Plan[^\n]*plan-expects-src-app/.test(prompt);
            const hasChangedFileEvidence = /README\.md/.test(prompt);
            const hasExpectedDiff = /src\/app\.mjs/.test(prompt) && /export const value = 2/.test(prompt);
            const verdict = hasPlan && hasChangedFileEvidence && !hasExpectedDiff ? "fail" : "pass";
            return `\`\`\`json
{
  "status": "ok",
  "verdict": "${verdict}",
  "reason": "Deliverable self-report is not corroborated by the current diff.",
  "details": "The plan asks for src/app.mjs, but changed-file evidence only shows README.md.",
  "confidence": 0.95
}
\`\`\``;
          },
        },
      });

      assert.equal(result.status, "failed");
      assert.equal(result.failure.kind, FailureKind.VERIFICATION_FAILED);
      assert.match(result.failure.reason, /not corroborated/);
    });
  });

  it("runs hard gates on current changed js and mjs files before verifier", async () => {
    await withGitProject(async ({ cpbRoot, sourcePath }) => {
      await writeFile(path.join(sourcePath, "src", "broken.js"), "const broken = ;\n", "utf8");
      await writeFile(path.join(sourcePath, "src", "broken.mjs"), "const broken = ;\n", "utf8");

      let calls = 0;
      const result = await runVerify({
        project: "proj",
        cpbRoot,
        sourcePath,
        jobId: "job-current-js-mjs-gates",
        task: "Verify syntax gates run before verifier.",
        previousResults: [
          { phase: "plan", status: "passed", artifact: await writePlanArtifact(cpbRoot, "plan-syntax") },
          { phase: "execute", status: "passed", artifact: { kind: "deliverable", name: "deliverable-syntax" } },
        ],
        pool: {
          async execute() {
            calls += 1;
            return "verifier should not run when hard gates fail";
          },
        },
      });

      assert.equal(calls, 0);
      assert.equal(result.status, "failed");
      assert.equal(result.failure.kind, FailureKind.VERIFICATION_FAILED);
      assert.equal(result.failure.cause.hardGate, true);
      assert.match(result.failure.reason, /node --check src\/broken\.js failed/);
      assert.match(result.failure.reason, /node --check src\/broken\.mjs failed/);
    });
  });

  it("fails before invoking verifier when no readable plan artifact exists", async () => {
    await withGitProject(async ({ cpbRoot, sourcePath }) => {
      let calls = 0;
      const result = await runVerify({
        project: "proj",
        cpbRoot,
        sourcePath,
        jobId: "job-missing-plan",
        task: "Verify should require plan source of truth.",
        previousResults: [],
        pool: {
          async execute() {
            calls += 1;
            return `\`\`\`json
{
  "status": "ok",
  "verdict": "pass",
  "reason": "This pass must not be accepted without a plan.",
  "details": "No plan was provided.",
  "confidence": 0.9
}
\`\`\``;
          },
        },
      });

      assert.equal(calls, 0);
      assert.equal(result.status, "failed");
      assert.equal(result.failure.kind, FailureKind.VERIFICATION_FAILED);
      assert.equal(result.failure.retryable, false);
      assert.equal(result.failure.cause.planRequired, true);
      assert.match(result.failure.reason, /requires a plan artifact/);
    });
  });
});
