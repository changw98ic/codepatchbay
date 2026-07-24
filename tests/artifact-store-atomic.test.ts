import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  type ArtifactStoreTestHooks,
  isArtifactCommitOutcome,
  prepareArtifactWrite,
  withArtifactStoreTestHooks,
  writeArtifact,
} from "../core/artifacts/artifact-store.js";

function codedError(error: unknown, code: string): (Error & {
  code?: string;
  committed?: boolean;
  committedPath?: string;
  recoveryPaths?: string[];
}) | null {
  const seen = new Set<unknown>();
  const visit = (value: unknown): ReturnType<typeof codedError> => {
    if (!value || typeof value !== "object" || seen.has(value)) return null;
    seen.add(value);
    const candidate = value as Error & {
      code?: string;
      cause?: unknown;
      cleanupErrors?: unknown[];
      errors?: unknown[];
    };
    if (candidate.code === code) return candidate;
    for (const nested of [
      ...(candidate instanceof AggregateError ? candidate.errors : []),
      ...(Array.isArray(candidate.cleanupErrors) ? candidate.cleanupErrors : []),
      candidate.cause,
    ]) {
      const found = visit(nested);
      if (found) return found;
    }
    return null;
  };
  return visit(error);
}

async function tempRoot() {
  return mkdtemp(path.join(tmpdir(), "cpb-artifact-store-"));
}

async function exists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return false;
    throw error;
  }
}

async function outputEntries(dataRoot: string) {
  try {
    return await readdir(path.join(dataRoot, "wiki", "outputs"));
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return [];
    throw error;
  }
}

function canonicalLockEntries(entries: string[]) {
  return entries.filter((entry) => entry.startsWith(".lock-") && !entry.includes(".cleanup-"));
}

function preservedLockEntries(entries: string[]) {
  return entries.filter((entry) => entry.startsWith(".lock-") && entry.includes(".cleanup-"));
}

function tempEntries(entries: string[]) {
  return entries.filter((entry) => entry.includes(".tmp"));
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function committedArtifact<T extends { path: string }>(value: T | { artifact: T }): T {
  if ("artifact" in value) return value.artifact;
  return value;
}

test("pre-aborted artifact write preserves the Error reason, cause, and code", async () => {
  const dataRoot = await tempRoot();
  const controller = new AbortController();
  const reason = Object.assign(new Error("stop before allocation"), { code: "STOP_REQUESTED" });
  controller.abort(reason);

  try {
    await assert.rejects(
      writeArtifact("/unused", {
        project: "p",
        jobId: "j",
        kind: "verdict",
        content: "never written",
        dataRoot,
        signal: controller.signal,
      }),
      (error) => {
        assert.equal((error as Error).name, "AbortError");
        assert.equal((error as Error).message, reason.message);
        assert.equal((error as Error & { code?: string }).code, reason.code);
        assert.equal((error as Error & { cause?: unknown }).cause, reason);
        return true;
      },
    );
    assert.equal(await exists(path.join(dataRoot, "wiki", "outputs")), false);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("artifact kind path traversal is rejected before any artifact path is created", async () => {
  const sandboxRoot = await tempRoot();
  const dataRoot = path.join(sandboxRoot, "runtime", "project");
  const originalNow = Date.now;
  const fixedNow = 123456789012;
  const id = String(fixedNow).slice(-6);
  const escapedPath = path.join(sandboxRoot, "runtime", `escape-${id}.md`);

  Date.now = () => fixedNow;
  try {
    await assert.rejects(
      writeArtifact("/unused", {
        project: "p",
        jobId: "j",
        kind: "../../../escape",
        content: "must remain inside the artifact directory\n",
        dataRoot,
      }),
      (error) => {
        assert.equal((error as Error & { code?: string }).code, "ARTIFACT_KIND_INVALID");
        assert.match((error as Error).message, /invalid artifact kind/);
        return true;
      },
    );
    assert.equal(await exists(escapedPath), false);
    assert.equal(await exists(path.join(dataRoot, "wiki")), false);
  } finally {
    Date.now = originalNow;
    await rm(sandboxRoot, { recursive: true, force: true });
  }
});

test("artifact kind grammar accepts current underscore and hyphenated caller forms", async () => {
  const dataRoot = await tempRoot();

  try {
    for (const kind of ["adversarial_verdict", "baseline-test-contract-verdict"]) {
      const artifact = await writeArtifact("/unused", {
        project: "p",
        jobId: "j",
        kind,
        content: `${kind}\n`,
        dataRoot,
      });
      assert.equal(artifact.kind, kind);
      assert.equal(path.dirname(artifact.path), path.join(dataRoot, "wiki", "outputs"));
      assert.equal(await readFile(artifact.path, "utf8"), `${kind}\n`);
    }
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("artifact temp path containment rejects a path that escapes the authoritative directory", async () => {
  const dataRoot = await tempRoot();
  let escapedPath = "";

  try {
    await assert.rejects(
      withArtifactStoreTestHooks({
        createTempSuffix: () => "../../../escape",
      }, () => prepareArtifactWrite("/unused", {
        project: "p",
        jobId: "j",
        kind: "review",
        content: "must never reach an escaped temp path\n",
        dataRoot,
      })),
      (error) => {
        const containmentError = error as Error & { code?: string; artifactPath?: string };
        assert.equal(containmentError.code, "ARTIFACT_PATH_OUTSIDE_DIRECTORY");
        assert.match(containmentError.message, /temp path escapes/);
        escapedPath = containmentError.artifactPath || "";
        return true;
      },
    );
    assert.notEqual(escapedPath, "");
    assert.equal(await exists(escapedPath), false);
    assert.deepEqual(canonicalLockEntries(await outputEntries(dataRoot)), []);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("owner-file write failure removes the lock directory created by this reservation", async () => {
  const dataRoot = await tempRoot();
  const ownerFailure = Object.assign(new Error("owner metadata write failed"), { code: "EIO" });

  try {
    await assert.rejects(
      withArtifactStoreTestHooks({
        writeOwnerFile: async () => { throw ownerFailure; },
      }, () => prepareArtifactWrite("/unused", {
        project: "p",
        jobId: "j",
        kind: "review",
        content: "never prepared",
        dataRoot,
      })),
      (error) => error === ownerFailure,
    );
    assert.deepEqual(canonicalLockEntries(await outputEntries(dataRoot)), []);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("owner-file EEXIST retries without leaking any owner-created lock", async () => {
  const dataRoot = await tempRoot();
  let attempts = 0;

  try {
    await assert.rejects(
      withArtifactStoreTestHooks({
        writeOwnerFile: async () => {
          attempts += 1;
          throw Object.assign(new Error("owner already exists"), { code: "EEXIST" });
        },
      }, () => prepareArtifactWrite("/unused", {
        project: "p",
        jobId: "j",
        kind: "review",
        content: "never prepared",
        dataRoot,
      })),
      /unable to allocate artifact id/,
    );
    assert.equal(attempts, 30);
    assert.deepEqual(canonicalLockEntries(await outputEntries(dataRoot)), []);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("failure while deriving the temp path after allocation cleans the reservation receipt", async () => {
  const dataRoot = await tempRoot();
  const suffixFailure = new Error("temp suffix failed");

  try {
    await assert.rejects(
      withArtifactStoreTestHooks({
        createTempSuffix: () => { throw suffixFailure; },
      }, () => prepareArtifactWrite("/unused", {
        project: "p",
        jobId: "j",
        kind: "review",
        content: "never prepared",
        dataRoot,
      })),
      (error) => error === suffixFailure,
    );
    assert.deepEqual(canonicalLockEntries(await outputEntries(dataRoot)), []);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("abort after reservation cleans the owner lock and leaves no artifact", async () => {
  const dataRoot = await tempRoot();
  const controller = new AbortController();
  let observed: { path: string; lockDir: string } | null = null;

  try {
    await assert.rejects(
      withArtifactStoreTestHooks({
        afterReservation: async (context) => {
          observed = context;
          assert.equal(await exists(context.lockDir), true);
          controller.abort(new Error("stop after reservation"));
        },
      }, () => prepareArtifactWrite("/unused", {
        project: "p",
        jobId: "j",
        kind: "review",
        content: "reserved review",
        dataRoot,
        signal: controller.signal,
      })),
      { name: "AbortError" },
    );
    assert.ok(observed);
    assert.equal(await exists(observed.path), false);
    assert.equal(await exists(observed.lockDir), false);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("content serialization failure after reservation cleans the owner lock", async () => {
  const dataRoot = await tempRoot();
  let observed: { path: string; lockDir: string } | null = null;

  try {
    await assert.rejects(
      withArtifactStoreTestHooks({
        afterReservation: async (context) => { observed = context; },
      }, () => prepareArtifactWrite("/unused", {
        project: "p",
        jobId: "j",
        kind: "review",
        content: null as unknown as string,
        dataRoot,
      })),
      /string/,
    );
    assert.ok(observed);
    assert.equal(await exists(observed.lockDir), false);
    assert.equal(await exists(observed.path), false);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("aborted commit before the hard link removes temp, final, and lock", async () => {
  const dataRoot = await tempRoot();
  const controller = new AbortController();
  let observed: { path: string; tempPath: string; lockDir: string } | null = null;

  try {
    const prepared = await withArtifactStoreTestHooks({
      afterTempWrite: async (context) => {
        observed = context;
        controller.abort(new Error("stop before final commit"));
      },
    }, () => prepareArtifactWrite("/unused", {
      project: "p",
      jobId: "j",
      kind: "review",
      content: "draft review",
      dataRoot,
      signal: controller.signal,
    }));

    await assert.rejects(prepared.commit(), { name: "AbortError" });
    assert.ok(observed);
    assert.equal(await exists(observed.path), false);
    assert.equal(await exists(observed.tempPath), false);
    assert.equal(await exists(observed.lockDir), false);
    assert.deepEqual(preservedLockEntries(await outputEntries(dataRoot)), []);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("abort after the hard-link commit point returns the published artifact", async () => {
  const dataRoot = await tempRoot();
  const controller = new AbortController();
  let observed: { path: string; tempPath: string; lockDir: string } | null = null;

  try {
    const prepared = await withArtifactStoreTestHooks({
      afterFinalLink: async (context) => {
        observed = context;
        assert.equal(await exists(context.path), true);
        controller.abort(new Error("stop after final link"));
      },
    }, () => prepareArtifactWrite("/unused", {
      project: "p",
      jobId: "j",
      kind: "verdict",
      content: "linked verdict",
      dataRoot,
      signal: controller.signal,
    }));

    const artifact = await prepared.commit();
    assert.equal(isArtifactCommitOutcome(artifact), false);
    assert.deepEqual(artifact, prepared.artifact);
    assert.ok(observed);
    assert.equal(await readFile(observed.path, "utf8"), "linked verdict");
    assert.equal(await exists(observed.tempPath), false);
    assert.equal(await exists(observed.lockDir), false);
    assert.deepEqual(preservedLockEntries(await outputEntries(dataRoot)), []);
    assert.deepEqual(committedArtifact(await prepared.commit()), prepared.artifact);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("post-commit cleanup failure stays pending until a retry finishes the same cleanup", async () => {
  const dataRoot = await tempRoot();
  let observed: { path: string; tempPath: string; lockDir: string } | null = null;

  try {
    const prepared = await withArtifactStoreTestHooks({
      afterFinalLink: async (context) => {
        observed = context;
        await rm(context.tempPath);
        await mkdir(context.tempPath);
        await writeFile(path.join(context.tempPath, "blocked"), "force cleanup failure\n", "utf8");
      },
    }, () => prepareArtifactWrite("/unused", {
      project: "p",
      jobId: "j",
      kind: "review",
      content: "linked review",
      dataRoot,
    }));

    const committed = await prepared.commit();
    assert.equal(isArtifactCommitOutcome(committed), true);
    if (!isArtifactCommitOutcome(committed)) throw new Error("expected committed cleanup outcome");
    assert.equal(committed.committed, true);
    assert.equal(committed.cleanupPending, true);
    assert.deepEqual(committed.artifact, prepared.artifact);
    assert.equal(committed.commitWarnings.length, 1);
    assert.match(String(committed.commitWarnings[0]), /artifact reservation cleanup failed/);
    assert.ok(observed);
    assert.equal(await readFile(observed.path, "utf8"), "linked review");
    assert.equal(await exists(observed.tempPath), true);
    assert.equal(await exists(observed.lockDir), false, "cleanup isolates the canonical lock name");
    assert.deepEqual(preservedLockEntries(await outputEntries(dataRoot)), []);

    await rm(observed.tempPath, { recursive: true });
    const [first, second] = await Promise.all([committed.retryCleanup(), prepared.commit()]);
    assert.deepEqual(committedArtifact(first), prepared.artifact);
    assert.deepEqual(committedArtifact(second), prepared.artifact);
    assert.equal(await exists(observed.tempPath), false);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("writeArtifact preserves the committed cleanup receipt after the hard-link publish point", async () => {
  const dataRoot = await tempRoot();
  let observed: { path: string; tempPath: string; lockDir: string } | null = null;

  try {
    const artifact = await withArtifactStoreTestHooks({
      afterFinalLink: async (context) => {
        observed = context;
        await rm(context.tempPath);
        await mkdir(context.tempPath);
      },
    }, () => writeArtifact("/unused", {
      project: "p",
      jobId: "j",
      kind: "review",
      content: "published despite cleanup warning",
      dataRoot,
    }));

    assert.equal(artifact.committed, true);
    assert.equal(artifact.cleanupPending, true);
    assert.equal(artifact.commitWarnings.length, 1);
    assert.equal(typeof artifact.retryCleanup, "function");
    assert.ok(observed);
    assert.equal(await readFile(observed.path, "utf8"), "published despite cleanup warning");
    await rm(observed.tempPath, { recursive: true });
    const retried = await artifact.retryCleanup?.();
    assert.deepEqual(committedArtifact(retried || artifact), {
      kind: artifact.kind,
      id: artifact.id,
      name: artifact.name,
      path: artifact.path,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      metadata: artifact.metadata,
    });
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("post-link hook failure is a tagged committed warning, never a false write failure", async () => {
  const dataRoot = await tempRoot();
  const hookFailure = new Error("observer failed after publication");

  try {
    const prepared = await withArtifactStoreTestHooks({
      afterFinalLink: async () => { throw hookFailure; },
    }, () => prepareArtifactWrite("/unused", {
      project: "p",
      jobId: "j",
      kind: "verdict",
      content: "durable verdict",
      dataRoot,
    }));
    const committed = await prepared.commit();
    assert.equal(isArtifactCommitOutcome(committed), true);
    if (!isArtifactCommitOutcome(committed)) throw new Error("expected tagged committed warning");
    assert.equal(committed.cleanupPending, false);
    assert.deepEqual(committed.commitWarnings[0], hookFailure);
    assert.equal(committed.commitWarnings.length, 1);
    assert.equal(await readFile(committed.artifact.path, "utf8"), "durable verdict");
    assert.deepEqual(preservedLockEntries(await outputEntries(dataRoot)), []);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("pre-commit cleanup attempts temp and lock cleanup and preserves the abort cause", async () => {
  const dataRoot = await tempRoot();
  const controller = new AbortController();
  const reason = new DOMException("stop with two cleanup failures", "AbortError");
  let observed: { path: string; tempPath: string; lockDir: string } | null = null;

  try {
    const prepared = await withArtifactStoreTestHooks({
      afterTempWrite: async (context) => {
        observed = context;
        await rm(context.tempPath);
        await mkdir(context.tempPath);
        await writeFile(path.join(context.tempPath, "blocked"), "blocked\n", "utf8");
        await writeFile(path.join(context.lockDir, "owner.json"), JSON.stringify({ ownerToken: "successor" }));
        controller.abort(reason);
      },
    }, () => prepareArtifactWrite("/unused", {
      project: "p",
      jobId: "j",
      kind: "review",
      content: "draft review",
      dataRoot,
      signal: controller.signal,
    }));

    await assert.rejects(prepared.commit(), (error) => {
      assert.equal(error instanceof AggregateError, true);
      const errors = (error as AggregateError).errors;
      assert.equal(errors[0], reason);
      assert.equal(errors.length, 3, "original abort plus both cleanup failures must be retained");
      return true;
    });
    assert.ok(observed);
    assert.equal(await exists(observed.path), false);
    assert.equal(await exists(observed.tempPath), true);
    assert.equal(await exists(observed.lockDir), false);
    assert.equal(
      (await outputEntries(dataRoot)).some((entry) => entry.startsWith(`${path.basename(observed!.lockDir)}.cleanup-`)),
      true,
      "the mismatched owner remains in its quarantined generation",
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("lock cleanup never deletes a same-path successor with a different directory identity", async () => {
  const dataRoot = await tempRoot();
  const controller = new AbortController();
  const reason = new DOMException("abort after lock successor replacement", "AbortError");
  let observed: { path: string; tempPath: string; lockDir: string } | null = null;

  try {
    const prepared = await withArtifactStoreTestHooks({
      afterTempWrite: async (context) => {
        observed = context;
        await rm(context.lockDir, { recursive: true });
        await mkdir(context.lockDir);
        await writeFile(
          path.join(context.lockDir, "owner.json"),
          JSON.stringify({ ownerToken: "successor-owner", marker: "must-survive" }),
          "utf8",
        );
        controller.abort(reason);
      },
    }, () => prepareArtifactWrite("/unused", {
      project: "p",
      jobId: "j",
      kind: "review",
      content: "never publish",
      dataRoot,
      signal: controller.signal,
    }));

    await assert.rejects(prepared.commit(), (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal((error as AggregateError).errors[0], reason);
      assert.match(JSON.stringify((error as AggregateError).errors), /ARTIFACT_LOCK_IDENTITY_MISMATCH/);
      return true;
    });
    assert.ok(observed);
    assert.equal(await exists(observed.path), false);
    assert.equal(await exists(observed.tempPath), false);
    const entries = await outputEntries(dataRoot);
    const preservedLock = entries.find((entry) => entry === path.basename(observed!.lockDir))
      || entries.find((entry) => entry.startsWith(`${path.basename(observed!.lockDir)}.cleanup-`));
    assert.ok(preservedLock, "the displaced successor lock remains recoverable");
    const successor = JSON.parse(await readFile(
      path.join(path.dirname(observed.lockDir), preservedLock, "owner.json"),
      "utf8",
    ));
    assert.equal(successor.ownerToken, "successor-owner");
    assert.equal(successor.marker, "must-survive");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("lock cleanup preserves an empty successor created after quarantine", async () => {
  const dataRoot = await tempRoot();
  const controller = new AbortController();
  const reason = new DOMException("abort before empty-successor restore", "AbortError");
  let observed: { path: string; tempPath: string; lockDir: string } | null = null;
  let quarantineDir = "";

  try {
    const prepared = await withArtifactStoreTestHooks({
      afterTempWrite: async (context) => {
        observed = context;
        await writeFile(
          path.join(context.lockDir, "owner.json"),
          JSON.stringify({ ownerToken: "changed-owner", marker: "quarantine-must-survive" }),
          "utf8",
        );
        controller.abort(reason);
      },
      afterLockQuarantineRename: async (context) => {
        quarantineDir = context.quarantineDir;
        await mkdir(context.lockDir);
      },
    }, () => prepareArtifactWrite("/unused", {
      project: "p",
      jobId: "j",
      kind: "review",
      content: "never publish",
      dataRoot,
      signal: controller.signal,
    }));

    await assert.rejects(prepared.commit(), (error) => {
      assert.equal(error instanceof AggregateError, true);
      const errors = (error as AggregateError).errors;
      assert.equal(errors[0], reason);
      const lockFailure = errors.find((candidate) => candidate instanceof AggregateError) as
        | (AggregateError & { successorPreserved?: boolean; residualPath?: string })
        | undefined;
      assert.ok(lockFailure);
      assert.equal(lockFailure.successorPreserved, true);
      assert.equal(lockFailure.residualPath, quarantineDir);
      assert.match(String(lockFailure), /without overwriting successor/);
      return true;
    });

    const context = observed as { path: string; tempPath: string; lockDir: string } | null;
    assert.ok(context);
    assert.deepEqual(await readdir(context.lockDir), [], "the owner-less successor reservation is untouched");
    assert.equal(await exists(quarantineDir), true);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(quarantineDir, "owner.json"), "utf8")),
      { ownerToken: "changed-owner", marker: "quarantine-must-survive" },
    );
    assert.equal(await exists(context.path), false);
    assert.equal(await exists(context.tempPath), false);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("lock cleanup removes a fully validated committed quarantine", async () => {
  const dataRoot = await tempRoot();

  try {
    const prepared = await prepareArtifactWrite("/unused", {
      project: "p",
      jobId: "j",
      kind: "review",
      content: "published before cleanup ambiguity",
      dataRoot,
    });

    const result = await prepared.commit();
    assert.equal(isArtifactCommitOutcome(result), false);
    assert.deepEqual(result, prepared.artifact);
    assert.equal(await exists(prepared.artifact.path), true);
    assert.deepEqual(canonicalLockEntries(await outputEntries(dataRoot)), []);
    assert.deepEqual(preservedLockEntries(await outputEntries(dataRoot)), []);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("artifact lock quarantine owner read rejects symlinks without deleting evidence", async () => {
  const dataRoot = await tempRoot();
  const controller = new AbortController();
  const reason = new DOMException("abort before symlink owner cleanup", "AbortError");
  const externalOwner = path.join(dataRoot, "external-owner.json");
  let lockDir = "";

  try {
    const prepared = await withArtifactStoreTestHooks({
      afterTempWrite: async (context) => {
        lockDir = context.lockDir;
        const ownerPath = path.join(lockDir, "owner.json");
        await writeFile(externalOwner, await readFile(ownerPath));
        await rm(ownerPath);
        await symlink(externalOwner, ownerPath);
        controller.abort(reason);
      },
    }, () => prepareArtifactWrite("/unused", {
      project: "p",
      jobId: "j",
      kind: "review",
      content: "never publish",
      dataRoot,
      signal: controller.signal,
    }));

    await assert.rejects(prepared.commit(), (error) => {
      const unsafe = codedError(error, "ARTIFACT_LOCK_OWNER_READ_UNSAFE");
      assert.ok(unsafe);
      assert.deepEqual(unsafe.recoveryPaths?.includes(lockDir), true);
      return true;
    });
    const quarantineName = (await outputEntries(dataRoot)).find((entry) => (
      entry.startsWith(`${path.basename(lockDir)}.cleanup-`)
    ));
    assert.ok(quarantineName);
    assert.equal((await lstat(path.join(path.dirname(lockDir), quarantineName, "owner.json"))).isSymbolicLink(), true);
    assert.equal(await exists(externalOwner), true);
    assert.equal(await exists(prepared.artifact.path), false);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("artifact lock quarantine owner read enforces a bounded max-plus-one read", async () => {
  const dataRoot = await tempRoot();
  const controller = new AbortController();
  const reason = new DOMException("abort before oversized owner cleanup", "AbortError");
  let lockDir = "";

  try {
    const prepared = await withArtifactStoreTestHooks({
      afterTempWrite: async (context) => {
        lockDir = context.lockDir;
        const ownerPath = path.join(lockDir, "owner.json");
        const owner = JSON.parse(await readFile(ownerPath, "utf8"));
        await writeFile(ownerPath, JSON.stringify({ ...owner, padding: "x".repeat(64 * 1024) }), "utf8");
        controller.abort(reason);
      },
    }, () => prepareArtifactWrite("/unused", {
      project: "p",
      jobId: "j",
      kind: "review",
      content: "never publish",
      dataRoot,
      signal: controller.signal,
    }));

    await assert.rejects(prepared.commit(), (error) => {
      assert.ok(codedError(error, "ARTIFACT_LOCK_OWNER_READ_UNSAFE"));
      return true;
    });
    const quarantineName = (await outputEntries(dataRoot)).find((entry) => (
      entry.startsWith(`${path.basename(lockDir)}.cleanup-`)
    ));
    assert.ok(quarantineName);
    assert.ok((await stat(path.join(path.dirname(lockDir), quarantineName, "owner.json"))).size > 64 * 1024);
    assert.equal(await exists(prepared.artifact.path), false);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("artifact lock cleanup rejects same-token directory replacement", async () => {
  const dataRoot = await tempRoot();
  const controller = new AbortController();
  const reason = new DOMException("abort after same-token directory replacement", "AbortError");
  let lockDir = "";
  let retiredLockDir = "";

  try {
    const prepared = await withArtifactStoreTestHooks({
      afterTempWrite: async (context) => {
        lockDir = context.lockDir;
        retiredLockDir = `${lockDir}.retired-generation`;
        const owner = JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8"));
        await rename(lockDir, retiredLockDir);
        await mkdir(lockDir);
        await writeFile(path.join(lockDir, "owner.json"), JSON.stringify(owner), "utf8");
        controller.abort(reason);
      },
    }, () => prepareArtifactWrite("/unused", {
      project: "p",
      jobId: "j",
      kind: "review",
      content: "never publish",
      dataRoot,
      signal: controller.signal,
    }));

    await assert.rejects(prepared.commit(), (error) => {
      assert.ok(codedError(error, "ARTIFACT_LOCK_IDENTITY_MISMATCH"));
      assert.ok(codedError(error, "ARTIFACT_LOCK_SUCCESSOR_PRESERVED"));
      return true;
    });
    assert.equal(await exists(lockDir), true);
    assert.equal(await exists(path.join(lockDir, "owner.json")), true);
    assert.equal(await exists(retiredLockDir), true);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("artifact directory sync rejects symlinked authority paths without following them", async () => {
  const dataRoot = await tempRoot();
  const externalOutputs = await tempRoot();
  const wikiDir = path.join(dataRoot, "wiki");
  const outputsLink = path.join(wikiDir, "outputs");

  try {
    await mkdir(wikiDir, { recursive: true });
    await symlink(externalOutputs, outputsLink);
    await assert.rejects(
      prepareArtifactWrite("/unused", {
        project: "p",
        jobId: "j",
        kind: "review",
        content: "must not reserve through a symlinked outputs directory",
        dataRoot,
      }),
      (error) => {
        const unsafe = codedError(error, "ARTIFACT_DIRECTORY_SYNC_UNSAFE");
        assert.ok(unsafe);
        assert.ok(unsafe.recoveryPaths?.includes(outputsLink));
        return true;
      },
    );
    assert.equal((await lstat(outputsLink)).isSymbolicLink(), true);
    assert.deepEqual((await readdir(externalOutputs)).filter((entry) => entry.startsWith(".lock-")), []);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(externalOutputs, { recursive: true, force: true });
  }
});

test("artifact publication fails closed when a final path appears before hard link", async () => {
  const dataRoot = await tempRoot();
  let observed: { path: string; tempPath: string; lockDir: string } | null = null;

  try {
    const prepared = await withArtifactStoreTestHooks({
      afterTempWrite: async (context) => {
        observed = context;
        await writeFile(context.path, "attacker artifact\n", "utf8");
      },
    }, () => prepareArtifactWrite("/unused", {
      project: "p",
      jobId: "j",
      kind: "review",
      content: "must not clobber final path",
      dataRoot,
    }));

    await assert.rejects(prepared.commit(), /refusing to overwrite/);
    assert.ok(observed);
    assert.equal(await readFile(observed.path, "utf8"), "attacker artifact\n");
    assert.equal(await exists(observed.tempPath), false);
    assert.equal(await exists(observed.lockDir), false);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("artifact lock cleanup rejects same-token post-validation quarantine replacement", async () => {
  const dataRoot = await tempRoot();
  const controller = new AbortController();
  const reason = new DOMException("abort before post-validation ABA", "AbortError");
  let lockDir = "";
  let quarantineDir = "";
  let retiredQuarantine = "";
  let replaced = false;

  try {
    const prepared = await withArtifactStoreTestHooks({
      afterTempWrite: async (context) => {
        lockDir = context.lockDir;
        controller.abort(reason);
      },
      afterLockQuarantineRename: ({ quarantineDir: observed }) => {
        quarantineDir = observed;
      },
      afterLockOwnerValidation: async ({ quarantineDir: observed, ownerPath }) => {
        if (replaced) return;
        replaced = true;
        quarantineDir = observed;
        retiredQuarantine = `${observed}.retired-generation`;
        const owner = JSON.parse(await readFile(ownerPath, "utf8"));
        await rename(observed, retiredQuarantine);
        await mkdir(observed);
        await writeFile(
          path.join(observed, "owner.json"),
          JSON.stringify({ ...owner, marker: "same-token-successor" }),
          "utf8",
        );
      },
    }, () => prepareArtifactWrite("/unused", {
      project: "p",
      jobId: "j",
      kind: "review",
      content: "never publish",
      dataRoot,
      signal: controller.signal,
    }));

    await assert.rejects(prepared.commit(), (error) => {
      assert.ok(codedError(error, "ARTIFACT_LOCK_IDENTITY_MISMATCH"));
      assert.ok(codedError(error, "ARTIFACT_LOCK_QUARANTINE_PRESERVED"));
      return true;
    });
    assert.equal(replaced, true);
    assert.equal(await exists(lockDir), false);
    assert.equal(await exists(retiredQuarantine), true);
    assert.deepEqual(JSON.parse(await readFile(path.join(quarantineDir, "owner.json"), "utf8")).marker, "same-token-successor");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("artifact lock cleanup preserves an owner mutated in place after validation", async () => {
  const dataRoot = await tempRoot();
  const controller = new AbortController();
  const reason = new DOMException("abort before post-validation owner mutation", "AbortError");
  let quarantineDir = "";

  try {
    const prepared = await withArtifactStoreTestHooks({
      afterTempWrite: () => {
        controller.abort(reason);
      },
      afterLockQuarantineRename: ({ quarantineDir: observed }) => {
        quarantineDir = observed;
      },
      afterLockOwnerValidation: async ({ ownerPath }) => {
        const owner = JSON.parse(await readFile(ownerPath, "utf8"));
        await writeFile(ownerPath, JSON.stringify({
          ...owner,
          ownerToken: "post-validation-successor",
          marker: "must-survive",
        }), "utf8");
      },
    }, () => prepareArtifactWrite("/unused", {
      project: "p",
      jobId: "j",
      kind: "review",
      content: "never publish",
      dataRoot,
      signal: controller.signal,
    }));

    await assert.rejects(prepared.commit(), (error) => {
      assert.ok(codedError(error, "ARTIFACT_LOCK_OWNER_MISMATCH"));
      assert.ok(codedError(error, "ARTIFACT_LOCK_QUARANTINE_PRESERVED"));
      return true;
    });
    const preservedOwner = JSON.parse(await readFile(path.join(quarantineDir, "owner.json"), "utf8"));
    assert.equal(preservedOwner.ownerToken, "post-validation-successor");
    assert.equal(preservedOwner.marker, "must-survive");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("artifact lock owner read detects post-read path generation replacement", async () => {
  const dataRoot = await tempRoot();
  const controller = new AbortController();
  const reason = new DOMException("abort before owner generation check", "AbortError");
  let swapped = false;
  let lockDir = "";
  let quarantineDir = "";
  const hooks = {
    afterTempWrite: async (context: { lockDir: string }) => {
      lockDir = context.lockDir;
      controller.abort(reason);
    },
    ownerReadHooks: {
      beforePathGenerationCheck: async ({ filePath }: { filePath: string }) => {
        if (swapped || !filePath.includes(".cleanup-")) return;
        swapped = true;
        const raw = await readFile(filePath);
        await rename(filePath, `${filePath}.retired-generation`);
        await writeFile(filePath, raw);
      },
    },
    afterLockQuarantineRename: ({ quarantineDir: observed }: { quarantineDir: string }) => {
      quarantineDir = observed;
    },
  } as ArtifactStoreTestHooks;

  try {
    const prepared = await withArtifactStoreTestHooks(hooks, () => prepareArtifactWrite("/unused", {
      project: "p",
      jobId: "j",
      kind: "review",
      content: "never publish",
      dataRoot,
      signal: controller.signal,
    }));

    await assert.rejects(prepared.commit(), (error) => {
      assert.ok(codedError(error, "ARTIFACT_LOCK_OWNER_READ_UNSAFE"));
      return true;
    });
    assert.equal(swapped, true);
    assert.equal(await exists(lockDir), false);
    assert.equal(await exists(path.join(quarantineDir, "owner.json")), true);
    assert.equal(await exists(path.join(quarantineDir, "owner.json.retired-generation")), true);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("artifact reservation owner verification preserves evidence on generation replacement", async () => {
  const dataRoot = await tempRoot();
  let swapped = false;
  let ownerPath = "";
  const hooks = {
    ownerReadHooks: {
      beforePathGenerationCheck: async ({ filePath }: { filePath: string }) => {
        if (swapped || filePath.includes(".cleanup-")) return;
        swapped = true;
        ownerPath = filePath;
        const raw = await readFile(filePath);
        await rename(filePath, `${filePath}.retired-generation`);
        await writeFile(filePath, raw);
      },
    },
  } as ArtifactStoreTestHooks;

  try {
    await assert.rejects(
      withArtifactStoreTestHooks(hooks, () => prepareArtifactWrite("/unused", {
        project: "p",
        jobId: "j",
        kind: "review",
        content: "never prepare",
        dataRoot,
      })),
      (error) => Boolean(codedError(error, "ARTIFACT_LOCK_OWNER_READ_UNSAFE")),
    );
    assert.equal(swapped, true);
    assert.equal(await exists(ownerPath), true);
    assert.equal(await exists(`${ownerPath}.retired-generation`), true);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("artifact temp fd sync failure prevents publication and cleans the reservation", async () => {
  const dataRoot = await tempRoot();
  const syncFailure = Object.assign(new Error("temp fd sync failed"), { code: "EIO" });
  let observedPath = "";
  const hooks = {
    afterReservation: ({ path: artifactPath }: { path: string }) => { observedPath = artifactPath; },
    syncFile: async (_filePath: string, phase: string) => {
      if (phase === "temp-write") throw syncFailure;
    },
  } as ArtifactStoreTestHooks;

  try {
    const prepared = await withArtifactStoreTestHooks(hooks, () => prepareArtifactWrite("/unused", {
      project: "p",
      jobId: "j",
      kind: "review",
      content: "must be fd-synced",
      dataRoot,
    }));
    await assert.rejects(prepared.commit(), (error) => error === syncFailure || (error as Error).cause === syncFailure);
    assert.equal(await exists(observedPath), false);
    assert.deepEqual(canonicalLockEntries(await outputEntries(dataRoot)), []);
    assert.deepEqual((await outputEntries(dataRoot)).filter((entry) => entry.endsWith(".tmp")), []);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("artifact committed temp cleanup preserves isolated generation on isolation ABA", async () => {
  const dataRoot = await tempRoot();
  let isolatedPath = "";
  let retiredIsolatedPath = "";

  try {
    const prepared = await withArtifactStoreTestHooks({
      afterTempIsolationRename: async (context) => {
        isolatedPath = context.isolatedPath;
        retiredIsolatedPath = `${context.isolatedPath}.retired-generation`;
        const raw = await readFile(context.isolatedPath);
        await rename(context.isolatedPath, retiredIsolatedPath);
        await writeFile(context.isolatedPath, raw);
      },
    }, () => prepareArtifactWrite("/unused", {
      project: "p",
      jobId: "j",
      kind: "review",
      content: "published before temp isolation ABA",
      dataRoot,
    }));

    const result = await prepared.commit();
    assert.equal(isArtifactCommitOutcome(result), true);
    if (!isArtifactCommitOutcome(result)) throw new Error("expected committed temp preservation");
    const preserved = codedError(result.commitWarnings[0], "ARTIFACT_TEMP_ISOLATION_PRESERVED");
    assert.ok(preserved);
    assert.equal(preserved.committed, true);
    assert.equal(preserved.committedPath, isolatedPath);
    assert.ok(preserved.recoveryPaths?.includes(isolatedPath));
    assert.equal(await exists(prepared.artifact.path), true);
    assert.equal(await exists(isolatedPath), true);
    assert.equal(await exists(retiredIsolatedPath), true);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("artifact committed temp cleanup preserves isolated generation on pre-unlink ABA", async () => {
  const dataRoot = await tempRoot();
  let isolatedPath = "";
  let retiredIsolatedPath = "";

  try {
    const prepared = await withArtifactStoreTestHooks({
      afterTempIsolationRename: (context) => {
        isolatedPath = context.isolatedPath;
      },
      beforeTempUnlink: async (context) => {
        retiredIsolatedPath = `${context.isolatedPath}.retired-before-unlink`;
        const raw = await readFile(context.isolatedPath);
        await rename(context.isolatedPath, retiredIsolatedPath);
        await writeFile(context.isolatedPath, raw);
      },
    }, () => prepareArtifactWrite("/unused", {
      project: "p",
      jobId: "j",
      kind: "review",
      content: "published before temp unlink ABA",
      dataRoot,
    }));

    const result = await prepared.commit();
    assert.equal(isArtifactCommitOutcome(result), true);
    if (!isArtifactCommitOutcome(result)) throw new Error("expected committed temp preservation");
    const preserved = codedError(result.commitWarnings[0], "ARTIFACT_TEMP_ISOLATION_PRESERVED");
    assert.ok(preserved);
    assert.equal(preserved.committed, true);
    assert.equal(preserved.committedPath, isolatedPath);
    assert.equal(await exists(prepared.artifact.path), true);
    assert.equal(await exists(isolatedPath), true);
    assert.equal(await exists(retiredIsolatedPath), true);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("artifact hard-link parent fsync failure returns a retryable committed ambiguity", async () => {
  const dataRoot = await tempRoot();
  const syncFailure = Object.assign(new Error("artifact parent fsync failed"), { code: "EIO" });
  let linkSyncAttempts = 0;

  try {
    const prepared = await withArtifactStoreTestHooks({
      syncLockDirectory: async (_directory, phase) => {
        if (String(phase) === "artifact-link" && linkSyncAttempts++ === 0) throw syncFailure;
      },
    }, () => prepareArtifactWrite("/unused", {
      project: "p",
      jobId: "j",
      kind: "review",
      content: "linked before fsync ambiguity",
      dataRoot,
    }));
    const result = await prepared.commit();
    assert.equal(isArtifactCommitOutcome(result), true);
    if (!isArtifactCommitOutcome(result)) throw new Error("expected committed ambiguity");
    assert.equal(result.cleanupPending, true);
    const ambiguity = codedError(result.commitWarnings[0], "ARTIFACT_LINK_COMMITTED_DURABILITY_AMBIGUOUS");
    assert.ok(ambiguity);
    assert.equal(ambiguity.committed, true);
    assert.ok(ambiguity.recoveryPaths?.includes(prepared.artifact.path));
    assert.equal(await readFile(prepared.artifact.path, "utf8"), "linked before fsync ambiguity");
    assert.deepEqual(committedArtifact(await result.retryCleanup()), prepared.artifact);
    assert.equal(linkSyncAttempts, 2);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("artifact temp unlink parent fsync failure is a committed cleanup ambiguity", async () => {
  const dataRoot = await tempRoot();
  const syncFailure = Object.assign(new Error("temp parent fsync failed"), { code: "EIO" });
  let removeSyncAttempts = 0;
  let tempPath = "";
  let isolatedPath = "";

  try {
    const prepared = await withArtifactStoreTestHooks({
      afterFinalLink: (context) => { tempPath = context.tempPath; },
      afterTempIsolationRename: (context) => { isolatedPath = context.isolatedPath; },
      syncLockDirectory: async (_directory, phase) => {
        if (String(phase) === "temp-remove" && removeSyncAttempts++ === 0) throw syncFailure;
      },
    }, () => prepareArtifactWrite("/unused", {
      project: "p",
      jobId: "j",
      kind: "review",
      content: "published before temp cleanup ambiguity",
      dataRoot,
    }));
    const result = await prepared.commit();
    assert.equal(isArtifactCommitOutcome(result), true);
    if (!isArtifactCommitOutcome(result)) throw new Error("expected committed cleanup ambiguity");
    const ambiguity = codedError(result.commitWarnings[0], "ARTIFACT_TEMP_REMOVE_COMMITTED_DURABILITY_AMBIGUOUS");
    assert.ok(ambiguity);
    assert.equal(ambiguity.committed, true);
    assert.equal(ambiguity.committedPath, isolatedPath);
    assert.ok(ambiguity.recoveryPaths?.includes(tempPath));
    assert.ok(ambiguity.recoveryPaths?.includes(isolatedPath));
    assert.equal(await exists(tempPath), false);
    assert.equal(await exists(isolatedPath), false);
    assert.equal(await exists(prepared.artifact.path), true);
    assert.deepEqual(committedArtifact(await result.retryCleanup()), prepared.artifact);
    assert.equal(removeSyncAttempts, 2);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

for (const failureCode of ["EIO", "ENOTSUP"] as const) {
  for (const phase of ["reservation-mkdir", "reservation-owner"] as const) {
    test(`artifact ${phase} parent fsync ${failureCode} is tagged with recovery paths`, async () => {
      const dataRoot = await tempRoot();
      const syncFailure = Object.assign(new Error(`${phase} parent fsync failed`), { code: failureCode });
      try {
        await assert.rejects(
          withArtifactStoreTestHooks({
            syncLockDirectory: async (_directory, observedPhase) => {
              if (String(observedPhase) === phase) throw syncFailure;
            },
          }, () => prepareArtifactWrite("/unused", {
            project: "p",
            jobId: "j",
            kind: "review",
            content: "never prepare",
            dataRoot,
          })),
          (error) => {
            const code = phase === "reservation-mkdir"
              ? "ARTIFACT_RESERVATION_MKDIR_COMMITTED_DURABILITY_AMBIGUOUS"
              : "ARTIFACT_LOCK_OWNER_COMMITTED_DURABILITY_AMBIGUOUS";
            const ambiguity = codedError(error, code);
            assert.ok(ambiguity);
            assert.equal(ambiguity.committed, true);
            assert.ok((ambiguity.recoveryPaths?.length || 0) >= 2);
            return true;
          },
        );
        assert.deepEqual(canonicalLockEntries(await outputEntries(dataRoot)), []);
      } finally {
        await rm(dataRoot, { recursive: true, force: true });
      }
    });
  }
}

test("artifact quarantine rename parent fsync failure preserves the quarantine receipt", async () => {
  const dataRoot = await tempRoot();
  const controller = new AbortController();
  const reason = new DOMException("abort into quarantine rename", "AbortError");
  const syncFailure = Object.assign(new Error("quarantine rename parent fsync failed"), { code: "EIO" });
  let lockDir = "";

  try {
    const prepared = await withArtifactStoreTestHooks({
      afterTempWrite: (context) => {
        lockDir = context.lockDir;
        controller.abort(reason);
      },
      syncLockDirectory: async (_directory, phase) => {
        if (phase === "quarantine-rename") throw syncFailure;
      },
    }, () => prepareArtifactWrite("/unused", {
      project: "p",
      jobId: "j",
      kind: "review",
      content: "never publish",
      dataRoot,
      signal: controller.signal,
    }));
    await assert.rejects(prepared.commit(), (error) => {
      const ambiguity = codedError(error, "ARTIFACT_LOCK_QUARANTINE_COMMITTED_DURABILITY_AMBIGUOUS");
      assert.ok(ambiguity);
      assert.equal(ambiguity.committed, true);
      assert.ok(ambiguity.recoveryPaths?.includes(lockDir));
      return true;
    });
    assert.equal(await exists(lockDir), false);
    assert.equal((await outputEntries(dataRoot)).some((entry) => entry.startsWith(`${path.basename(lockDir)}.cleanup-`)), true);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("artifact owner mismatch preserves its quarantined generation without path reconstruction", async () => {
  const dataRoot = await tempRoot();
  const controller = new AbortController();
  const reason = new DOMException("abort into quarantine preservation", "AbortError");
  let lockDir = "";
  let quarantineDir = "";

  try {
    const prepared = await withArtifactStoreTestHooks({
      afterTempWrite: async (context) => {
        lockDir = context.lockDir;
        await writeFile(path.join(lockDir, "owner.json"), JSON.stringify({
          ownerToken: "changed-owner",
          marker: "quarantine-must-survive",
        }), "utf8");
        controller.abort(reason);
      },
      afterLockQuarantineRename: ({ quarantineDir: observed }) => { quarantineDir = observed; },
    }, () => prepareArtifactWrite("/unused", {
      project: "p",
      jobId: "j",
      kind: "review",
      content: "never publish",
      dataRoot,
      signal: controller.signal,
    }));
    await assert.rejects(prepared.commit(), (error) => {
      const preserved = codedError(error, "ARTIFACT_LOCK_QUARANTINE_PRESERVED");
      assert.ok(preserved);
      assert.equal(preserved.committed, true);
      assert.ok(preserved.recoveryPaths?.includes(lockDir));
      assert.ok(preserved.recoveryPaths?.includes(quarantineDir));
      return true;
    });
    assert.equal(await exists(lockDir), false);
    assert.deepEqual(JSON.parse(await readFile(path.join(quarantineDir, "owner.json"), "utf8")), {
      ownerToken: "changed-owner",
      marker: "quarantine-must-survive",
    });
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("artifact quarantine preservation never overwrites a successor entry", async () => {
  const dataRoot = await tempRoot();
  const controller = new AbortController();
  const reason = new DOMException("abort into restore entry ABA", "AbortError");
  let lockDir = "";
  let quarantineDir = "";
  let successorCreated = false;

  try {
    const prepared = await withArtifactStoreTestHooks({
      afterTempWrite: async (context) => {
        lockDir = context.lockDir;
        await writeFile(path.join(lockDir, "owner.json"), JSON.stringify({
          ownerToken: "quarantined-owner",
          marker: "quarantine-must-survive",
        }), "utf8");
        controller.abort(reason);
      },
      afterLockQuarantineRename: async ({ quarantineDir: observed }) => {
        quarantineDir = observed;
        if (successorCreated) return;
        successorCreated = true;
        await mkdir(lockDir);
        await writeFile(path.join(lockDir, "owner.json"), JSON.stringify({
          ownerToken: "third-owner",
          marker: "successor-must-survive",
        }), "utf8");
      },
    }, () => prepareArtifactWrite("/unused", {
      project: "p",
      jobId: "j",
      kind: "review",
      content: "never publish",
      dataRoot,
      signal: controller.signal,
    }));

    await assert.rejects(prepared.commit(), (error) => {
      assert.equal(error instanceof AggregateError, true);
      return true;
    });
    assert.equal(successorCreated, true);
    assert.deepEqual(JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8")), {
      ownerToken: "third-owner",
      marker: "successor-must-survive",
    });
    assert.deepEqual(JSON.parse(await readFile(path.join(quarantineDir, "owner.json"), "utf8")), {
      ownerToken: "quarantined-owner",
      marker: "quarantine-must-survive",
    });
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("artifact quarantine preservation survives whole canonical-directory replacement ABA", async () => {
  const dataRoot = await tempRoot();
  const controller = new AbortController();
  const reason = new DOMException("abort into restore directory ABA", "AbortError");
  let lockDir = "";
  let quarantineDir = "";
  let displacedReservation = "";
  let successorCreated = false;

  try {
    const prepared = await withArtifactStoreTestHooks({
      afterTempWrite: async (context) => {
        lockDir = context.lockDir;
        await writeFile(path.join(lockDir, "owner.json"), JSON.stringify({
          ownerToken: "quarantined-owner",
          marker: "quarantine-must-survive",
        }), "utf8");
        controller.abort(reason);
      },
      afterLockQuarantineRename: async ({ quarantineDir: observed }) => {
        quarantineDir = observed;
        if (successorCreated) return;
        successorCreated = true;
        displacedReservation = `${lockDir}.displaced-reservation`;
        await mkdir(lockDir);
        await rename(lockDir, displacedReservation);
        await mkdir(lockDir);
      },
    }, () => prepareArtifactWrite("/unused", {
      project: "p",
      jobId: "j",
      kind: "review",
      content: "never publish",
      dataRoot,
      signal: controller.signal,
    }));

    await assert.rejects(prepared.commit(), (error) => {
      assert.equal(error instanceof AggregateError, true);
      return true;
    });
    assert.equal(successorCreated, true);
    assert.deepEqual(await readdir(lockDir), [], "the replacement successor directory is untouched");
    assert.equal(await exists(quarantineDir), true, "the quarantined predecessor remains recovery evidence");
    assert.deepEqual(JSON.parse(await readFile(path.join(quarantineDir, "owner.json"), "utf8")), {
      ownerToken: "quarantined-owner",
      marker: "quarantine-must-survive",
    });
    assert.deepEqual(await readdir(displacedReservation), [], "the displaced reservation remains identifiable");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("commit wins a commit-vs-discard race without concurrent cleanup", async () => {
  const dataRoot = await tempRoot();
  const started = deferred();
  const release = deferred();

  try {
    const prepared = await withArtifactStoreTestHooks({
      afterTempWrite: async () => {
        started.resolve();
        await release.promise;
      },
    }, () => prepareArtifactWrite("/unused", {
      project: "p",
      jobId: "j",
      kind: "deliverable",
      content: "commit wins\n",
      dataRoot,
    }));

    const commit = prepared.commit();
    await started.promise;
    const discard = prepared.discard();
    release.resolve();
    const [artifact] = await Promise.all([commit, discard]);
    assert.equal(await readFile(committedArtifact(artifact).path, "utf8"), "commit wins\n");
    assert.deepEqual(canonicalLockEntries(await outputEntries(dataRoot)), []);
  } finally {
    release.resolve();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("discard wins a discard-vs-commit race and publication never starts", async () => {
  const dataRoot = await tempRoot();
  const started = deferred();
  const release = deferred();

  try {
    const prepared = await withArtifactStoreTestHooks({
      beforeDiscardCleanup: async () => {
        started.resolve();
        await release.promise;
      },
    }, () => prepareArtifactWrite("/unused", {
      project: "p",
      jobId: "j",
      kind: "deliverable",
      content: "must not publish\n",
      dataRoot,
    }));

    const discard = prepared.discard();
    await started.promise;
    const commit = prepared.commit();
    release.resolve();
    await discard;
    await assert.rejects(commit, /was discarded/);
    assert.equal(await exists(prepared.artifact.path), false);
    assert.deepEqual(canonicalLockEntries(await outputEntries(dataRoot)), []);
  } finally {
    release.resolve();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("concurrent commit calls share one publication and one stable result", async () => {
  const dataRoot = await tempRoot();
  try {
    const prepared = await prepareArtifactWrite("/unused", {
      project: "p",
      jobId: "j",
      kind: "deliverable",
      content: "deliverable\n",
      dataRoot,
    });
    const [first, second] = await Promise.all([prepared.commit(), prepared.commit()]);
    assert.deepEqual(first, second);
    const artifact = committedArtifact(first);
    assert.equal(await readFile(artifact.path, "utf8"), "deliverable\n");
    await prepared.discard();
    assert.equal(await readFile(artifact.path, "utf8"), "deliverable\n");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("ordinary committed artifact cleanup leaves no temp or lock entries", async () => {
  const dataRoot = await tempRoot();
  try {
    const prepared = await prepareArtifactWrite("/unused", {
      project: "p",
      jobId: "j",
      kind: "deliverable",
      content: "ordinary cleanup\n",
      dataRoot,
    });
    const result = await prepared.commit();
    assert.equal(isArtifactCommitOutcome(result), false);
    assert.equal(await readFile(committedArtifact(result).path, "utf8"), "ordinary cleanup\n");
    assert.deepEqual(tempEntries(await outputEntries(dataRoot)), []);
    assert.deepEqual(canonicalLockEntries(await outputEntries(dataRoot)), []);
    assert.deepEqual(preservedLockEntries(await outputEntries(dataRoot)), []);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("timestamp id collision never overwrites an existing final artifact", async () => {
  const dataRoot = await tempRoot();
  const originalNow = Date.now;
  const fixedNow = 123456789012;
  const collidingId = String(fixedNow).slice(-6);
  const nextId = String(fixedNow + 1).slice(-6);
  const outputsDir = path.join(dataRoot, "wiki", "outputs");
  const existingPath = path.join(outputsDir, `verdict-${collidingId}.md`);

  Date.now = () => fixedNow;
  try {
    await mkdir(outputsDir, { recursive: true });
    await writeFile(existingPath, "existing artifact\n", "utf8");
    const artifact = await writeArtifact("/unused", {
      project: "p",
      jobId: "j",
      kind: "verdict",
      content: "new artifact\n",
      dataRoot,
    });
    assert.equal(await readFile(existingPath, "utf8"), "existing artifact\n");
    assert.equal(artifact.id, nextId);
    assert.equal(await readFile(artifact.path, "utf8"), "new artifact\n");
  } finally {
    Date.now = originalNow;
    await rm(dataRoot, { recursive: true, force: true });
  }
});
