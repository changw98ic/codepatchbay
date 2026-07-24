import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parsePipelineProjectJsonContract,
  parseWorktreeManagerOutputContract,
} from "../bridges/run-pipeline.js";
import { parsePhaseProjectMetaContract } from "../bridges/run-phase.js";

test("pipeline project metadata rejects malformed sourcePath with file context", () => {
  assert.throws(
    () => parsePipelineProjectJsonContract(
      "{\"name\":\"flow\",\"sourcePath\":42}",
      "/hub/projects/flow/wiki/project.json",
      "flow",
    ),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, "PIPELINE_PROJECT_JSON_CONTRACT_INVALID");
      assert.match(String((err as Error).message), /project\.json/i);
      assert.match(String((err as Error).message), /sourcePath/i);
      assert.match(String((err as Error).message), /flow/i);
      return true;
    },
  );
});

test("pipeline project metadata rejects non-object JSON with file context", () => {
  assert.throws(
    () => parsePipelineProjectJsonContract(
      "[{\"sourcePath\":\"/repo\"}]",
      "/hub/projects/flow/wiki/project.json",
      "flow",
    ),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, "PIPELINE_PROJECT_JSON_CONTRACT_INVALID");
      assert.match(String((err as Error).message), /object/i);
      assert.match(String((err as Error).message), /project\.json/i);
      return true;
    },
  );
});

test("worktree manager stdout rejects malformed trailing JSON with command context", () => {
  assert.throws(
    () => parseWorktreeManagerOutputContract(
      "creating worktree\n{bad json",
      "worktree-manager create",
    ),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, "PIPELINE_WORKTREE_OUTPUT_CONTRACT_INVALID");
      assert.match(String((err as Error).message), /worktree-manager create/i);
      assert.match(String((err as Error).message), /stdout/i);
      return true;
    },
  );
});

test("worktree manager stdout rejects created worktree objects without path, branch, and durable base branch", () => {
  assert.throws(
    () => parseWorktreeManagerOutputContract(
      `${JSON.stringify({ path: "/tmp/worktree", branch: "cpb/job-pipeline" })}\n`,
      "worktree-manager create",
    ),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, "PIPELINE_WORKTREE_OUTPUT_CONTRACT_INVALID");
      assert.match(String((err as Error).message), /path/i);
      assert.match(String((err as Error).message), /branch/i);
      assert.match(String((err as Error).message), /baseBranch/i);
      return true;
    },
  );
});

test("worktree manager stdout returns the verified durable base branch", () => {
  const ownership = {
    version: 2,
    state: "ready",
    ownerToken: "11111111-1111-4111-8111-111111111111",
    baseBranch: "release/base",
    baseCommit: "a".repeat(40),
    directory: {
      dev: "1",
      ino: "2",
      birthtimeNs: "3",
      mode: "16877",
      uid: "501",
      gid: "20",
    },
  };
  assert.deepEqual(
    parseWorktreeManagerOutputContract(
      `${JSON.stringify({
        path: "/tmp/worktree",
        branch: "cpb/job-pipeline",
        baseBranch: "release/base",
        baseCommit: "a".repeat(40),
        ownership,
      })}\n`,
      "worktree-manager create",
    ),
    {
      path: "/tmp/worktree",
      branch: "cpb/job-pipeline",
      baseBranch: "release/base",
      baseCommit: "a".repeat(40),
      ownership,
    },
  );
});

test("phase project metadata rejects malformed sourcePath before setting ACP cwd", () => {
  assert.throws(
    () => parsePhaseProjectMetaContract(
      "{\"name\":\"flow\",\"sourcePath\":{\"path\":\"/repo\"}}",
      "/cpb/wiki/projects/flow/project.json",
      "flow",
    ),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, "PHASE_PROJECT_META_CONTRACT_INVALID");
      assert.match(String((err as Error).message), /project\.json/i);
      assert.match(String((err as Error).message), /sourcePath/i);
      assert.match(String((err as Error).message), /flow/i);
      return true;
    },
  );
});
