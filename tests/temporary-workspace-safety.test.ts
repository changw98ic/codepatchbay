import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { chmod, lstat, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  _internalWithTemporaryWorkspaceHooks,
  createTemporaryGitWorktree,
  temporaryWorkspaceErrorDetails,
  type TemporaryWorkspaceCleanupProof,
  type TemporaryWorkspaceRecoveryPaths,
} from "../core/runtime/temporary-workspace.js";
import { tempRoot } from "./helpers.js";

const execFile = promisify(execFileCb);

async function repository() {
  const cwd = await tempRoot("cpb-temporary-workspace-source");
  await execFile("git", ["init", "-q"], { cwd });
  await execFile("git", ["config", "user.email", "temporary-workspace@example.test"], { cwd });
  await execFile("git", ["config", "user.name", "Temporary Workspace Test"], { cwd });
  await writeFile(path.join(cwd, "tracked.txt"), "base\n", "utf8");
  await execFile("git", ["add", "tracked.txt"], { cwd });
  await execFile("git", ["commit", "-q", "-m", "base"], { cwd });
  return cwd;
}

async function exists(target: string) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function captureError(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return error;
  }
  assert.fail("expected operation to reject");
}

async function removeRecoveryPaths(value: unknown) {
  const details = temporaryWorkspaceErrorDetails(value);
  const recoveryPaths: TemporaryWorkspaceRecoveryPaths = details?.recoveryPaths || { canonicalRoot: "" };
  const candidates = [
    recoveryPaths.quarantineContainer,
    recoveryPaths.quarantineRoot,
    recoveryPaths.canonicalRoot,
    recoveryPaths.canonicalWorktree ? path.dirname(recoveryPaths.canonicalWorktree) : null,
  ].filter((entry): entry is string => Boolean(entry));
  for (const candidate of [...new Set(candidates)]) {
    const basename = path.basename(candidate);
    if (!basename.startsWith("cpb-") || !path.resolve(candidate).startsWith(path.resolve(tmpdir()))) continue;
    await rm(candidate, { recursive: true, force: true });
  }
}

async function dispose(cwd: string, value?: unknown) {
  await removeRecoveryPaths(value);
  await execFile("git", ["worktree", "prune", "--expire", "now"], { cwd }).catch(() => null);
  await rm(cwd, { recursive: true, force: true });
}

test("temporary Git worktree cleanup quarantines exact ownership and never invokes unsafe Git removal", async () => {
  const cwd = await repository();
  const wrapperRoot = await tempRoot("cpb-temporary-workspace-git-wrapper");
  const bin = path.join(wrapperRoot, "bin");
  const log = path.join(wrapperRoot, "git.log");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "git"), `#!/bin/sh
if [ -n "$CPB_TEMPORARY_SECRET" ]; then
  echo "secret leaked into Git child" >&2
  exit 96
fi
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
if [ "$1" = "worktree" ] && { [ "$2" = "remove" ] || [ "$2" = "prune" ]; }; then
  echo "unsafe worktree cleanup invoked" >&2
  exit 97
fi
exec /usr/bin/git "$@"
`, "utf8");
  await chmod(path.join(bin, "git"), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:/usr/bin:/bin`,
    CPB_TEMPORARY_SECRET: "must-not-reach-git-children",
  };
  let proof: TemporaryWorkspaceCleanupProof | undefined;
  let adminDir = "";
  let worktreePath = "";
  try {
    const workspace = await createTemporaryGitWorktree({
      sourcePath: cwd,
      revision: "HEAD",
      prefix: "cpb-temporary-workspace-remove-proof-",
      env,
    });
    worktreePath = workspace.worktreePath;
    adminDir = (await execFile("git", ["rev-parse", "--absolute-git-dir"], {
      cwd: workspace.worktreePath,
    })).stdout.trim();
    proof = await workspace.cleanup();
    assert.equal(proof.disposition, "quarantined");
    assert.equal(proof.committed, true);
    assert.equal(proof.canonicalPathRemoved, true);
    assert.equal(proof.quarantinePreserved, true);
    assert.equal(proof.gitMetadataRetained, true);
    assert.equal(proof.gitRegistrationActive, false);
    assert.equal(proof.gitAdminMetadataDisposition, "quarantined");
    assert.equal(proof.gitAdminQuarantinePreserved, true);
    assert.equal(proof.cleanupDeferred, true);
    assert.equal(await exists(proof.recoveryPaths.quarantineContainer as string), true);
    assert.equal(await exists(proof.recoveryPaths.quarantineRoot as string), true);
    assert.equal(
      path.dirname(proof.recoveryPaths.quarantineRoot as string),
      proof.recoveryPaths.quarantineContainer,
    );
    assert.equal(await exists(proof.recoveryPaths.quarantineGitAdminDir as string), true);
    assert.equal(await exists(adminDir), false);
    assert.equal(await exists(workspace.rootPath), false);
    const worktreeList = (await execFile("git", ["worktree", "list", "--porcelain"], { cwd })).stdout;
    assert.equal(worktreeList.includes(`worktree ${worktreePath}\n`), false);
    assert.doesNotMatch(await readFile(log, "utf8"), /worktree (?:remove|prune)/);
    assert.equal(proof.authority.dispositions.commonDir, "preserved_unmodified");
    assert.equal(proof.authority.dispositions.commonConfig, "preserved_unmodified");
    assert.equal(proof.authority.dispositions.gitAdmin, "quarantined");
    assert.equal(proof.authority.gitAdmin?.path, adminDir);
    assert.match(proof.authority.commonConfig?.sha256 || "", /^[0-9a-f]{64}$/);
  } finally {
    await dispose(cwd, proof);
    await rm(wrapperRoot, { recursive: true, force: true });
  }
});

test("temporary Git worktree cleanup preserves a replay-path successor", async () => {
  const cwd = await repository();
  let failure: unknown;
  try {
    const workspace = await createTemporaryGitWorktree({
      sourcePath: cwd,
      revision: "HEAD",
      prefix: "cpb-temporary-workspace-replay-successor-",
    });
    const moved = `${workspace.worktreePath}.owned`;
    await rename(workspace.worktreePath, moved);
    await mkdir(workspace.worktreePath);
    await writeFile(path.join(workspace.worktreePath, "successor.txt"), "preserve\n", "utf8");

    failure = await captureError(() => workspace.cleanup());
    const details = temporaryWorkspaceErrorDetails(failure);
    assert.equal(details?.code, "TEMPORARY_WORKSPACE_OWNERSHIP_CONFLICT");
    assert.equal(details?.committed, false);
    assert.equal(details?.disposition, "retained");
    assert.equal(details?.successorPreserved, true);
    assert.equal(await readFile(path.join(workspace.worktreePath, "successor.txt"), "utf8"), "preserve\n");
    assert.equal(await exists(moved), true);
  } finally {
    await dispose(cwd, failure);
  }
});

test("temporary workspace cleanup fails closed when the quarantine destination appears after ownership validation", async () => {
  const cwd = await repository();
  let failure: unknown;
  let hostileQuarantine = "";
  let hostileIdentity: { dev: string; ino: string; birthtimeNs: string } | null = null;
  try {
    failure = await _internalWithTemporaryWorkspaceHooks({
      async afterOwnershipValidated({ quarantineRoot }) {
        hostileQuarantine = quarantineRoot;
        await mkdir(quarantineRoot);
        const stats = await lstat(quarantineRoot, { bigint: true });
        hostileIdentity = {
          dev: String(stats.dev),
          ino: String(stats.ino),
          birthtimeNs: String(stats.birthtimeNs),
        };
      },
    }, async () => {
      const workspace = await createTemporaryGitWorktree({
        sourcePath: cwd,
        revision: "HEAD",
        prefix: "cpb-temporary-workspace-quarantine-conflict-",
      });
      const captured = await captureError(() => workspace.cleanup());
      const details = temporaryWorkspaceErrorDetails(captured);
      assert.equal(details?.code, "TEMPORARY_WORKSPACE_QUARANTINE_CONFLICT");
      assert.equal(details?.committed, false);
      assert.equal(details?.disposition, "retained");
      assert.equal(details?.canonicalPathRemoved, false);
      assert.equal(await exists(workspace.rootPath), true);
      return captured;
    });

    assert.notEqual(hostileQuarantine, "");
    const preserved = await lstat(hostileQuarantine, { bigint: true });
    assert.deepEqual(
      {
        dev: String(preserved.dev),
        ino: String(preserved.ino),
        birthtimeNs: String(preserved.birthtimeNs),
      },
      hostileIdentity,
    );
    const details = temporaryWorkspaceErrorDetails(failure);
    assert.equal(details?.recoveryPaths.quarantineRoot, undefined);
    assert.equal(details?.recoveryPaths.quarantineContainer, undefined);
  } finally {
    await dispose(cwd, failure);
    if (hostileQuarantine) await rm(hostileQuarantine, { recursive: true, force: true });
  }
});

test("temporary Git worktree cleanup preserves a replaced or symlinked root lineage", async () => {
  const cwd = await repository();
  let failure: unknown;
  let movedRoot = "";
  try {
    const workspace = await createTemporaryGitWorktree({
      sourcePath: cwd,
      revision: "HEAD",
      prefix: "cpb-temporary-workspace-root-successor-",
    });
    movedRoot = `${workspace.rootPath}.owned`;
    const successor = `${workspace.rootPath}.successor`;
    await rename(workspace.rootPath, movedRoot);
    await mkdir(successor);
    await writeFile(path.join(successor, "successor.txt"), "preserve\n", "utf8");
    await symlink(successor, workspace.rootPath, "dir");

    failure = await captureError(() => workspace.cleanup());
    const details = temporaryWorkspaceErrorDetails(failure);
    assert.equal(details?.code, "TEMPORARY_WORKSPACE_OWNERSHIP_CONFLICT");
    assert.equal(details?.committed, false);
    assert.equal(details?.disposition, "retained");
    assert.equal(details?.successorPreserved, true);
    assert.equal(await readFile(path.join(workspace.rootPath, "successor.txt"), "utf8"), "preserve\n");
    assert.equal(await exists(movedRoot), true);
  } finally {
    await dispose(cwd, failure);
    if (movedRoot) await rm(movedRoot, { recursive: true, force: true });
  }
});

test("temporary Git worktree cleanup rejects registration and config tampering without mutation", async () => {
  for (const tamper of ["registration", "config"] as const) {
    const cwd = await repository();
    let failure: unknown;
    try {
      const workspace = await createTemporaryGitWorktree({
        sourcePath: cwd,
        revision: "HEAD",
        prefix: `cpb-temporary-workspace-${tamper}-`,
      });
      if (tamper === "registration") {
        const adminDir = (await execFile("git", ["rev-parse", "--absolute-git-dir"], {
          cwd: workspace.worktreePath,
        })).stdout.trim();
        await writeFile(path.join(adminDir, "gitdir"), `${path.join(cwd, "forged.git")}\n`, "utf8");
      } else {
        await writeFile(path.join(cwd, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = true\n", "utf8");
      }

      failure = await captureError(() => workspace.cleanup());
      const details = temporaryWorkspaceErrorDetails(failure);
      assert.equal(details?.code, "TEMPORARY_WORKSPACE_GIT_BINDING_CONFLICT");
      assert.equal(details?.committed, false);
      assert.equal(details?.disposition, "retained");
      assert.equal(await exists(workspace.rootPath), true);
    } finally {
      await dispose(cwd, failure);
    }
  }
});

test("temporary Git worktree cleanup rejects common-directory replacement without deleting either generation", async () => {
  const cwd = await repository();
  const commonDir = path.join(cwd, ".git");
  const movedCommon = `${commonDir}.owned`;
  let failure: unknown;
  try {
    const workspace = await createTemporaryGitWorktree({
      sourcePath: cwd,
      revision: "HEAD",
      prefix: "cpb-temporary-workspace-common-successor-",
    });
    await rename(commonDir, movedCommon);
    await mkdir(commonDir);
    await writeFile(path.join(commonDir, "successor.txt"), "preserve\n", "utf8");

    failure = await captureError(() => workspace.cleanup());
    const details = temporaryWorkspaceErrorDetails(failure);
    assert.equal(details?.code, "TEMPORARY_WORKSPACE_OWNERSHIP_CONFLICT");
    assert.equal(details?.committed, false);
    assert.equal(details?.disposition, "retained");
    assert.equal(details?.successorPreserved, true);
    assert.equal(await readFile(path.join(commonDir, "successor.txt"), "utf8"), "preserve\n");
    assert.equal(await exists(movedCommon), true);
  } finally {
    await removeRecoveryPaths(failure);
    await rm(commonDir, { recursive: true, force: true });
    await rm(movedCommon, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("post-quarantine failure reports the committed recovery path", async () => {
  const cwd = await repository();
  let failure: unknown;
  try {
    failure = await _internalWithTemporaryWorkspaceHooks({
      afterQuarantineRename() {
        throw new Error("simulated post-quarantine failure");
      },
    }, async () => {
      const workspace = await createTemporaryGitWorktree({
        sourcePath: cwd,
        revision: "HEAD",
        prefix: "cpb-temporary-workspace-post-commit-",
      });
      return await captureError(() => workspace.cleanup());
    });
    const details = temporaryWorkspaceErrorDetails(failure);
    assert.equal(details?.code, "TEMPORARY_WORKSPACE_QUARANTINE_PRESERVED");
    assert.equal(details?.committed, true);
    assert.equal(details?.disposition, "quarantined");
    assert.equal(details?.quarantinePreserved, true);
    assert.equal(details?.canonicalPathRemoved, true);
    assert.equal(details?.gitRegistrationActive, true);
    assert.equal(details?.gitAdminMetadataDisposition, "active");
    assert.equal(details?.gitAdminQuarantinePreserved, false);
    assert.match(details?.recoveryPaths.quarantineRoot || "", /cpb-temporary-workspace-post-commit-/);
    assert.equal(await exists(details?.recoveryPaths.quarantineRoot || ""), true);
  } finally {
    await dispose(cwd, failure);
  }
});

test("post-admin-quarantine failure reports detached registration and exact retained admin generation", async () => {
  const cwd = await repository();
  let failure: unknown;
  let worktreePath = "";
  try {
    failure = await _internalWithTemporaryWorkspaceHooks({
      afterGitAdminQuarantine(context) {
        assert.equal(context.worktreePath, worktreePath);
        throw new Error("simulated post-admin-quarantine failure");
      },
    }, async () => {
      const workspace = await createTemporaryGitWorktree({
        sourcePath: cwd,
        revision: "HEAD",
        prefix: "cpb-temporary-workspace-post-admin-commit-",
      });
      worktreePath = workspace.worktreePath;
      return await captureError(() => workspace.cleanup());
    });
    const details = temporaryWorkspaceErrorDetails(failure);
    assert.equal(details?.code, "TEMPORARY_WORKSPACE_QUARANTINE_PRESERVED");
    assert.equal(details?.committed, true);
    assert.equal(details?.cleanupVerified, false);
    assert.equal(details?.gitRegistrationActive, false);
    assert.equal(details?.gitAdminMetadataDisposition, "quarantined");
    assert.equal(details?.gitAdminQuarantinePreserved, true);
    assert.equal(details?.authority.dispositions.gitAdmin, "quarantined");
    assert.equal(await exists(details?.recoveryPaths.quarantineGitAdminDir || ""), true);
    const worktreeList = (await execFile("git", ["worktree", "list", "--porcelain"], { cwd })).stdout;
    assert.equal(worktreeList.includes(`worktree ${worktreePath}\n`), false);
  } finally {
    await dispose(cwd, failure);
  }
});

test("a worktree-add command that commits then fails reports creation and cleanup truth", async () => {
  const cwd = await repository();
  const wrapperRoot = await tempRoot("cpb-temporary-workspace-add-wrapper");
  const bin = path.join(wrapperRoot, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "git"), `#!/bin/sh
if [ "$1 $2" = "worktree add" ]; then
  /usr/bin/git "$@" || exit $?
  echo "simulated lost success reply" >&2
  exit 98
fi
exec /usr/bin/git "$@"
`, "utf8");
  await chmod(path.join(bin, "git"), 0o755);
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin` };
  let failure: unknown;
  try {
    failure = await captureError(() => createTemporaryGitWorktree({
      sourcePath: cwd,
      revision: "HEAD",
      prefix: "cpb-temporary-workspace-add-ambiguous-",
      env,
    }));
    const details = temporaryWorkspaceErrorDetails(failure);
    assert.equal(details?.creationCommitted, true);
    assert.equal(details?.committed, true);
    assert.equal(details?.disposition, "quarantined");
    assert.equal(details?.quarantinePreserved, true);
    assert.equal(await exists(details?.recoveryPaths.quarantineRoot || ""), true);
  } finally {
    await dispose(cwd, failure);
    await rm(wrapperRoot, { recursive: true, force: true });
  }
});

test("temporary worktree creation never executes a configured post-checkout hook", async () => {
  const cwd = await repository();
  const hooks = path.join(cwd, "hooks");
  const hookLog = path.join(cwd, "post-checkout.log");
  await mkdir(hooks);
  await writeFile(path.join(hooks, "post-checkout"), `#!/bin/sh
printf 'hook executed with secret=%s\n' "$CPB_TEMPORARY_SECRET" > ${JSON.stringify(hookLog)}
`, "utf8");
  await chmod(path.join(hooks, "post-checkout"), 0o755);
  await execFile("git", ["config", "core.hooksPath", hooks], { cwd });
  let proof: TemporaryWorkspaceCleanupProof | undefined;
  try {
    const workspace = await createTemporaryGitWorktree({
      sourcePath: cwd,
      revision: "HEAD",
      prefix: "cpb-temporary-workspace-checkout-hook-",
      env: { ...process.env, CPB_TEMPORARY_SECRET: "must-not-reach-git-children" },
    });
    assert.equal(await exists(hookLog), false);
    assert.equal(await readFile(path.join(workspace.worktreePath, "tracked.txt"), "utf8"), "base\n");
    proof = await workspace.cleanup();
    assert.equal(proof.gitRegistrationActive, false);
  } finally {
    await dispose(cwd, proof);
  }
});

test("temporary worktree checkout disables configured filter processes", async () => {
  const cwd = await repository();
  const filterLog = path.join(cwd, "filter.log");
  const filterScript = path.join(cwd, "hostile-smudge.sh");
  await writeFile(path.join(cwd, ".gitattributes"), "filtered.txt filter=hostile\n", "utf8");
  await writeFile(path.join(cwd, "filtered.txt"), "unfiltered\n", "utf8");
  await execFile("git", ["add", ".gitattributes", "filtered.txt"], { cwd });
  await execFile("git", ["commit", "-q", "-m", "add filtered path"], { cwd });
  await writeFile(filterScript, `#!/bin/sh
printf 'filter executed\n' > ${JSON.stringify(filterLog)}
cat
`, "utf8");
  await chmod(filterScript, 0o755);
  await execFile("git", ["config", "filter.hostile.smudge", `/bin/sh ${JSON.stringify(filterScript)}`], { cwd });
  await execFile("git", ["config", "filter.hostile.required", "true"], { cwd });
  let proof: TemporaryWorkspaceCleanupProof | undefined;
  try {
    const workspace = await createTemporaryGitWorktree({
      sourcePath: cwd,
      revision: "HEAD",
      prefix: "cpb-temporary-workspace-filter-",
      env: { ...process.env, CPB_FILTER_SECRET: "must-not-reach-git-children" },
    });
    assert.equal(await exists(filterLog), false);
    assert.equal(await readFile(path.join(workspace.worktreePath, "filtered.txt"), "utf8"), "unfiltered\n");
    proof = await workspace.cleanup();
    assert.equal(proof.gitRegistrationActive, false);
  } finally {
    await dispose(cwd, proof);
  }
});
