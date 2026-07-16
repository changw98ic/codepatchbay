import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { readActiveChecklistArtifacts } from "../core/workflow/checklist-artifacts.js";
import { tempRoot } from "./helpers.js";

test("active checklist artifact selection uses event order when repair artifacts share a timestamp", async () => {
  const root = await tempRoot("cpb-checklist-artifact-order");
  const olderPath = path.join(root, "execution-map-older.json");
  const newerPath = path.join(root, "execution-map-newer.json");
  await writeFile(olderPath, JSON.stringify({ version: "older", unmappedChangedFiles: ["README.md"] }), "utf8");
  await writeFile(newerPath, JSON.stringify({ version: "newer", unmappedChangedFiles: [] }), "utf8");
  const createdAt = "2026-07-12T00:00:00.123Z";

  const result = await readActiveChecklistArtifacts({
    artifactIndex: {
      entries: [
        { kind: "execution-map", id: "older", attemptId: "attempt-1", exists: true, broken: false, path: olderPath, createdAt },
        { kind: "execution-map", id: "newer", attemptId: "attempt-1", exists: true, broken: false, path: newerPath, createdAt },
      ],
    },
    attemptId: "attempt-1",
    requiredKinds: ["execution-map"],
  });

  assert.equal(result.ok, true);
  assert.equal((result["execution-map"] as Record<string, unknown>).version, "newer");
});
