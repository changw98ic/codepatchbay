import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildReleaseSourceFingerprint,
  verifyReleaseSourceFingerprint,
  withReleaseSourceFingerprintTestHooks,
} from "../scripts/release-source-fingerprint.js";

async function sourceFixture(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-release-source-"));
  t.after(async () => rm(root, { force: true, recursive: true }));
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  await writeFile(path.join(root, "README.md"), "fixture\n");
  await writeFile(path.join(root, "scripts", "main.ts"), "export const value = 1;\n");
  return root;
}

test("release source fingerprint is deterministic and bytewise ordered", async (t) => {
  const root = await sourceFixture(t);
  await writeFile(path.join(root, "scripts", "é.ts"), "accent\n");
  await writeFile(path.join(root, "scripts", "z.ts"), "ascii\n");

  const first = await buildReleaseSourceFingerprint({ root });
  const second = await buildReleaseSourceFingerprint({ root });

  assert.deepEqual(second, first);
  assert.match(first.releaseSourceFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(
    first.manifest.items.map((item) => item.path),
    [...first.manifest.items.map((item) => item.path)].sort((left, right) => (
      Buffer.compare(Buffer.from(left), Buffer.from(right))
    )),
  );
  assert.ok(first.manifest.items.every((item) => /^sha256:[0-9a-f]{64}$/.test(item.contentSha256)));
});

test("release source fingerprint tracks content and executable mode but excludes build output", async (t) => {
  const root = await sourceFixture(t);
  const scriptPath = path.join(root, "scripts", "main.ts");
  const initial = await buildReleaseSourceFingerprint({ root });

  await mkdir(path.join(root, "dist"));
  await writeFile(path.join(root, "dist", "generated.js"), "generated\n");
  assert.equal((await buildReleaseSourceFingerprint({ root })).releaseSourceFingerprint, initial.releaseSourceFingerprint);

  await writeFile(scriptPath, "export const value = 2;\n");
  const contentChanged = await buildReleaseSourceFingerprint({ root });
  assert.notEqual(contentChanged.releaseSourceFingerprint, initial.releaseSourceFingerprint);

  await chmod(scriptPath, 0o755);
  const modeChanged = await buildReleaseSourceFingerprint({ root });
  assert.notEqual(modeChanged.releaseSourceFingerprint, contentChanged.releaseSourceFingerprint);
  assert.equal(modeChanged.manifest.items.find((item) => item.path === "scripts/main.ts")?.mode, "100755");
});

test("release source verifier rejects a changed source tree", async (t) => {
  const root = await sourceFixture(t);
  const expected = await buildReleaseSourceFingerprint({ root });
  await writeFile(path.join(root, "README.md"), "changed\n");
  await assert.rejects(verifyReleaseSourceFingerprint(expected, { root }), { code: "RELEASE_SOURCE_CHANGED" });
});

test("release source scan rejects unknown roots, .DS_Store, and included symlinks", async (t) => {
  const root = await sourceFixture(t);
  await writeFile(path.join(root, "unexpected.txt"), "unexpected\n");
  await assert.rejects(buildReleaseSourceFingerprint({ root }), { code: "RELEASE_SOURCE_UNREGISTERED_PATH" });
  await rm(path.join(root, "unexpected.txt"));

  await writeFile(path.join(root, ".DS_Store"), "junk\n");
  await assert.rejects(buildReleaseSourceFingerprint({ root }), { code: "RELEASE_SOURCE_FORBIDDEN" });
  await rm(path.join(root, ".DS_Store"));

  if (process.platform !== "win32") {
    await symlink(path.join(root, "README.md"), path.join(root, "scripts", "linked.ts"));
    await assert.rejects(buildReleaseSourceFingerprint({ root }), { code: "RELEASE_SOURCE_SYMLINK_FORBIDDEN" });
  }
});

test("release source scan detects a file changed during its open-handle read", async (t) => {
  const root = await sourceFixture(t);
  let changed = false;
  await assert.rejects(
    withReleaseSourceFingerprintTestHooks({
      async afterFileRead({ absolutePath, relativePath }) {
        if (changed || relativePath !== "scripts/main.ts") return;
        changed = true;
        await writeFile(absolutePath, "export const value = 'changed during read';\n");
      },
    }, () => buildReleaseSourceFingerprint({ root })),
    { code: "RELEASE_SOURCE_CHANGED" },
  );
  assert.equal(changed, true);
});
