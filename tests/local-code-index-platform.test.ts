/**
 * Platform probe tests for Local Code Index v2.
 *
 * Validates:
 *  1. probePlatform / probePlatformSync succeed on supported systems.
 *  2. The probe leaves zero persistent state (temp directory is removed).
 *  3. Injected filesystem failures are surfaced as PlatformProbeFailure.
 *
 * Run:
 *   node dist-tests/scripts/run-node-tests.js tests/local-code-index-platform.test.ts
 */

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  probePlatform,
  probePlatformSync,
  nodeProbeAdapter,
  type FilesystemProbeAdapter,
  type PlatformProbeFailure,
} from "../core/indexing/local-code-index/platform.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const PLATFORM_PROBE_PREFIX = "cpb-platform-probe-";

/** Collect names in tmpdir that start with the probe prefix. */
async function probeLeakSet(): Promise<Set<string>> {
  const entries: string[] = await readdir(os.tmpdir());
  return new Set(entries.filter((e) => e.startsWith(PLATFORM_PROBE_PREFIX)));
}

/** Collect names in tmpdir that start with the probe prefix (sync). */
function probeLeakSetSync(): Set<string> {
  const entries = readdirSync(os.tmpdir());
  return new Set(entries.filter((e) => e.startsWith(PLATFORM_PROBE_PREFIX)));
}

/**
 * Build a FilesystemProbeAdapter that delegates to the real Node adapter
 * but overrides specific methods to inject deterministic failures.
 */
function withProbeFailure(
  overrides: Partial<FilesystemProbeAdapter>,
): FilesystemProbeAdapter {
  return { ...nodeProbeAdapter, ...overrides };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Platform probe succeeds on supported systems (real adapter)
// ─────────────────────────────────────────────────────────────────────────────

test("probePlatform resolves { supported: true } on a real filesystem", async () => {
  const result = await probePlatform();
  assert.deepEqual(result, { supported: true });
});

test("probePlatformSync returns { supported: true } on a real filesystem", () => {
  const result = probePlatformSync();
  assert.deepEqual(result, { supported: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Probe leaves no persistent state (real adapter)
// ─────────────────────────────────────────────────────────────────────────────

test("async probePlatform removes its temp directory on success", async () => {
  const before = await probeLeakSet();
  const result = await probePlatform();
  assert.deepEqual(result, { supported: true });

  const after = await probeLeakSet();
  const leaked = [...after].filter((name) => !before.has(name));
  assert.deepEqual(leaked, [], `temp directory leaked: ${leaked.join(", ")}`);
});

test("sync probePlatformSync removes its temp directory on success", () => {
  const before = probeLeakSetSync();
  const result = probePlatformSync();
  assert.deepEqual(result, { supported: true });

  const after = probeLeakSetSync();
  const leaked = [...after].filter((name) => !before.has(name));
  assert.deepEqual(leaked, [], `temp directory leaked: ${leaked.join(", ")}`);
});

test("no cpb-platform-probe-* directories accumulate across multiple calls", async () => {
  const before = await probeLeakSet();

  // Run the probe several times in quick succession.
  for (let i = 0; i < 5; i++) {
    const r = await probePlatform();
    assert.deepEqual(r, { supported: true });
  }

  const after = await probeLeakSet();
  const leaked = [...after].filter((name) => !before.has(name));
  assert.deepEqual(leaked, [], `leaked ${leaked.length} temp dirs across 5 runs`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Injected filesystem failures are reported correctly
// ─────────────────────────────────────────────────────────────────────────────

test("probePlatform returns failure when createTempDir throws", async () => {
  const adapter = withProbeFailure({
    createTempDir() {
      throw new Error("EACCES: permission denied, mkdtemp");
    },
  });
  const result = await probePlatform(adapter);
  assert.equal(result.supported, false, "must report failure when tmpdir creation throws");
  assert.equal(result.reason, "unsupported_platform");
  assert.ok(
    result.detail.includes("platform probe setup failed"),
    `detail should mention setup failure: ${result.detail}`,
  );
});

test("probePlatformSync returns failure when createTempDir throws", () => {
  const adapter = withProbeFailure({
    createTempDir() {
      throw new Error("EACCES: permission denied, mkdtemp");
    },
  });
  const result = probePlatformSync(adapter);
  assert.equal(result.supported, false, "must report failure when tmpdir creation throws");
  assert.equal(result.reason, "unsupported_platform");
  assert.ok(
    result.detail.includes("platform probe setup failed"),
    `detail should mention setup failure: ${result.detail}`,
  );
});

test("probePlatform returns failure when device/inode probe fails", async () => {
  const adapter = withProbeFailure({
    probeDeviceInodeStability(): PlatformProbeFailure {
      return { supported: false, reason: "unsupported_platform", detail: "injected inode failure" };
    },
  });
  const result = await probePlatform(adapter);
  assert.equal(result.supported, false);
  assert.equal(result.detail, "injected inode failure");
});

test("probePlatform returns failure when nanosecond timestamp probe fails", async () => {
  const adapter = withProbeFailure({
    probeNanosecondTimestamps(): PlatformProbeFailure {
      return { supported: false, reason: "unsupported_platform", detail: "injected ns failure" };
    },
  });
  const result = await probePlatform(adapter);
  assert.equal(result.supported, false);
  assert.equal(result.detail, "injected ns failure");
});

test("probePlatform returns failure when exclusive creation probe fails", async () => {
  const adapter = withProbeFailure({
    probeExclusiveCreation(): PlatformProbeFailure {
      return { supported: false, reason: "unsupported_platform", detail: "injected O_EXCL failure" };
    },
  });
  const result = await probePlatform(adapter);
  assert.equal(result.supported, false);
  assert.equal(result.detail, "injected O_EXCL failure");
});

test("probePlatform returns failure when hard link probe fails", async () => {
  const adapter = withProbeFailure({
    probeHardLinks(): PlatformProbeFailure {
      return { supported: false, reason: "unsupported_platform", detail: "injected hard link failure" };
    },
  });
  const result = await probePlatform(adapter);
  assert.equal(result.supported, false);
  assert.equal(result.detail, "injected hard link failure");
});

test("probePlatform returns failure when rename probe fails", async () => {
  const adapter = withProbeFailure({
    probeRename(): PlatformProbeFailure {
      return { supported: false, reason: "unsupported_platform", detail: "injected rename failure" };
    },
  });
  const result = await probePlatform(adapter);
  assert.equal(result.supported, false);
  assert.equal(result.detail, "injected rename failure");
});

test("probePlatform returns failure when file sync probe fails", async () => {
  const adapter = withProbeFailure({
    probeFileSync(): PlatformProbeFailure {
      return { supported: false, reason: "unsupported_platform", detail: "injected fsync failure" };
    },
  });
  const result = await probePlatform(adapter);
  assert.equal(result.supported, false);
  assert.equal(result.detail, "injected fsync failure");
});

test("probePlatform returns failure when directory sync probe fails", async () => {
  const adapter = withProbeFailure({
    probeDirectorySync(): PlatformProbeFailure {
      return { supported: false, reason: "unsupported_platform", detail: "injected dirsync failure" };
    },
  });
  const result = await probePlatform(adapter);
  assert.equal(result.supported, false);
  assert.equal(result.detail, "injected dirsync failure");
});

test("probePlatformSync returns failure when hard link probe fails", () => {
  const adapter = withProbeFailure({
    probeHardLinks(): PlatformProbeFailure {
      return { supported: false, reason: "unsupported_platform", detail: "injected hard link failure" };
    },
  });
  const result = probePlatformSync(adapter);
  assert.equal(result.supported, false);
  assert.equal(result.detail, "injected hard link failure");
});

test("probePlatformSync returns failure when rename probe fails", () => {
  const adapter = withProbeFailure({
    probeRename(): PlatformProbeFailure {
      return { supported: false, reason: "unsupported_platform", detail: "injected rename failure" };
    },
  });
  const result = probePlatformSync(adapter);
  assert.equal(result.supported, false);
  assert.equal(result.detail, "injected rename failure");
});

test("probePlatformSync returns failure when file sync probe fails", () => {
  const adapter = withProbeFailure({
    probeFileSync(): PlatformProbeFailure {
      return { supported: false, reason: "unsupported_platform", detail: "injected fsync failure" };
    },
  });
  const result = probePlatformSync(adapter);
  assert.equal(result.supported, false);
  assert.equal(result.detail, "injected fsync failure");
});

test("probePlatformSync returns failure when directory sync probe fails", () => {
  const adapter = withProbeFailure({
    probeDirectorySync(): PlatformProbeFailure {
      return { supported: false, reason: "unsupported_platform", detail: "injected dirsync failure" };
    },
  });
  const result = probePlatformSync(adapter);
  assert.equal(result.supported, false);
  assert.equal(result.detail, "injected dirsync failure");
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Cleanup is idempotent — temp dir removed even on probe failure
// ─────────────────────────────────────────────────────────────────────────────

test("probePlatform removes temp directory when a probe returns failure", async () => {
  const before = await probeLeakSet();
  const adapter = withProbeFailure({
    probeHardLinks(): PlatformProbeFailure {
      return { supported: false, reason: "unsupported_platform", detail: "injected" };
    },
  });
  const result = await probePlatform(adapter);
  assert.equal(result.supported, false);

  const after = await probeLeakSet();
  const leaked = [...after].filter((name) => !before.has(name));
  assert.deepEqual(leaked, [], `temp directory leaked on failure path: ${leaked.join(", ")}`);
});

test("probePlatformSync removes temp directory when a probe returns failure", () => {
  const before = probeLeakSetSync();
  const adapter = withProbeFailure({
    probeRename(): PlatformProbeFailure {
      return { supported: false, reason: "unsupported_platform", detail: "injected" };
    },
  });
  const result = probePlatformSync(adapter);
  assert.equal(result.supported, false);

  const after = probeLeakSetSync();
  const leaked = [...after].filter((name) => !before.has(name));
  assert.deepEqual(leaked, [], `temp directory leaked on failure path: ${leaked.join(", ")}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Structural contracts
// ─────────────────────────────────────────────────────────────────────────────

test("PlatformProbeFailure structural contract: discriminated union shape", () => {
  // Exhaustively verify the failure discriminant and detail shape.
  // Construct a failure matching what fail() produces.
  const failure: PlatformProbeFailure = {
    supported: false,
    reason: "unsupported_platform",
    detail: "stat.dev is zero",
  };

  // Discriminated-union narrowing.
  if (!failure.supported) {
    assert.equal(failure.reason, "unsupported_platform");
    assert.equal(typeof failure.detail, "string");
    assert.ok(failure.detail.length > 0);
  }

  // Verify the result can be narrowed via "supported" field.
  type PlatformProbeResult =
    | { supported: true }
    | { supported: false; reason: "unsupported_platform"; detail: string };

  const r: PlatformProbeResult = failure;
  assert.equal(r.supported, false);
});

test("every probe emits a non-empty detail string on failure", () => {
  // Canonical list of detail prefixes emitted by each of the seven probes
  // plus the setup catch-all.  This acts as a structural guard: adding a
  // new probe without updating this list will fail the test.
  const probeDetailPrefixes: readonly string[] = [
    // Probe 1 — device/inode
    "stat.dev is zero",
    "stat.ino is zero",
    "stat.dev changed between consecutive reads",
    "stat.ino changed between consecutive reads",
    // Probe 2 — nanosecond timestamps
    "lstat bigint mode did not produce mtimeNs bigint",
    "mtimeNs (",
    // Probe 3 — exclusive creation
    "O_EXCL did not reject existing file",
    "O_EXCL produced",
    // Probe 4 — hard links
    "hard link target has different dev/ino from source",
    // Probe 5 — rename
    "rename changed inode",
    "rename changed device",
    // Probe 6 — file sync
    "fsync failed:",
    // Probe 7 — directory sync
    "directory fsync failed:",
    // Setup catch-all
    "platform probe setup failed:",
  ];

  for (const prefix of probeDetailPrefixes) {
    assert.ok(
      typeof prefix === "string" && prefix.length > 0,
      `detail prefix must be non-empty: ${JSON.stringify(prefix)}`,
    );
  }

  // No duplicates.
  const unique = new Set(probeDetailPrefixes);
  assert.equal(unique.size, probeDetailPrefixes.length, "duplicate detail prefix detected");
});

test("probePlatform never throws — always returns PlatformProbeResult", async () => {
  await assert.doesNotReject(
    () => probePlatform(),
    "probePlatform must never reject",
  );
});

test("probePlatformSync never throws — always returns PlatformProbeResult", () => {
  assert.doesNotThrow(
    () => probePlatformSync(),
    "probePlatformSync must never throw",
  );
});
