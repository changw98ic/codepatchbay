import assert from "node:assert/strict";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { REQUIRED_EXECUTOR_FILES } from "../server/services/executor-root.js";
import {
  RELEASE_METADATA_MAX_BYTES,
  currentReleaseLinkPath,
  currentReleaseStatePath,
  readReleaseMetadata,
  selectRelease,
} from "../server/services/release/release-store.js";
import { tempRoot } from "./helpers.js";

async function createRelease(
  releaseStoreRoot: string,
  releaseId: string,
  marker = releaseId,
) {
  const installedPath = path.join(releaseStoreRoot, releaseId);
  await mkdir(path.join(installedPath, "release"), { recursive: true });
  for (const relativePath of REQUIRED_EXECUTOR_FILES) {
    const target = path.join(installedPath, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `fixture:${marker}:${relativePath}\n`, "utf8");
  }
  await writeFile(path.join(installedPath, "cpb"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(path.join(installedPath, "cpb"), 0o755);
  const manifest = {
    metadataVersion: 1,
    releaseId,
    sourcePath: `/source/${releaseId}`,
    installedPath,
    createdAt: "2026-07-21T00:00:00.000Z",
    codeVersion: "1.0.0",
    packageName: "codepatchbay",
    stateFormatVersions: {},
  };
  await writeFile(
    path.join(installedPath, "release", "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return { installedPath, manifestPath: path.join(installedPath, "release", "manifest.json") };
}

async function selectionFixture(prefix: string) {
  const root = await tempRoot(prefix);
  const releaseStoreRoot = path.join(root, "releases");
  const cpbHome = path.join(root, "home");
  await mkdir(releaseStoreRoot, { recursive: true });
  await mkdir(cpbHome, { recursive: true });
  return {
    root,
    releaseStoreRoot,
    cpbHome,
    env: { ...process.env, CPB_HOME: cpbHome },
  };
}

test("release metadata rejects a final-component symlink and oversized input", async () => {
  const fixture = await selectionFixture("cpb-release-metadata-bounds-");
  const release = await createRelease(fixture.releaseStoreRoot, "release-a");
  const realManifest = `${release.manifestPath}.real`;
  await rename(release.manifestPath, realManifest);
  await symlink(realManifest, release.manifestPath);

  await assert.rejects(readReleaseMetadata(release.installedPath), {
    code: "BOUNDED_FILE_UNSAFE",
  });

  await rename(release.manifestPath, `${release.manifestPath}.symlink`);
  await writeFile(release.manifestPath, "x".repeat(RELEASE_METADATA_MAX_BYTES + 1), "utf8");
  await assert.rejects(readReleaseMetadata(release.manifestPath), {
    code: "BOUNDED_FILE_TOO_LARGE",
  });
});

test("release metadata detects growth after descriptor open", async () => {
  const fixture = await selectionFixture("cpb-release-metadata-growth-");
  const release = await createRelease(fixture.releaseStoreRoot, "release-growth");

  await assert.rejects(
    readReleaseMetadata(release.manifestPath, {
      hooksForTest: {
        afterOpen: async ({ filePath }) => {
          await appendFile(filePath, " ", "utf8");
        },
      },
    }),
    { code: "BOUNDED_FILE_CHANGED" },
  );
});

test("release metadata rejects structurally incomplete JSON objects", async () => {
  const fixture = await selectionFixture("cpb-release-metadata-shape-");
  const release = await createRelease(fixture.releaseStoreRoot, "release-shape");
  await writeFile(release.manifestPath, '{"metadataVersion":1}\n', "utf8");

  await assert.rejects(readReleaseMetadata(release.manifestPath), (error: unknown) => {
    const failure = error as Error & { code?: string; fields?: string[] };
    assert.equal(failure.code, "RELEASE_METADATA_INVALID");
    assert.ok(failure.fields?.includes("releaseId"));
    assert.ok(failure.fields?.includes("stateFormatVersions"));
    return true;
  });
});

test("release metadata detects a same-content pathname ABA and preserves both generations", async () => {
  const fixture = await selectionFixture("cpb-release-metadata-aba-");
  const release = await createRelease(fixture.releaseStoreRoot, "release-aba");
  const original = await readFile(release.manifestPath, "utf8");
  const predecessor = `${release.manifestPath}.predecessor`;

  await assert.rejects(
    readReleaseMetadata(release.installedPath, {
      hooksForTest: {
        beforePathGenerationCheck: async ({ filePath }) => {
          await rename(filePath, predecessor);
          await writeFile(filePath, original, "utf8");
        },
      },
    }),
    { code: "BOUNDED_FILE_CHANGED" },
  );

  assert.equal(await readFile(predecessor, "utf8"), original);
  assert.equal(await readFile(release.manifestPath, "utf8"), original);
});

test("release metadata binds the manifest through its parent directory generation", async () => {
  const fixture = await selectionFixture("cpb-release-metadata-parent-aba-");
  const release = await createRelease(fixture.releaseStoreRoot, "release-parent-aba");
  const original = await readFile(release.manifestPath, "utf8");
  const releaseDirectory = path.dirname(release.manifestPath);
  const predecessorDirectory = `${releaseDirectory}.predecessor`;

  await assert.rejects(
    readReleaseMetadata(release.installedPath, {
      hooksForTest: {
        beforePathGenerationCheck: async () => {
          await rename(releaseDirectory, predecessorDirectory);
          await mkdir(releaseDirectory);
          await writeFile(path.join(releaseDirectory, "manifest.json"), original, "utf8");
        },
      },
    }),
    { code: "BOUNDED_FILE_CHANGED" },
  );

  assert.equal(await readFile(path.join(predecessorDirectory, "manifest.json"), "utf8"), original);
  assert.equal(await readFile(release.manifestPath, "utf8"), original);
});

test("release selection preserves a link successor instead of overwriting it", async () => {
  const fixture = await selectionFixture("cpb-release-select-successor-");
  const release = await createRelease(fixture.releaseStoreRoot, "release-selected");
  const successorTarget = path.join(fixture.root, "successor-release");
  await mkdir(successorTarget);
  const linkPath = currentReleaseLinkPath({ env: fixture.env });

  await assert.rejects(
    selectRelease({
      releaseId: "release-selected",
      destRoot: fixture.releaseStoreRoot,
      env: fixture.env,
      hooksForTest: {
        beforeLinkPublication: async () => {
          await symlink(successorTarget, linkPath);
        },
      },
    }),
    (error: unknown) => {
      const failure = error as Error & {
        code?: string;
        committed?: boolean;
        successorPreserved?: boolean;
        recoveryPaths?: string[];
        attemptedPaths?: string[];
        originalEvidence?: "verified" | "unknown";
      };
      assert.equal(failure.code, "RELEASE_SELECTION_SUCCESSOR_PRESERVED");
      assert.equal(failure.committed, false);
      assert.equal(failure.successorPreserved, true);
      assert.equal(failure.recoveryPaths?.includes(linkPath), false);
      assert.ok(failure.attemptedPaths?.includes(linkPath));
      assert.equal(failure.originalEvidence, "verified");
      return true;
    },
  );

  assert.equal(path.resolve(path.dirname(linkPath), await readlink(linkPath)), successorTarget);
  await assert.rejects(lstat(currentReleaseStatePath({ env: fixture.env })), { code: "ENOENT" });
  assert.equal((await lstat(release.installedPath)).isDirectory(), true);
});

test("release selection detects replacement after link publication and never deletes the successor", async () => {
  const fixture = await selectionFixture("cpb-release-select-link-aba-");
  await createRelease(fixture.releaseStoreRoot, "release-selected");
  const successorTarget = path.join(fixture.root, "successor-release");
  await mkdir(successorTarget);
  const linkPath = currentReleaseLinkPath({ env: fixture.env });
  let displaced = "";

  await assert.rejects(
    selectRelease({
      releaseId: "release-selected",
      destRoot: fixture.releaseStoreRoot,
      env: fixture.env,
      hooksForTest: {
        afterLinkPublication: async ({ linkStagePath }) => {
          displaced = `${linkStagePath}.published`;
          await rename(linkPath, displaced);
          await symlink(successorTarget, linkPath);
        },
      },
    }),
    (error: unknown) => {
      const failure = error as Error & {
        code?: string;
        committed?: boolean;
        successorPreserved?: boolean;
        committedPath?: string;
        recoveryPaths?: string[];
        attemptedPaths?: string[];
        originalEvidence?: "verified" | "unknown";
      };
      assert.equal(failure.code, "RELEASE_SELECTION_SUCCESSOR_PRESERVED");
      assert.equal(failure.committed, true);
      assert.equal(failure.successorPreserved, true);
      assert.ok(failure.committedPath?.endsWith(`${path.sep}next-link`));
      assert.ok(failure.recoveryPaths?.includes(failure.committedPath!));
      assert.equal(failure.recoveryPaths?.includes(linkPath), false);
      assert.ok(failure.attemptedPaths?.includes(linkPath));
      assert.equal(failure.originalEvidence, "verified");
      return true;
    },
  );

  assert.equal(path.resolve(path.dirname(linkPath), await readlink(linkPath)), successorTarget);
  assert.equal(path.resolve(path.dirname(displaced), await readlink(displaced)), path.join(fixture.releaseStoreRoot, "release-selected"));
});

test("release selection never advertises a replaced link stage after the canonical link is replaced", async () => {
  const fixture = await selectionFixture("cpb-release-select-link-stage-aba-");
  await createRelease(fixture.releaseStoreRoot, "release-selected");
  const successorTarget = path.join(fixture.root, "successor-release");
  await mkdir(successorTarget);
  const linkPath = currentReleaseLinkPath({ env: fixture.env });
  let linkStagePath = "";
  let displacedCanonical = "";
  let displacedStage = "";

  await assert.rejects(
    selectRelease({
      releaseId: "release-selected",
      destRoot: fixture.releaseStoreRoot,
      env: fixture.env,
      hooksForTest: {
        afterLinkPublication: async (context) => {
          linkStagePath = context.linkStagePath;
          displacedCanonical = `${linkStagePath}.published`;
          displacedStage = `${linkStagePath}.predecessor`;
          await rename(linkPath, displacedCanonical);
          await symlink(successorTarget, linkPath);
          await rename(linkStagePath, displacedStage);
          await symlink(successorTarget, linkStagePath);
        },
      },
    }),
    (error: unknown) => {
      const failure = error as Error & {
        code?: string;
        committed?: boolean;
        committedPath?: string;
        successorPreserved?: boolean;
        recoveryPaths?: string[];
        attemptedPaths?: string[];
        originalEvidence?: "verified" | "unknown";
      };
      assert.equal(failure.code, "RELEASE_SELECTION_COMMITTED_AMBIGUOUS");
      assert.equal(failure.committed, true);
      assert.equal(failure.committedPath, undefined);
      assert.equal(failure.successorPreserved, true);
      assert.equal(failure.recoveryPaths?.includes(linkPath), false);
      assert.equal(failure.recoveryPaths?.includes(linkStagePath), false);
      assert.ok(failure.attemptedPaths?.includes(linkPath));
      assert.ok(failure.attemptedPaths?.includes(linkStagePath));
      assert.equal(failure.originalEvidence, "verified");
      return true;
    },
  );

  assert.equal(path.resolve(path.dirname(linkPath), await readlink(linkPath)), successorTarget);
  assert.equal(path.resolve(path.dirname(linkStagePath), await readlink(linkStagePath)), successorTarget);
  assert.equal(
    path.resolve(path.dirname(displacedCanonical), await readlink(displacedCanonical)),
    path.join(fixture.releaseStoreRoot, "release-selected"),
  );
  assert.equal(
    path.resolve(path.dirname(displacedStage), await readlink(displacedStage)),
    path.join(fixture.releaseStoreRoot, "release-selected"),
  );
});

test("release selection preserves a state successor after the link publication", async () => {
  const fixture = await selectionFixture("cpb-release-select-state-successor-");
  const release = await createRelease(fixture.releaseStoreRoot, "release-selected");
  const statePath = currentReleaseStatePath({ env: fixture.env });
  const successorState = `${JSON.stringify({ releaseId: "successor", releasePath: "/do/not/overwrite" })}\n`;

  await assert.rejects(
    selectRelease({
      releaseId: "release-selected",
      destRoot: fixture.releaseStoreRoot,
      env: fixture.env,
      hooksForTest: {
        beforeStatePublication: async () => {
          await writeFile(statePath, successorState, { flag: "wx", mode: 0o600 });
        },
      },
    }),
    (error: unknown) => {
      const failure = error as Error & {
        code?: string;
        committed?: boolean;
        committedPath?: string;
        successorPreserved?: boolean;
        recoveryPaths?: string[];
        attemptedPaths?: string[];
        originalEvidence?: "verified" | "unknown";
      };
      assert.equal(failure.code, "RELEASE_SELECTION_SUCCESSOR_PRESERVED");
      assert.equal(failure.committed, true);
      assert.equal(failure.successorPreserved, true);
      assert.equal(failure.committedPath, currentReleaseLinkPath({ env: fixture.env }));
      assert.equal(failure.recoveryPaths?.includes(statePath), false);
      assert.ok(failure.attemptedPaths?.includes(statePath));
      assert.equal(failure.originalEvidence, "verified");
      return true;
    },
  );

  assert.equal(await readFile(statePath, "utf8"), successorState);
  assert.equal(
    path.resolve(path.dirname(currentReleaseLinkPath({ env: fixture.env })), await readlink(currentReleaseLinkPath({ env: fixture.env }))),
    release.installedPath,
  );
});

test("release selection revalidates both the state stage and the earlier link before reporting committed recovery", async () => {
  const fixture = await selectionFixture("cpb-release-select-state-stage-aba-");
  const release = await createRelease(fixture.releaseStoreRoot, "release-selected");
  const statePath = currentReleaseStatePath({ env: fixture.env });
  const linkPath = currentReleaseLinkPath({ env: fixture.env });
  const successorState = `${JSON.stringify({ releaseId: "successor", releasePath: "/do/not/overwrite" })}\n`;
  let stateStagePath = "";
  let displacedCanonical = "";
  let displacedStage = "";

  await assert.rejects(
    selectRelease({
      releaseId: "release-selected",
      destRoot: fixture.releaseStoreRoot,
      env: fixture.env,
      hooksForTest: {
        afterStatePublication: async (context) => {
          stateStagePath = context.stateStagePath;
          displacedCanonical = `${stateStagePath}.published`;
          displacedStage = `${stateStagePath}.predecessor`;
          await rename(statePath, displacedCanonical);
          await writeFile(statePath, successorState, { flag: "wx", mode: 0o600 });
          await rename(stateStagePath, displacedStage);
          await writeFile(stateStagePath, successorState, { flag: "wx", mode: 0o600 });
        },
      },
    }),
    (error: unknown) => {
      const failure = error as Error & {
        code?: string;
        committed?: boolean;
        committedPath?: string;
        successorPreserved?: boolean;
        recoveryPaths?: string[];
        attemptedPaths?: string[];
        originalEvidence?: "verified" | "unknown";
      };
      assert.equal(failure.code, "RELEASE_SELECTION_SUCCESSOR_PRESERVED");
      assert.equal(failure.committed, true);
      assert.equal(failure.committedPath, linkPath);
      assert.equal(failure.successorPreserved, true);
      assert.equal(failure.recoveryPaths?.includes(statePath), false);
      assert.equal(failure.recoveryPaths?.includes(stateStagePath), false);
      assert.ok(failure.recoveryPaths?.includes(linkPath));
      assert.ok(failure.attemptedPaths?.includes(statePath));
      assert.ok(failure.attemptedPaths?.includes(stateStagePath));
      assert.equal(failure.originalEvidence, "verified");
      return true;
    },
  );

  assert.equal(await readFile(statePath, "utf8"), successorState);
  assert.equal(await readFile(stateStagePath, "utf8"), successorState);
  assert.equal(JSON.parse(await readFile(displacedCanonical, "utf8")).releaseId, "release-selected");
  assert.equal(JSON.parse(await readFile(displacedStage, "utf8")).releaseId, "release-selected");
  assert.equal(path.resolve(path.dirname(linkPath), await readlink(linkPath)), release.installedPath);
});

test("release reselection never adopts a same-path successor as the predecessor to isolate", async () => {
  const fixture = await selectionFixture("cpb-release-select-pre-isolation-aba-");
  await createRelease(fixture.releaseStoreRoot, "release-first");
  await createRelease(fixture.releaseStoreRoot, "release-second");
  await selectRelease({ releaseId: "release-first", destRoot: fixture.releaseStoreRoot, env: fixture.env });
  const statePath = currentReleaseStatePath({ env: fixture.env });
  const linkPath = currentReleaseLinkPath({ env: fixture.env });
  const predecessorState = `${statePath}.predecessor`;
  const predecessorLink = `${linkPath}.predecessor`;
  const successorTarget = path.join(fixture.root, "successor-release");
  const successorState = `${JSON.stringify({ releaseId: "successor", releasePath: successorTarget })}\n`;
  let stateStagePath = "";
  let linkStagePath = "";
  await mkdir(successorTarget);

  await assert.rejects(
    selectRelease({
      releaseId: "release-second",
      destRoot: fixture.releaseStoreRoot,
      env: fixture.env,
      hooksForTest: {
        beforeStateIsolation: async (context) => {
          stateStagePath = context.stateStagePath;
          linkStagePath = context.linkStagePath;
          await rename(statePath, predecessorState);
          await rename(linkPath, predecessorLink);
          await writeFile(statePath, successorState, { flag: "wx", mode: 0o600 });
          await symlink(successorTarget, linkPath);
        },
      },
    }),
    (error: unknown) => {
      const failure = error as Error & {
        code?: string;
        committed?: boolean;
        successorPreserved?: boolean;
        recoveryPaths?: string[];
        attemptedPaths?: string[];
        originalEvidence?: "verified" | "unknown";
      };
      assert.equal(failure.code, "RELEASE_SELECTION_SUCCESSOR_PRESERVED");
      assert.equal(failure.committed, false);
      assert.equal(failure.successorPreserved, true);
      assert.equal(failure.recoveryPaths?.includes(statePath), false);
      assert.equal(failure.recoveryPaths?.includes(linkPath), false);
      assert.ok(failure.attemptedPaths?.includes(statePath));
      assert.ok(failure.attemptedPaths?.includes(linkPath));
      assert.ok(failure.recoveryPaths?.includes(stateStagePath));
      assert.ok(failure.recoveryPaths?.includes(linkStagePath));
      assert.deepEqual(
        failure.recoveryPaths?.filter((candidate) => failure.attemptedPaths?.includes(candidate)),
        [],
      );
      assert.equal(failure.originalEvidence, "verified");
      return true;
    },
  );

  assert.equal(await readFile(statePath, "utf8"), successorState);
  assert.equal(path.resolve(path.dirname(linkPath), await readlink(linkPath)), successorTarget);
  assert.equal(JSON.parse(await readFile(stateStagePath, "utf8")).releaseId, "release-second");
  assert.equal(
    path.resolve(path.dirname(linkStagePath), await readlink(linkStagePath)),
    path.join(fixture.releaseStoreRoot, "release-second"),
  );
  assert.equal(JSON.parse(await readFile(predecessorState, "utf8")).releaseId, "release-first");
  assert.equal(path.resolve(path.dirname(predecessorLink), await readlink(predecessorLink)), path.join(fixture.releaseStoreRoot, "release-first"));
});

test("release selection reports a committed recovery path when parent fsync fails", async () => {
  const fixture = await selectionFixture("cpb-release-select-fsync-");
  const release = await createRelease(fixture.releaseStoreRoot, "release-selected");
  const linkPath = currentReleaseLinkPath({ env: fixture.env });

  await assert.rejects(
    selectRelease({
      releaseId: "release-selected",
      destRoot: fixture.releaseStoreRoot,
      env: fixture.env,
      hooksForTest: {
        syncDirectory: async ({ phase }) => {
          if (phase === "link-publication") throw new Error("injected fsync failure");
        },
      },
    }),
    (error: unknown) => {
      const failure = error as Error & {
        code?: string;
        committed?: boolean;
        committedPath?: string;
        recoveryPaths?: string[];
      };
      assert.equal(failure.code, "RELEASE_SELECTION_COMMITTED_DURABILITY_AMBIGUOUS");
      assert.equal(failure.committed, true);
      assert.equal(failure.committedPath, linkPath);
      assert.ok(failure.recoveryPaths?.some((candidate) => candidate.endsWith(`${path.sep}next-link`)));
      return true;
    },
  );

  assert.equal(path.resolve(path.dirname(linkPath), await readlink(linkPath)), release.installedPath);
});

test("release reselection isolates and retains the complete previous state/link generation", async () => {
  const fixture = await selectionFixture("cpb-release-select-generation-");
  const first = await createRelease(fixture.releaseStoreRoot, "release-first");
  const second = await createRelease(fixture.releaseStoreRoot, "release-second");
  await selectRelease({ releaseId: "release-first", destRoot: fixture.releaseStoreRoot, env: fixture.env });

  const result = await selectRelease({
    releaseId: "release-second",
    destRoot: fixture.releaseStoreRoot,
    env: fixture.env,
  });
  const operationDir = result.recoveryPaths[0];
  const previousState = JSON.parse(await readFile(path.join(operationDir, "previous-state.json"), "utf8"));
  const previousTarget = path.resolve(operationDir, await readlink(path.join(operationDir, "previous-link")));

  assert.equal(previousState.releaseId, "release-first");
  assert.equal(previousState.releasePath, first.installedPath);
  assert.equal(previousTarget, first.installedPath);
  assert.equal(JSON.parse(await readFile(currentReleaseStatePath({ env: fixture.env }), "utf8")).releaseId, "release-second");
  assert.equal(
    path.resolve(path.dirname(currentReleaseLinkPath({ env: fixture.env })), await readlink(currentReleaseLinkPath({ env: fixture.env }))),
    second.installedPath,
  );
});

test("concurrent selections with the same timestamp publish one internally consistent pair at a time", async () => {
  const fixture = await selectionFixture("cpb-release-select-concurrent-");
  const first = await createRelease(fixture.releaseStoreRoot, "release-first");
  const second = await createRelease(fixture.releaseStoreRoot, "release-second");
  const now = new Date("2026-07-21T12:34:56.000Z");

  const results = await Promise.all([
    selectRelease({ releaseId: "release-first", destRoot: fixture.releaseStoreRoot, env: fixture.env, now }),
    selectRelease({ releaseId: "release-second", destRoot: fixture.releaseStoreRoot, env: fixture.env, now }),
  ]);
  assert.equal(results.length, 2);

  const state = JSON.parse(await readFile(currentReleaseStatePath({ env: fixture.env }), "utf8"));
  const target = path.resolve(
    path.dirname(currentReleaseLinkPath({ env: fixture.env })),
    await readlink(currentReleaseLinkPath({ env: fixture.env })),
  );
  assert.equal(target, state.releasePath);
  const expectedTarget = state.releaseId === "release-first"
    ? first.installedPath
    : state.releaseId === "release-second"
      ? second.installedPath
      : null;
  assert.ok(expectedTarget);
  assert.equal(target, expectedTarget);
  assert.ok([first.installedPath, second.installedPath].includes(target));
});
