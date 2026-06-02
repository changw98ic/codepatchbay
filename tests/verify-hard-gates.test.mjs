import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runVerify } from "../core/phases/verify.js";
import { runSinglePhase } from "../core/engine/run-single-phase.js";
import { createJob, failJob, getJob } from "../server/services/job-store.js";
import { appendEvent } from "../server/services/event-store.js";
import { FailureKind } from "../core/contracts/failure.js";

async function withFailingNpmProject(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-verify-gate-"));
  const cpbRoot = path.join(root, "cpb");
  const sourcePath = path.join(root, "source");
  try {
    await mkdir(sourcePath, { recursive: true });
    await writeFile(
      path.join(sourcePath, "package.json"),
      JSON.stringify({ type: "module", scripts: { test: "node fail-test.mjs" } }, null, 2),
      "utf8",
    );
    await writeFile(
      path.join(sourcePath, "fail-test.mjs"),
      "console.log('FAIL_TEST_STDOUT marker'); console.error('FAIL_TEST_STDERR marker'); process.exit(1);\n",
      "utf8",
    );
    return await fn({ root, cpbRoot, sourcePath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("verify hard gates", () => {
  it("fails before verifier agent and preserves test output", async () => {
    await withFailingNpmProject(async ({ cpbRoot, sourcePath }) => {
      let calls = 0;
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
    });
  });

  it("single-phase verify returns failure instead of completing the job", async () => {
    await withFailingNpmProject(async ({ cpbRoot, sourcePath }) => {
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
    });
  });
});
