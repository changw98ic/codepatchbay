import assert from "node:assert/strict";
import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  canonicalReviewBundleDirectory,
  canonicalReviewBundlePath,
  verifiedCanonicalReviewBundlePath,
} from "../shared/orchestrator/review-bundle-path.js";
import { tempRoot } from "./helpers.js";

test("review bundle owner paths are bounded, collision-resistant, and stay under the authority root", () => {
  const hubRoot = "/tmp/cpb-review-authority";
  const identities = ["../escape", "a/b", "a:b", ".", "/", "x".repeat(1_024)];
  const paths = identities.map((project, index) => canonicalReviewBundlePath(
    hubRoot,
    project,
    `job:${index}/${"y".repeat(1_024)}`,
  ));
  assert.equal(new Set(paths).size, paths.length);
  for (const candidate of paths) {
    const relative = path.relative(path.join(hubRoot, "review-bundles"), candidate);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    assert.ok(path.basename(path.dirname(candidate)).length <= 97);
    assert.ok(path.basename(candidate).length <= 255);
  }
});

test("review bundle authority rejects a symlinked owner directory", async () => {
  const hubRoot = await tempRoot("cpb-review-path-authority");
  const outside = await tempRoot("cpb-review-path-outside");
  const project = "proj";
  const reviewRoot = path.join(hubRoot, "review-bundles");
  await mkdir(reviewRoot, { recursive: true });
  await symlink(outside, canonicalReviewBundleDirectory(hubRoot, project));
  await assert.rejects(
    verifiedCanonicalReviewBundlePath(hubRoot, project, "job"),
    /canonical directory authority/,
  );
});
