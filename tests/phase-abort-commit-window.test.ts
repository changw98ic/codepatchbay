import assert from "node:assert/strict";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  withArtifactStoreTestHooks,
  writeArtifact,
} from "../core/artifacts/artifact-store.js";
import { runReview } from "../core/phases/review.js";
import { tempRoot } from "./helpers.js";

function jsonEnvelope(data: Record<string, unknown>) {
  return `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
}

async function exists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return false;
    throw error;
  }
}

test("review phase passes signal through injected artifact writer and aborts mid-write atomically", async () => {
  const cpbRoot = await tempRoot("cpb-phase-abort-commit-window");
  const controller = new AbortController();
  let observed: { path: string; tempPath: string; lockDir: string } | null = null;
  let writerSawSignal = false;

  const pool = {
    async execute() {
      return {
        output: jsonEnvelope({
          status: "ok",
          verdict: "approved",
          summary: "ready",
          comments: [],
        }),
      };
    },
  };

  try {
    await assert.rejects(
      withArtifactStoreTestHooks({
        afterTempWrite: async (context) => {
          observed = context;
          assert.equal(await exists(context.tempPath), true);
          controller.abort(new Error("abort review artifact commit"));
        },
      }, () => runReview({
        cpbRoot,
        dataRoot: cpbRoot,
        project: "flow",
        jobId: "job-phase-abort-commit-window",
        task: "review abort propagation",
        sourcePath: cpbRoot,
        previousResults: [{ artifact: { kind: "deliverable", name: "deliverable-1" } }],
        pool,
        signal: controller.signal,
        async writeArtifact(root: string, input: Parameters<typeof writeArtifact>[1]) {
          writerSawSignal = input.signal === controller.signal;
          return writeArtifact(root, input);
        },
      })),
      { name: "AbortError" },
    );

    assert.equal(writerSawSignal, true);
    assert.ok(observed);
    assert.equal(await exists(observed.path), false);
    assert.equal(await exists(observed.tempPath), false);
    assert.equal(await exists(observed.lockDir), false);

    const outputsDir = path.join(cpbRoot, "wiki", "outputs");
    const files = await readdir(outputsDir);
    assert.deepEqual(files.filter((file) => file.includes("review-")), []);
    assert.deepEqual(files.filter((file) => file.startsWith(".lock-")), []);
    assert.deepEqual(files.filter((file) => file.endsWith(".tmp")), []);
  } finally {
    // The async-local hook scope ends with the runReview promise.
  }
});
