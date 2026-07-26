import assert from "node:assert/strict";
import { access, lstat, mkdir, readFile, readlink, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { REQUIRED_EXECUTOR_FILES } from "../server/services/executor-root.js";
import {
  _quarantineReleaseDirectoryForTests,
  buildReleaseGcPlan,
  checkReleaseCompatibility,
  executeReleaseGc,
  installRelease,
  listReleases,
  selectRelease,
} from "../server/services/release/release-store.js";
import { tempRoot } from "./helpers.js";

const TOP_LEVEL_ASSETS = [
  "bridges",
  "cli",
  "core",
  "shared",
  "runtime",
  "server",
  "profiles",
  "skills",
  "templates",
  "scripts",
  "web",
];

async function releaseFixture(prefix: string) {
  const root = await tempRoot(prefix);
  const sourceRoot = path.join(root, "source");
  const destRoot = path.join(root, "releases");
  await mkdir(sourceRoot, { recursive: true });
  for (const directory of TOP_LEVEL_ASSETS) {
    await mkdir(path.join(sourceRoot, directory), { recursive: true });
  }
  for (const relativePath of REQUIRED_EXECUTOR_FILES) {
    const target = path.join(sourceRoot, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `fixture:${relativePath}\n`, "utf8");
  }
  await writeFile(path.join(sourceRoot, "package.json"), `${JSON.stringify({
    name: "release-install-safety-fixture",
    version: "1.2.3",
  })}\n`, "utf8");
  await writeFile(path.join(sourceRoot, "cpb"), "#!/bin/sh\nexit 0\n", "utf8");
  return { root, sourceRoot, destRoot };
}

test("release installation publishes a complete exclusive stage", async () => {
  const fixture = await releaseFixture("cpb-release-install-success-");
  const manifest = await installRelease({
    sourceRoot: fixture.sourceRoot,
    destRoot: fixture.destRoot,
    name: "release-success",
  });
  const installedPath = path.join(fixture.destRoot, "release-success");

  assert.equal(manifest.installedPath, installedPath);
  assert.equal(JSON.parse(await readFile(path.join(installedPath, "release", "manifest.json"), "utf8")).releaseId, "release-success");
  assert.equal((await lstat(installedPath)).isSymbolicLink(), true);
  const generationPath = path.resolve(path.dirname(installedPath), await readlink(installedPath));
  assert.equal((await lstat(generationPath)).isDirectory(), true);
  assert.equal(JSON.parse(await readFile(path.join(generationPath, ".cpb-release-commit.json"), "utf8")).releaseId, "release-success");
  const compatibility = await checkReleaseCompatibility({
    releaseId: "release-success",
    destRoot: fixture.destRoot,
  });
  assert.equal(compatibility.ok, true);
  assert.equal(compatibility.canonicalPath, installedPath);
  assert.equal(compatibility.releasePath, generationPath);
  const selected = await selectRelease({
    releaseId: "release-success",
    destRoot: fixture.destRoot,
    env: { ...process.env, CPB_HOME: path.join(fixture.root, "home") },
  });
  assert.equal(selected.selector.releasePath, generationPath);
});

test("release installation preserves both stage generations across a same-path ABA", async () => {
  const fixture = await releaseFixture("cpb-release-install-stage-aba-");
  let stagePath = "";
  let predecessorPath = "";

  await assert.rejects(
    installRelease({
      sourceRoot: fixture.sourceRoot,
      destRoot: fixture.destRoot,
      name: "release-stage-aba",
      hooksForTest: {
        beforePublication: async (context) => {
          stagePath = context.stagePath;
          predecessorPath = `${context.stagePath}.predecessor`;
          await rename(context.stagePath, predecessorPath);
          await mkdir(context.stagePath);
          await writeFile(path.join(context.stagePath, "successor-marker"), "preserve\n", "utf8");
        },
      },
    }),
    (error: unknown) => {
      const failure = error as Error & {
        code?: string;
        committed?: boolean;
        recoveryPaths?: string[];
        attemptedPaths?: string[];
        originalEvidence?: "verified" | "unknown";
      };
      assert.equal(failure.code, "RELEASE_INSTALL_STAGE_CHANGED");
      assert.equal(failure.committed, false);
      assert.equal(failure.originalEvidence, "unknown");
      assert.deepEqual(failure.recoveryPaths, []);
      assert.ok(failure.attemptedPaths?.includes(stagePath));
      assert.equal(failure.recoveryPaths.includes(stagePath), false);
      return true;
    },
  );

  assert.equal(await readFile(path.join(stagePath, "successor-marker"), "utf8"), "preserve\n");
  assert.equal(JSON.parse(await readFile(path.join(predecessorPath, "package.json"), "utf8")).name, "release-install-safety-fixture");
  await assert.rejects(access(path.join(fixture.destRoot, "release-stage-aba")), { code: "ENOENT" });
});

test("concurrent release installers preserve the losing complete stage", async () => {
  const fixture = await releaseFixture("cpb-release-install-concurrent-");
  let arrivals = 0;
  let releaseBoth!: () => void;
  const bothReady = new Promise<void>((resolve) => { releaseBoth = resolve; });
  const beforePublication = async () => {
    arrivals += 1;
    if (arrivals === 2) releaseBoth();
    await bothReady;
  };

  const results = await Promise.allSettled([
    installRelease({
      sourceRoot: fixture.sourceRoot,
      destRoot: fixture.destRoot,
      name: "release-race",
      hooksForTest: { beforePublication },
    }),
    installRelease({
      sourceRoot: fixture.sourceRoot,
      destRoot: fixture.destRoot,
      name: "release-race",
      hooksForTest: { beforePublication },
    }),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.ok(rejected);
  assert.equal(rejected.reason.committed, false);
  const installedPath = path.join(fixture.destRoot, "release-race");
  assert.equal(JSON.parse(await readFile(path.join(installedPath, "release", "manifest.json"), "utf8")).releaseId, "release-race");
  const retainedGeneration = rejected.reason.recoveryPaths.find((candidate: string) => candidate.includes(".release-generations"));
  assert.ok(retainedGeneration);
  assert.equal(JSON.parse(await readFile(path.join(retainedGeneration, "release", "manifest.json"), "utf8")).releaseId, "release-race");
});

test("release installation never overwrites an empty canonical successor", async () => {
  const fixture = await releaseFixture("cpb-release-install-empty-successor-");
  const installedPath = path.join(fixture.destRoot, "release-empty-successor");
  let generationPath = "";

  await assert.rejects(
    installRelease({
      sourceRoot: fixture.sourceRoot,
      destRoot: fixture.destRoot,
      name: "release-empty-successor",
      hooksForTest: {
        beforePublication: async ({ stagePath }) => {
          generationPath = stagePath;
          await mkdir(installedPath);
        },
      },
    }),
    (error: unknown) => {
      const failure = error as Error & { code?: string; committed?: boolean; successorPreserved?: boolean; recoveryPaths?: string[] };
      assert.equal(failure.code, "RELEASE_INSTALL_SUCCESSOR_PRESERVED");
      assert.equal(failure.committed, false);
      assert.equal(failure.successorPreserved, true);
      assert.ok(failure.recoveryPaths?.includes(generationPath));
      return true;
    },
  );

  assert.equal((await lstat(installedPath)).isDirectory(), true);
  const listed = await listReleases({
    destRoot: fixture.destRoot,
    env: { ...process.env, CPB_HOME: path.join(fixture.root, "home") },
  });
  assert.equal(listed.current, null);
  assert.equal(listed.releases.length, 1);
  assert.equal(listed.releases[0].releaseId, "release-empty-successor");
  assert.equal(listed.releases[0].installedPath, installedPath);
  assert.equal(listed.releases[0].status, "invalid");
  assert.equal(JSON.parse(await readFile(path.join(generationPath, ".cpb-release-commit.json"), "utf8")).releaseId, "release-empty-successor");
});

test("a committed hidden generation is invisible until its canonical pointer is published", async () => {
  const fixture = await releaseFixture("cpb-release-install-visibility-");
  let generationPath = "";
  let publish!: () => void;
  let staged!: () => void;
  const stagedPromise = new Promise<void>((resolve) => { staged = resolve; });
  const publishPromise = new Promise<void>((resolve) => { publish = resolve; });
  const installing = installRelease({
    sourceRoot: fixture.sourceRoot,
    destRoot: fixture.destRoot,
    name: "release-visibility",
    hooksForTest: {
      beforePublication: async ({ stagePath }) => {
        generationPath = stagePath;
        staged();
        await publishPromise;
      },
    },
  });

  await stagedPromise;
  assert.equal(JSON.parse(await readFile(path.join(generationPath, ".cpb-release-commit.json"), "utf8")).releaseId, "release-visibility");
  assert.deepEqual((await listReleases({ destRoot: fixture.destRoot })).releases, []);
  assert.equal((await checkReleaseCompatibility({ releaseId: "release-visibility", destRoot: fixture.destRoot })).ok, false);
  publish();
  await installing;
  assert.deepEqual((await listReleases({ destRoot: fixture.destRoot })).releases.map((release) => release.releaseId), ["release-visibility"]);
});

test("release installation retains a committed generation after a pre-pointer crash", async () => {
  const fixture = await releaseFixture("cpb-release-install-pre-pointer-crash-");
  let generationPath = "";
  await assert.rejects(
    installRelease({
      sourceRoot: fixture.sourceRoot,
      destRoot: fixture.destRoot,
      name: "release-pre-pointer-crash",
      hooksForTest: {
        beforePublication: ({ stagePath }) => {
          generationPath = stagePath;
          throw new Error("injected pre-pointer crash");
        },
      },
    }),
    (error: unknown) => {
      const failure = error as Error & { committed?: boolean; recoveryPaths?: string[] };
      assert.equal(failure.committed, false);
      assert.ok(failure.recoveryPaths?.includes(generationPath));
      return true;
    },
  );
  await assert.rejects(access(path.join(fixture.destRoot, "release-pre-pointer-crash")), { code: "ENOENT" });
  assert.deepEqual((await listReleases({ destRoot: fixture.destRoot })).releases, []);
  assert.equal(JSON.parse(await readFile(path.join(generationPath, ".cpb-release-commit.json"), "utf8")).releaseId, "release-pre-pointer-crash");
});

test("release readers reject a canonical pointer whose generation commit marker is invalid", async () => {
  const fixture = await releaseFixture("cpb-release-install-invalid-commit-");
  const installedPath = path.join(fixture.destRoot, "release-invalid-commit");
  await installRelease({
    sourceRoot: fixture.sourceRoot,
    destRoot: fixture.destRoot,
    name: "release-invalid-commit",
  });
  const generationPath = path.resolve(path.dirname(installedPath), await readlink(installedPath));
  await writeFile(path.join(generationPath, ".cpb-release-commit.json"), "{}\n", "utf8");

  const listed = await listReleases({
    destRoot: fixture.destRoot,
    env: { ...process.env, CPB_HOME: path.join(fixture.root, "home") },
  });
  assert.equal(listed.releases.length, 1);
  assert.equal(listed.releases[0].releaseId, "release-invalid-commit");
  assert.equal(listed.releases[0].installedPath, installedPath);
  assert.equal(listed.releases[0].status, "invalid");
  assert.match(listed.releases[0].error || "", /commit marker/i);
  const compatibility = await checkReleaseCompatibility({
    releaseId: "release-invalid-commit",
    destRoot: fixture.destRoot,
  });
  assert.equal(compatibility.ok, false);
  assert.deepEqual(compatibility.failures.map((failure) => failure.code), ["release_not_committed"]);
});

test("release inventory retains a damaged canonical entry and GC classifies it as unsafe", async () => {
  const fixture = await releaseFixture("cpb-release-inventory-invalid-");
  const cpbRoot = path.join(fixture.root, "project");
  const env = { ...process.env, CPB_HOME: path.join(fixture.root, "home"), CPB_ROOT: cpbRoot };
  await mkdir(cpbRoot);
  await installRelease({
    sourceRoot: fixture.sourceRoot,
    destRoot: fixture.destRoot,
    name: "release-inventory-invalid",
  });
  const canonicalPath = path.join(fixture.destRoot, "release-inventory-invalid");
  const generationPath = path.resolve(path.dirname(canonicalPath), await readlink(canonicalPath));
  await writeFile(path.join(generationPath, "release", "manifest.json"), '{"metadataVersion":1}\n', "utf8");

  const listed = await listReleases({ destRoot: fixture.destRoot, env });
  assert.equal(listed.releases.length, 1);
  const invalid = listed.releases[0] as typeof listed.releases[number] & {
    recoveryPaths?: unknown;
    attemptedPaths?: unknown;
  };
  assert.equal(invalid.releaseId, "release-inventory-invalid");
  assert.equal(invalid.installedPath, canonicalPath);
  assert.equal(invalid.status, "invalid");
  assert.match(invalid.error || "", /release metadata|commit/i);
  assert.equal(invalid.generationPath, undefined);
  assert.equal(invalid.recoveryPaths, undefined);
  assert.equal(invalid.attemptedPaths, undefined);

  const plan = await buildReleaseGcPlan({ cpbRoot, destRoot: fixture.destRoot, env });
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].releaseId, "release-inventory-invalid");
  assert.equal(plan.candidates[0].installedPath, canonicalPath);
  assert.equal(plan.candidates[0].classification, "unsafe");
  assert.ok(plan.candidates[0].reasons.includes("missing_metadata"));
  assert.ok(plan.candidates[0].reasons.includes("missing"));
});

test("release installation rejects a symlinked store root", async () => {
  const fixture = await releaseFixture("cpb-release-install-store-symlink-");
  const actualStore = path.join(fixture.root, "actual-releases");
  await mkdir(actualStore);
  await symlink(actualStore, fixture.destRoot);

  await assert.rejects(
    installRelease({ sourceRoot: fixture.sourceRoot, destRoot: fixture.destRoot, name: "release-store-symlink" }),
    { code: "RELEASE_INSTALL_UNSAFE" },
  );
  assert.deepEqual(await lstat(fixture.destRoot).then((info) => info.isSymbolicLink()), true);
});

test("release installation rejects a store beneath a symlinked immediate parent", async () => {
  const fixture = await releaseFixture("cpb-release-install-parent-symlink-");
  const actualParent = path.join(fixture.root, "actual-parent");
  const aliasParent = path.join(fixture.root, "alias-parent");
  await mkdir(actualParent);
  await symlink(actualParent, aliasParent);

  await assert.rejects(
    installRelease({
      sourceRoot: fixture.sourceRoot,
      destRoot: path.join(aliasParent, "releases"),
      name: "release-parent-symlink",
    }),
    { code: "RELEASE_INSTALL_UNSAFE" },
  );
  await assert.rejects(access(path.join(actualParent, "releases", "release-parent-symlink")), { code: "ENOENT" });
});

test("release installation reports pointer commit when the parent fsync fails", async () => {
  const fixture = await releaseFixture("cpb-release-install-pointer-fsync-");
  const installedPath = path.join(fixture.destRoot, "release-pointer-fsync");

  await assert.rejects(
    installRelease({
      sourceRoot: fixture.sourceRoot,
      destRoot: fixture.destRoot,
      name: "release-pointer-fsync",
      hooksForTest: {
        syncDirectory: async ({ phase }) => {
          if (phase === "pointer-publication") throw new Error("injected pointer parent fsync failure");
        },
      },
    }),
    (error: unknown) => {
      const failure = error as Error & { code?: string; committed?: boolean; committedPath?: string; recoveryPaths?: string[] };
      assert.equal(failure.code, "RELEASE_INSTALL_COMMITTED_AMBIGUOUS");
      assert.equal(failure.committed, true);
      assert.equal(failure.committedPath, installedPath);
      assert.ok(failure.recoveryPaths?.includes(installedPath));
      return true;
    },
  );

  assert.equal((await lstat(installedPath)).isSymbolicLink(), true);
  assert.deepEqual((await listReleases({ destRoot: fixture.destRoot })).releases.map((release) => release.releaseId), ["release-pointer-fsync"]);
});

test("release GC plans and quarantines a committed generation pointer without deleting its payload", async () => {
  const fixture = await releaseFixture("cpb-release-gc-generation-pointer-");
  const cpbRoot = path.join(fixture.root, "project");
  const env = { ...process.env, CPB_HOME: path.join(fixture.root, "home"), CPB_ROOT: cpbRoot };
  await mkdir(cpbRoot);
  await installRelease({
    sourceRoot: fixture.sourceRoot,
    destRoot: fixture.destRoot,
    name: "release-gc-pointer",
  });
  const canonicalPath = path.join(fixture.destRoot, "release-gc-pointer");
  const generationPath = path.resolve(path.dirname(canonicalPath), await readlink(canonicalPath));

  const plan = await buildReleaseGcPlan({ cpbRoot, destRoot: fixture.destRoot, env });
  assert.deepEqual(plan.candidates.map((candidate) => [candidate.releaseId, candidate.classification]), [
    ["release-gc-pointer", "eligible"],
  ]);
  const result = await executeReleaseGc(plan, { cpbRoot, destRoot: fixture.destRoot, env });

  assert.equal(result.refused.length, 0);
  assert.equal(result.quarantined.length, 1);
  const quarantinePath = result.quarantined[0].quarantinePath!;
  assert.equal((await lstat(quarantinePath)).isSymbolicLink(), true);
  assert.equal(path.resolve(path.dirname(quarantinePath), await readlink(quarantinePath)), generationPath);
  await assert.rejects(access(canonicalPath), { code: "ENOENT" });
  assert.equal((await lstat(generationPath)).isDirectory(), true);
  assert.deepEqual((await listReleases({ destRoot: fixture.destRoot, env })).releases, []);
});

test("release GC never verifies a generation pointer after its target tree is mutated in place", async () => {
  const fixture = await releaseFixture("cpb-release-gc-pointer-target-aba-");
  await installRelease({
    sourceRoot: fixture.sourceRoot,
    destRoot: fixture.destRoot,
    name: "release-gc-pointer-target-aba",
  });
  const canonicalPath = path.join(fixture.destRoot, "release-gc-pointer-target-aba");
  const generationPath = path.resolve(path.dirname(canonicalPath), await readlink(canonicalPath));
  let quarantinePath = "";

  await assert.rejects(
    _quarantineReleaseDirectoryForTests(
      fixture.destRoot,
      canonicalPath,
      "release-gc-pointer-target-aba",
      {
        afterRename: async (context) => {
          quarantinePath = context.quarantinePath;
          await writeFile(
            path.join(generationPath, "package.json"),
            `${JSON.stringify({ name: "mutated-after-pointer-isolation", version: "9.9.9" })}\n`,
            "utf8",
          );
        },
      },
    ),
    (error: unknown) => {
      const failure = error as Error & {
        code?: string;
        committed?: boolean;
        committedPath?: string;
        quarantinePreserved?: boolean;
        originalEvidence?: "verified" | "unknown";
        recoveryPaths?: { quarantine?: string };
        attemptedPaths?: { canonical?: string; quarantine?: string };
      };
      assert.equal(failure.code, "RELEASE_GC_QUARANTINE_COMMITTED_AMBIGUOUS");
      assert.equal(failure.committed, true);
      assert.equal(failure.committedPath, undefined);
      assert.equal(failure.quarantinePreserved, false);
      assert.equal(failure.originalEvidence, "unknown");
      assert.equal(failure.recoveryPaths, undefined);
      assert.deepEqual(failure.attemptedPaths, { canonical: canonicalPath, quarantine: quarantinePath });
      return true;
    },
  );

  assert.equal((await lstat(quarantinePath)).isSymbolicLink(), true);
  assert.equal(path.resolve(path.dirname(quarantinePath), await readlink(quarantinePath)), generationPath);
  assert.equal(
    JSON.parse(await readFile(path.join(generationPath, "package.json"), "utf8")).name,
    "mutated-after-pointer-isolation",
  );
});
