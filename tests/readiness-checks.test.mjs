import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkDiskSpace } from "../server/services/readiness-checks.js";

describe("checkDiskSpace", () => {
  it("does not create a missing target directory while probing free space", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "cpb-disk-check-"));
    const missing = path.join(base, "missing", "nested");
    const probed = [];
    const execFileFn = mock.fn(async (_cmd, args) => {
      probed.push(args[1]);
      return { stdout: "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 1000000 1 999999 1% /tmp\n" };
    });

    try {
      const result = await checkDiskSpace(missing, "test", { execFileFn });

      assert.equal(result.status, "ok");
      assert.deepEqual(probed, [base]);
      await assert.rejects(() => import("node:fs/promises").then(({ stat }) => stat(missing)), /ENOENT/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
