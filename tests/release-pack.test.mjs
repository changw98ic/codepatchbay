import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createManifestTempPath, packRelease } from "../server/services/release-pack.js";

describe("release-pack", () => {
  it("fails when npm pack output cannot be statted", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "cpb-release-pack-test-"));
    const execFileFn = mock.fn(async () => ({ stdout: "missing-package.tgz\n" }));
    const statFn = mock.fn(async (targetPath) => {
      if (targetPath === process.cwd()) return { isDirectory: () => true };
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    try {
      await assert.rejects(
        packRelease({
          sourceRoot: process.cwd(),
          outputDir,
          execFileFn,
          statFn,
        }),
        /npm pack tarball was not found/,
      );

      const files = await readFile(path.join(outputDir, "missing-package.tgz.manifest.json"), "utf8")
        .then(() => true, () => false);
      assert.equal(files, false, "packRelease must not write a manifest for a missing tarball");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("uses a caller-provided entropy token for temp manifest paths", () => {
    const tempPath = createManifestTempPath("/tmp/codepatchbay.tgz.manifest.json", () => "fixed-token");
    assert.equal(tempPath, "/tmp/codepatchbay.tgz.manifest.json.tmp-fixed-token");
  });
});
