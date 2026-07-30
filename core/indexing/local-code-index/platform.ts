/**
 * Local Code Index v2 — platform capability probe.
 *
 * Runs a battery of filesystem capability checks inside a temporary directory
 * and returns either `{ supported: true }` or
 * `{ supported: false, reason: "unsupported_platform", detail }`.
 *
 * Every probe is designed to leave zero persistent state: the temp directory
 * is removed on both success and failure paths.
 *
 * Spec: docs/architecture/local-code-index-v2-spec.md (platform requirements)
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ── Result types ────────────────────────────────────────────────────────────

export type PlatformProbeSuccess = Readonly<{ supported: true }>;

export type PlatformProbeFailure = Readonly<{
  supported: false;
  reason: "unsupported_platform";
  detail: string;
}>;

export type PlatformProbeResult = PlatformProbeSuccess | PlatformProbeFailure;

// ── Filesystem probe adapter ────────────────────────────────────────────────

/**
 * Internal adapter interface for filesystem probes.
 *
 * Each probe method performs one capability check inside the given directory
 * and returns `null` on success or a `PlatformProbeFailure` on failure.
 *
 * Production uses {@link nodeProbeAdapter}. Tests inject a custom adapter
 * to deterministically trigger specific failures without privilege changes.
 */
export interface FilesystemProbeAdapter {
  /** Create and return the path to a new temporary directory. */
  createTempDir(prefix: string): string;

  /** Probe 1 — device/inode stability. */
  probeDeviceInodeStability(dir: string): PlatformProbeFailure | null;

  /** Probe 2 — nanosecond timestamps. */
  probeNanosecondTimestamps(dir: string): PlatformProbeFailure | null;

  /** Probe 3 — exclusive creation (O_EXCL). */
  probeExclusiveCreation(dir: string): PlatformProbeFailure | null;

  /** Probe 4 — same-filesystem hard links. */
  probeHardLinks(dir: string): PlatformProbeFailure | null;

  /** Probe 5 — same-filesystem rename. */
  probeRename(dir: string): PlatformProbeFailure | null;

  /** Probe 6 — file sync (fsync). */
  probeFileSync(dir: string): PlatformProbeFailure | null;

  /** Probe 7 — directory sync (fsync on directory handle). */
  probeDirectorySync(dir: string): PlatformProbeFailure | null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const PREFIX = "cpb-platform-probe-";

function ok(): PlatformProbeSuccess {
  return { supported: true };
}

function fail(detail: string): PlatformProbeFailure {
  return { supported: false, reason: "unsupported_platform", detail };
}

// ── Real Node adapter ───────────────────────────────────────────────────────

/**
 * Production adapter using real Node.js filesystem APIs.
 *
 * Every probe is synchronous because the underlying syscalls are fast and
 * the adapter is consumed by both the async and sync public probes.
 */
export const nodeProbeAdapter: FilesystemProbeAdapter = {
  createTempDir(prefix) {
    return mkdtempSync(path.join(tmpdir(), prefix));
  },

  probeDeviceInodeStability(dir) {
    const filePath = path.join(dir, "inode-probe");
    const fd = openSync(filePath, "w");
    try {
      const first = fstatSync(fd, { bigint: true });
      if (first.dev === 0n) return fail("stat.dev is zero");
      if (first.ino === 0n) return fail("stat.ino is zero");

      const second = fstatSync(fd, { bigint: true });
      if (first.dev !== second.dev) {
        return fail("stat.dev changed between consecutive reads");
      }
      if (first.ino !== second.ino) {
        return fail("stat.ino changed between consecutive reads");
      }
      return null;
    } finally {
      closeSync(fd);
    }
  },

  probeNanosecondTimestamps(dir) {
    const filePath = path.join(dir, "ns-probe");
    writeFileSync(filePath, "");
    const st = lstatSync(filePath, { bigint: true });

    if (typeof st.mtimeNs !== "bigint") {
      return fail("lstat bigint mode did not produce mtimeNs bigint");
    }

    // mtimeNs must be at least mtimeMs * 1_000_000 (floor check)
    const msAsNs = st.mtimeMs * 1_000_000n;
    if (st.mtimeNs < msAsNs) {
      return fail(
        `mtimeNs (${st.mtimeNs}) is less than mtimeMs converted to ns (${msAsNs})`,
      );
    }
    return null;
  },

  probeExclusiveCreation(dir) {
    const filePath = path.join(dir, "excl-probe");
    const exclFlags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY;
    const fd = openSync(filePath, exclFlags);
    closeSync(fd);

    try {
      const fd2 = openSync(filePath, exclFlags);
      closeSync(fd2);
      return fail("O_EXCL did not reject existing file");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        return fail(
          `O_EXCL produced ${(err as NodeJS.ErrnoException).code} instead of EEXIST`,
        );
      }
    }
    return null;
  },

  probeHardLinks(dir) {
    const src = path.join(dir, "link-src");
    const dst = path.join(dir, "link-dst");
    writeFileSync(src, "");
    linkSync(src, dst);

    const sStat = lstatSync(src, { bigint: true });
    const dStat = lstatSync(dst, { bigint: true });

    if (sStat.dev !== dStat.dev || sStat.ino !== dStat.ino) {
      return fail("hard link target has different dev/ino from source");
    }
    return null;
  },

  probeRename(dir) {
    const src = path.join(dir, "rename-src");
    const dst = path.join(dir, "rename-dst");
    writeFileSync(src, "");

    const before = lstatSync(src, { bigint: true });
    renameSync(src, dst);
    const after = lstatSync(dst, { bigint: true });

    if (before.ino !== after.ino) return fail("rename changed inode");
    if (before.dev !== after.dev) return fail("rename changed device");
    return null;
  },

  probeFileSync(dir) {
    const filePath = path.join(dir, "fsync-probe");
    const fd = openSync(filePath, "w");
    try {
      writeSync(fd, "sync-test");
      fsyncSync(fd);
      return null;
    } catch (err: unknown) {
      return fail(`fsync failed: ${(err as Error).message}`);
    } finally {
      closeSync(fd);
    }
  },

  probeDirectorySync(dir) {
    const subDir = path.join(dir, "dirsync-probe");
    mkdirSync(subDir);
    const fd = openSync(subDir, "r");
    try {
      fsyncSync(fd);
      return null;
    } catch (err: unknown) {
      return fail(`directory fsync failed: ${(err as Error).message}`);
    } finally {
      closeSync(fd);
    }
  },
};

// ── Internal runner ─────────────────────────────────────────────────────────

/**
 * Shared implementation for both async and sync public probes.
 *
 * Creates a temp directory via the adapter, runs all seven probes in order,
 * and removes the directory before returning regardless of outcome.
 */
function probePlatformWith(adapter: FilesystemProbeAdapter): PlatformProbeResult {
  let dir: string | null = null;
  try {
    dir = adapter.createTempDir(PREFIX);

    const probes: ReadonlyArray<() => PlatformProbeFailure | null> = [
      () => adapter.probeDeviceInodeStability(dir!),
      () => adapter.probeNanosecondTimestamps(dir!),
      () => adapter.probeExclusiveCreation(dir!),
      () => adapter.probeHardLinks(dir!),
      () => adapter.probeRename(dir!),
      () => adapter.probeFileSync(dir!),
      () => adapter.probeDirectorySync(dir!),
    ];

    for (const probe of probes) {
      const failure = probe();
      if (failure !== null) return failure;
    }

    return ok();
  } catch (err: unknown) {
    return fail(
      `platform probe setup failed: ${(err as Error).message ?? String(err)}`,
    );
  } finally {
    if (dir !== null) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // swallow — cleanup is best-effort
      }
    }
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Probe the current platform for filesystem capabilities required by
 * the local code index.
 *
 * Runs seven independent checks inside a fresh temporary directory that
 * is removed before returning, regardless of outcome.
 *
 * Returns `{ supported: true }` when all probes pass, or
 * `{ supported: false, reason: "unsupported_platform", detail }` on the
 * first failure.
 *
 * @param adapter - filesystem probe adapter; defaults to the real Node adapter.
 */
export async function probePlatform(
  adapter: FilesystemProbeAdapter = nodeProbeAdapter,
): Promise<PlatformProbeResult> {
  return probePlatformWith(adapter);
}

/**
 * Synchronous variant of {@link probePlatform} for use in startup paths
 * that cannot await.
 *
 * Uses the same adapter interface as the async variant.
 *
 * @param adapter - filesystem probe adapter; defaults to the real Node adapter.
 */
export function probePlatformSync(
  adapter: FilesystemProbeAdapter = nodeProbeAdapter,
): PlatformProbeResult {
  return probePlatformWith(adapter);
}
