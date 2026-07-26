import assert from "node:assert/strict";
import { lstat, mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { ingestEvent, listCandidates } from "../server/services/event-source.js";
import { tempRoot } from "./helpers.js";

const CANDIDATE_QUEUE_MAX_BYTES = 16 * 1024 * 1024;

function candidateFile(hubRoot: string) {
  return path.join(hubRoot, "event-sources", "candidates.json");
}

test("candidate queue rejects a symbolic-link target without mutating the outside file", async () => {
  const cpbRoot = await tempRoot("cpb-candidate-queue-symlink-cpb");
  const hubRoot = await tempRoot("cpb-candidate-queue-symlink-hub");
  const outside = path.join(hubRoot, "outside-candidates.json");
  const file = candidateFile(hubRoot);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(outside, "[]\n", "utf8");
  await symlink(outside, file);

  await assert.rejects(
    ingestEvent(cpbRoot, {
      source: "github",
      externalId: "candidate-symlink",
      projectId: "flow",
    }, { hubRoot }),
    (error: NodeJS.ErrnoException & { recoveryPaths?: string[] }) => error.code === "CANDIDATE_QUEUE_UNSAFE"
      && error.recoveryPaths?.includes(file) === true,
  );
  await assert.rejects(
    listCandidates(cpbRoot, { hubRoot }),
    (error: NodeJS.ErrnoException) => error.code === "CANDIDATE_QUEUE_UNSAFE",
  );

  assert.equal(await readFile(outside, "utf8"), "[]\n");
  assert.equal(await readlink(file), outside);
});

test("candidate queue rejects oversized data without replacing it", async () => {
  const cpbRoot = await tempRoot("cpb-candidate-queue-oversized-cpb");
  const hubRoot = await tempRoot("cpb-candidate-queue-oversized-hub");
  const file = candidateFile(hubRoot);
  const oversized = "x".repeat(CANDIDATE_QUEUE_MAX_BYTES + 1);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, oversized, "utf8");

  await assert.rejects(
    ingestEvent(cpbRoot, {
      source: "github",
      externalId: "candidate-oversized",
      projectId: "flow",
    }, { hubRoot }),
    (error: NodeJS.ErrnoException & { recoveryPaths?: string[] }) => error.code === "CANDIDATE_QUEUE_TOO_LARGE"
      && error.recoveryPaths?.includes(file) === true,
  );

  assert.equal((await lstat(file)).size, oversized.length);
});
