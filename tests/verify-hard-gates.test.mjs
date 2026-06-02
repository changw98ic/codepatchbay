import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { runVerify } from "../core/phases/verify.js";
import { runSinglePhase } from "../core/engine/run-single-phase.js";
import { createJob, failJob, getJob } from "../server/services/job-store.js";
import { appendEvent } from "../server/services/event-store.js";
import { FailureKind } from "../core/contracts/failure.js";

const execFile = promisify(execFileCb);

async function withFailingNpmProject(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-verify-gate-"));
  const cpbRoot = path.join(root, "cpb");
  const sourcePath = path.join(root, "source");
  try {
    await mkdir(sourcePath, { recursive: true });
    await mkdir(path.join(sourcePath, "src"), { recursive: true });
    await mkdir(path.join(sourcePath, "tests"), { recursive: true });
    await writeFile(
      path.join(sourcePath, "package.json"),
      JSON.stringify({ type: "module", scripts: { test: "node fail-test.mjs" } }, null, 2),
      "utf8",
    );
    await writeFile(path.join(sourcePath, "src", "app.mjs"), "export const value = 1;\n", "utf8");
    await writeFile(
      path.join(sourcePath, "tests", "app.test.mjs"),
      "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../src/app.mjs'; test('value', () => assert.equal(value, 2));\n",
      "utf8",
    );
    await writeFile(
      path.join(sourcePath, "fail-test.mjs"),
      "console.log('FAIL_TEST_STDOUT marker'); console.error('FAIL_TEST_STDERR marker'); process.exit(1);\n",
      "utf8",
    );
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
    await writeFile(path.join(sourcePath, "src", "app.mjs"), "export const value = 2;\n", "utf8");
    return await fn({ root, cpbRoot, sourcePath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("verify hard gates", () => {
  it("runs focused gates by default and leaves full npm test to the verifier/regression layer", async () => {
    await withFailingNpmProject(async ({ cpbRoot, sourcePath }) => {
      let calls = 0;
      const previous = process.env.CPB_VERIFY_FULL;
      delete process.env.CPB_VERIFY_FULL;
      try {
        const result = await runVerify({
          project: "proj",
          cpbRoot,
          sourcePath,
          jobId: "job-focused-gate",
          task: "verify focused gates",
          pool: {
            async execute() {
              calls += 1;
              return JSON.stringify({
                status: "ok",
                verdict: "pass",
                reason: "Focused gates passed and acceptance probes are satisfied.",
                details: "The failing package test was not part of the default hard gate.",
                confidence: 0.9,
              });
            },
          },
          previousResults: [
            { phase: "execute", status: "passed", artifact: { kind: "deliverable", name: "deliverable-1" } },
          ],
        });

        assert.equal(calls, 1);
        assert.equal(result.status, "passed");
      } finally {
        if (previous === undefined) delete process.env.CPB_VERIFY_FULL;
        else process.env.CPB_VERIFY_FULL = previous;
      }
    });
  });

  it("fails before verifier agent and preserves test output when full verification is requested", async () => {
    await withFailingNpmProject(async ({ cpbRoot, sourcePath }) => {
      let calls = 0;
      const previous = process.env.CPB_VERIFY_FULL;
      process.env.CPB_VERIFY_FULL = "1";
      try {
        const result = await runVerify({
          project: "proj",
          cpbRoot,
          sourcePath,
          jobId: "job-hard-gate",
          task: "verify hard gates",
          pool: { async execute() { calls += 1; return "should not run"; } },
          previousResults: [
            { phase: "execute", status: "passed", artifact: { kind: "deliverable", name: "deliverable-1" } },
          ],
        });

        assert.equal(calls, 0);
        assert.equal(result.status, "failed");
        assert.equal(result.failure.kind, FailureKind.VERIFICATION_FAILED);
        assert.equal(result.failure.retryable, false);
        assert.equal(result.failure.cause.hardGate, true);
        assert.match(result.failure.reason, /FAIL_TEST_STDOUT marker/);
        assert.match(result.failure.reason, /FAIL_TEST_STDERR marker/);
      } finally {
        if (previous === undefined) delete process.env.CPB_VERIFY_FULL;
        else process.env.CPB_VERIFY_FULL = previous;
      }
    });
  });

  it("single-phase verify returns failure instead of completing the job", async () => {
    await withFailingNpmProject(async ({ cpbRoot, sourcePath }) => {
      const previous = process.env.CPB_VERIFY_FULL;
      process.env.CPB_VERIFY_FULL = "1";
      try {
        const outputDir = path.join(cpbRoot, "wiki", "projects", "proj", "outputs");
        await mkdir(outputDir, { recursive: true });
        await writeFile(path.join(outputDir, "deliverable-1.md"), "# Deliverable\n\nUpdated src/app.js\n", "utf8");

        const exitCode = await runSinglePhase("verify", {
          cpbRoot,
          project: "proj",
          sourcePath,
          jobId: "job-single-verify",
          createJob,
          completeJob: async () => {
            throw new Error("completeJob must not be called for failed verify");
          },
          failJob,
          appendEvent,
          getPool: () => ({ async execute() { throw new Error("verifier must not be called"); } }),
        });

        assert.equal(exitCode, 1);
        const job = await getJob(cpbRoot, "proj", "job-single-verify");
        assert.equal(job.status, "failed");
        assert.equal(job.failureCode, FailureKind.VERIFICATION_FAILED);
      } finally {
        if (previous === undefined) delete process.env.CPB_VERIFY_FULL;
        else process.env.CPB_VERIFY_FULL = previous;
      }
    });
  });
});
