#!/usr/bin/env node
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJson, canonicalJsonBytes, sha256Identifier } from "../core/contracts/canonical-json.js";

export type ReleaseSourceManifestItem = Readonly<{
  path: string;
  mode: "100644" | "100755";
  bytes: number;
  contentSha256: string;
}>;

export type ReleaseSourceManifest = Readonly<{
  schemaVersion: 1;
  hashAlgorithm: "sha256";
  items: readonly ReleaseSourceManifestItem[];
}>;

export type ReleaseSourceFingerprint = Readonly<{
  manifest: ReleaseSourceManifest;
  releaseSourceFingerprint: string;
}>;

type ReleaseSourceFingerprintHooks = Readonly<{
  afterFileRead?: (context: Readonly<{ absolutePath: string; relativePath: string }>) => void | Promise<void>;
}>;

const testHooks = new AsyncLocalStorage<ReleaseSourceFingerprintHooks>();

export function withReleaseSourceFingerprintTestHooks<T>(
  hooks: ReleaseSourceFingerprintHooks,
  callback: () => Promise<T>,
): Promise<T> {
  return testHooks.run(hooks, callback);
}

const INCLUDED_DIRECTORIES = new Set([
  ".github",
  "assets",
  "bridges",
  "cli",
  "core",
  "cpb-test",
  "docs",
  "profiles",
  "providers",
  "runtime",
  "schemas",
  "scripts",
  "server",
  "shared",
  "skills",
  "templates",
  "tests",
  "wiki",
]);

const DENIED_ROOT_NAMES = new Set([
  ".agents",
  ".antigravitycli",
  ".beads",
  ".claude",
  ".codegraph",
  ".codex",
  ".git",
  ".omc",
  ".omx",
  ".test-tmp",
  "artifacts",
  "coverage",
  "cpb-task",
  "dist",
  "dist-tests",
  "flow-task",
  "hyperframes-video",
  "logs",
  "marketing",
  "node_modules",
  "release-evidence",
  "undefined",
]);

function releaseSourceError(message: string, code: string, details: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code, ...details });
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function normalizeRelativePath(value: string): string {
  const normalized = value.split(path.sep).join("/");
  if (!normalized || normalized === "." || normalized.startsWith("../") || path.isAbsolute(normalized) || normalized.includes("\0")) {
    throw releaseSourceError(`release source path is unsafe: ${value}`, "RELEASE_SOURCE_PATH_INVALID", { path: value });
  }
  return normalized;
}

function isIncludedRootFile(name: string): boolean {
  return name === "cpb"
    || name === ".editorconfig"
    || name === ".gitattributes"
    || name === ".gitignore"
    || name === ".npmignore"
    || name === "NOTICE"
    || /^LICENSE.*$/.test(name)
    || /^package.*\.json$/.test(name)
    || /^tsconfig.*\.json$/.test(name)
    || /^codepatchbay-.*\.json$/.test(name)
    || /^[^.].*\.md$/.test(name);
}

function isDeniedRootName(name: string): boolean {
  return DENIED_ROOT_NAMES.has(name) || name.startsWith(".tmp-");
}

type FileGeneration = Readonly<{
  dev: bigint;
  ino: bigint;
  size: bigint;
  mode: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

function generation(stat: BigIntStats): FileGeneration {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mode: stat.mode,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function sameGeneration(left: FileGeneration, right: FileGeneration): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function safeSize(size: bigint, relativePath: string): number {
  if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw releaseSourceError(`release source file size is unsupported: ${relativePath}`, "RELEASE_SOURCE_FILE_TOO_LARGE", {
      path: relativePath,
      size: size.toString(),
    });
  }
  return Number(size);
}

async function readReleaseSourceFile(absolutePath: string, relativePath: string): Promise<ReleaseSourceManifestItem> {
  const beforeStat = await lstat(absolutePath, { bigint: true });
  if (!beforeStat.isFile() || beforeStat.isSymbolicLink()) {
    throw releaseSourceError(`release source entry is not a regular file: ${relativePath}`, "RELEASE_SOURCE_UNSAFE_ENTRY", {
      path: relativePath,
    });
  }
  const before = generation(beforeStat);
  const expectedBytes = safeSize(before.size, relativePath);
  const noFollow = constants.O_NOFOLLOW;
  if (!Number.isSafeInteger(noFollow) || noFollow === 0) {
    throw releaseSourceError("O_NOFOLLOW is unavailable for release source reads", "RELEASE_SOURCE_NOFOLLOW_UNAVAILABLE");
  }

  let handle;
  try {
    handle = await open(absolutePath, constants.O_RDONLY | noFollow);
  } catch (cause) {
    throw Object.assign(
      releaseSourceError(`release source file could not be opened safely: ${relativePath}`, "RELEASE_SOURCE_UNSAFE_ENTRY", {
        path: relativePath,
      }),
      { cause },
    );
  }

  let primaryError: unknown = null;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameGeneration(before, generation(opened))) {
      throw releaseSourceError(`release source file changed before read: ${relativePath}`, "RELEASE_SOURCE_CHANGED", {
        path: relativePath,
      });
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    await testHooks.getStore()?.afterFileRead?.({ absolutePath, relativePath });
    const after = generation(await handle.stat({ bigint: true }));
    if (offset !== expectedBytes || !sameGeneration(before, after)) {
      throw releaseSourceError(`release source file changed during read: ${relativePath}`, "RELEASE_SOURCE_CHANGED", {
        path: relativePath,
      });
    }
    return {
      path: relativePath,
      mode: (Number(before.mode & 0o111n) !== 0) ? "100755" : "100644",
      bytes: offset,
      contentSha256: `sha256:${hash.digest("hex")}`,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (closeError) {
      if (primaryError === null) throw closeError;
    }
  }
}

async function collectIncludedTree(
  absoluteDirectory: string,
  relativeDirectory: string,
  items: ReleaseSourceManifestItem[],
): Promise<void> {
  const beforeStat = await lstat(absoluteDirectory, { bigint: true });
  if (!beforeStat.isDirectory() || beforeStat.isSymbolicLink()) {
    throw releaseSourceError(`release source directory is unsafe: ${relativeDirectory}`, "RELEASE_SOURCE_UNSAFE_ENTRY", {
      path: relativeDirectory,
    });
  }
  const before = generation(beforeStat);
  const names = (await readdir(absoluteDirectory)).sort(compareUtf8);
  for (const name of names) {
    const absolutePath = path.join(absoluteDirectory, name);
    const relativePath = normalizeRelativePath(path.join(relativeDirectory, name));
    const stat = await lstat(absolutePath, { bigint: true });
    if (stat.isSymbolicLink()) {
      throw releaseSourceError(`release source symlink is forbidden: ${relativePath}`, "RELEASE_SOURCE_SYMLINK_FORBIDDEN", {
        path: relativePath,
      });
    }
    if (stat.isDirectory()) {
      await collectIncludedTree(absolutePath, relativePath, items);
    } else if (stat.isFile()) {
      items.push(await readReleaseSourceFile(absolutePath, relativePath));
    } else {
      throw releaseSourceError(`release source special file is forbidden: ${relativePath}`, "RELEASE_SOURCE_UNSAFE_ENTRY", {
        path: relativePath,
      });
    }
  }
  const afterStat = await lstat(absoluteDirectory, { bigint: true });
  if (!afterStat.isDirectory() || afterStat.isSymbolicLink() || !sameGeneration(before, generation(afterStat))) {
    throw releaseSourceError(`release source directory changed during scan: ${relativeDirectory}`, "RELEASE_SOURCE_CHANGED", {
      path: relativeDirectory,
    });
  }
}

export async function buildReleaseSourceFingerprint(
  input: Readonly<{ root?: string }> = {},
): Promise<ReleaseSourceFingerprint> {
  const requestedRoot = path.resolve(input.root || process.cwd());
  const rootStat = await lstat(requestedRoot, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw releaseSourceError(`release source root is unsafe: ${requestedRoot}`, "RELEASE_SOURCE_ROOT_INVALID");
  }
  const canonicalRoot = await realpath(requestedRoot);
  const canonicalRootStat = await lstat(canonicalRoot, { bigint: true });
  if (!canonicalRootStat.isDirectory() || canonicalRootStat.isSymbolicLink() || !sameGeneration(generation(rootStat), generation(canonicalRootStat))) {
    throw releaseSourceError(`release source root changed while resolving: ${requestedRoot}`, "RELEASE_SOURCE_ROOT_INVALID", {
      canonicalRoot,
    });
  }
  const rootBefore = generation(canonicalRootStat);
  const items: ReleaseSourceManifestItem[] = [];
  const names = (await readdir(canonicalRoot)).sort(compareUtf8);

  for (const name of names) {
    const absolutePath = path.join(canonicalRoot, name);
    const stat = await lstat(absolutePath, { bigint: true });
    if (isDeniedRootName(name)) continue;
    if (name === ".DS_Store") {
      throw releaseSourceError(".DS_Store is forbidden in release source", "RELEASE_SOURCE_FORBIDDEN", { path: name });
    }
    if (INCLUDED_DIRECTORIES.has(name)) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw releaseSourceError(`included release source directory is unsafe: ${name}`, "RELEASE_SOURCE_UNSAFE_ENTRY", {
          path: name,
        });
      }
      await collectIncludedTree(absolutePath, name, items);
      continue;
    }
    if (isIncludedRootFile(name)) {
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw releaseSourceError(`included release source file is unsafe: ${name}`, "RELEASE_SOURCE_UNSAFE_ENTRY", {
          path: name,
        });
      }
      items.push(await readReleaseSourceFile(absolutePath, name));
      continue;
    }
    throw releaseSourceError(`unregistered release source root entry: ${name}`, "RELEASE_SOURCE_UNREGISTERED_PATH", {
      path: name,
    });
  }

  const rootAfterStat = await lstat(canonicalRoot, { bigint: true });
  if (!rootAfterStat.isDirectory() || rootAfterStat.isSymbolicLink() || !sameGeneration(rootBefore, generation(rootAfterStat))) {
    throw releaseSourceError("release source root changed during scan", "RELEASE_SOURCE_CHANGED", { path: "." });
  }
  items.sort((left, right) => compareUtf8(left.path, right.path));
  const manifest: ReleaseSourceManifest = {
    schemaVersion: 1,
    hashAlgorithm: "sha256",
    items,
  };
  return {
    manifest,
    releaseSourceFingerprint: sha256Identifier(canonicalJsonBytes(manifest)),
  };
}

export async function verifyReleaseSourceFingerprint(
  expected: ReleaseSourceFingerprint,
  input: Readonly<{ root?: string }> = {},
): Promise<ReleaseSourceFingerprint> {
  const actual = await buildReleaseSourceFingerprint(input);
  if (
    actual.releaseSourceFingerprint !== expected.releaseSourceFingerprint
    || canonicalJson(actual.manifest) !== canonicalJson(expected.manifest)
  ) {
    throw releaseSourceError("release source changed after the session started", "RELEASE_SOURCE_CHANGED", {
      expected: expected.releaseSourceFingerprint,
      actual: actual.releaseSourceFingerprint,
    });
  }
  return actual;
}

async function main(): Promise<void> {
  const rootIndex = process.argv.indexOf("--root");
  const root = rootIndex >= 0 ? process.argv[rootIndex + 1] : process.cwd();
  if (!root) throw releaseSourceError("--root requires a path", "RELEASE_SOURCE_ARGUMENT_INVALID");
  const result = await buildReleaseSourceFingerprint({ root });
  process.stdout.write(`${JSON.stringify({ ...result.manifest, releaseSourceFingerprint: result.releaseSourceFingerprint }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "RELEASE_SOURCE_FINGERPRINT_FAILED";
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${code}: ${message}\n`);
    process.exitCode = 1;
  });
}
