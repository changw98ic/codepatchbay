import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  assertBundledManifestOwnership,
  assertDoctorHealth,
  assertE2eNpmPackSafety,
  assertPackedExecutorFiles,
  assertPackedTarballIntegrity,
  assertInstalledTreeMatchesManifest,
  assertLockedVersionSatisfiesRange,
  assertManifestSubtreeMatchesRegistryPackage,
  assertRegistryDependencyProvenance,
  bindInstalledPackageAuthority,
  bindInstallPrefixAuthority,
  bindTrustedRuntimeTree,
  bindTrustedToolShim,
  enqueueExactIssueBeforeHubStart,
  e2eResultExitCode,
  formatE2eError,
  resolveE2ePackageRoot,
  resolvePackedTarballPath,
  resolveTrustedNpmRuntime,
  run,
  sanitizeE2eChildEnvironment,
  withGuaranteedHubTeardown,
  withIsolatedPackInstallation,
  type PackedTarballProof,
  type PackedTreeManifest,
} from "../scripts/e2e-npm-pack.js";
import { REQUIRED_EXECUTOR_FILES } from "../server/services/executor-root.js";

const execFileAsync = promisify(execFile);

const compiledRepoRoot = path.resolve(import.meta.dirname, "..", "..");
const repoRoot = existsSync(path.join(compiledRepoRoot, "package.json"))
  ? compiledRepoRoot
  : process.cwd();

function writeTarOctal(header: Buffer, offset: number, length: number, value: number) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  header.write(encoded, offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

function testTarball(entries: Array<{
  path: string;
  body?: Buffer | string;
  mode?: number;
  type?: "0" | "1" | "2" | "5";
  linkname?: string;
}>) {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body || "", "utf8");
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, "utf8");
    writeTarOctal(header, 100, 8, entry.mode ?? (entry.type === "5" ? 0o755 : 0o644));
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, body.length);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = (entry.type || "0").charCodeAt(0);
    if (entry.linkname) header.write(entry.linkname, 157, 100, "utf8");
    header.write("ustar\0", 257, 6, "binary");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
    header[154] = 0;
    header[155] = 0x20;
    chunks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

function tarballEntry(payload: Buffer, files: Array<{ path: string; size: number; mode: number }> = []) {
  return {
    size: payload.length,
    integrity: `sha512-${createHash("sha512").update(payload).digest("base64")}`,
    shasum: createHash("sha1").update(payload).digest("hex"),
    files,
  };
}

function markerResponse(marker: Record<string, unknown>) {
  return JSON.stringify({
    path: ".cpb-disposable-target.json",
    sha: "a".repeat(40),
    content: Buffer.from(JSON.stringify(marker), "utf8").toString("base64"),
  });
}

function disposableTargetMarker(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    purpose: "codepatchbay-release-rehearsal",
    repository: "example/cpb-disposable",
    disposable: true,
    allowDraftPullRequests: true,
    allowPullRequestClose: true,
    allowBranchDeletion: true,
    allowedBranchPrefix: "cpb-release-rehearsal/",
    allowedPayloadPrefix: ".cpb-release-rehearsals/",
    allowCodePatchBayE2E: true,
    allowRepositoryPush: true,
    allowPullRequestMerge: true,
    allowIssueClose: true,
    allowedIssueNumbers: [17],
    allowedAutomationLabels: ["cpb-e2e"],
    ...overrides,
  };
}

async function createDisposableRoot(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-e2e-npm-pack-"));
  await writeFile(path.join(root, ".cpb-e2e-root"), `${JSON.stringify({
    schemaVersion: 1,
    purpose: "codepatchbay-e2e-root",
    disposable: true,
  })}\n`, "utf8");
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function validEnv(hubRoot: string): NodeJS.ProcessEnv {
  return {
    CPB_E2E_ALLOW_DESTRUCTIVE: "1",
    CPB_E2E_ALLOW_REMOTE_WRITES: "1",
    CPB_E2E_REMOTE_ACK: "execute-codepatchbay-e2e:example/cpb-disposable#17",
    CPB_E2E_GITHUB_REPO: "example/cpb-disposable",
    CPB_E2E_ISSUE_NUMBER: "17",
    CPB_E2E_LABEL: "cpb-e2e",
    CPB_HUB_ROOT: hubRoot,
  };
}

function validExec(marker = disposableTargetMarker(), issues: Array<{ number: number }> = [{ number: 17 }]) {
  return (command: string) => {
    if (command === "git config --get remote.origin.url") {
      return "git@github.com:example/cpb-disposable.git\n";
    }
    if (command === "git branch --show-current") return "main\n";
    if (command === "gh auth status") return "authenticated\n";
    if (command === "gh repo view example/cpb-disposable --json id,defaultBranchRef") {
      return JSON.stringify({ id: "R_disposable", defaultBranchRef: { name: "main" } });
    }
    if (command === "gh api 'repos/example/cpb-disposable/contents/.cpb-disposable-target.json?ref=main'") {
      return markerResponse(marker);
    }
    if (command === "gh issue list --repo example/cpb-disposable --state open --label 'cpb-e2e' --limit 100 --json number") {
      return JSON.stringify(issues);
    }
    throw new Error(`unexpected command: ${command}`);
  };
}

test("npm-pack E2E safety gate accepts only a pristine marked root and exact disposable remote capability", async (t) => {
  const hubRoot = await createDisposableRoot(t);
  const result = assertE2eNpmPackSafety({
    env: validEnv(hubRoot),
    root: repoRoot,
    execSyncFn: validExec(),
  });

  assert.equal(result.hubRoot, await realpath(hubRoot));
  assert.equal(result.repository, "example/cpb-disposable");
  assert.equal(result.issueNumber, "17");
  assert.equal(result.defaultBranch, "main");
  assert.equal(result.markerSha, "a".repeat(40));
  assert.equal(result.remoteCapability.repositoryId, "R_disposable");
  assert.equal(result.remoteCapability.issueNumber, 17);
  assert.equal(result.remoteCapability.permissions.issueClose, true);
});

test("npm-pack E2E safety gate rejects before commands when the destructive capability is absent", async (t) => {
  const hubRoot = await createDisposableRoot(t);
  let commands = 0;

  assert.throws(() => assertE2eNpmPackSafety({
    env: { ...validEnv(hubRoot), CPB_E2E_ALLOW_DESTRUCTIVE: "0" },
    root: repoRoot,
    execSyncFn: () => {
      commands += 1;
      return "";
    },
  }), /CPB_E2E_ALLOW_DESTRUCTIVE=1/);
  assert.equal(commands, 0);
});

test("npm-pack E2E safety gate rejects external Redis and dangerous-mode overrides before commands", async (t) => {
  const hubRoot = await createDisposableRoot(t);
  for (const override of [
    { CPB_HUB_STATE_REDIS_CONFIG_FILE: "/shared/redis-state.json" },
    { CPB_DANGEROUS: "1" },
  ]) {
    let commands = 0;
    assert.throws(() => assertE2eNpmPackSafety({
      env: { ...validEnv(hubRoot), ...override },
      root: repoRoot,
      execSyncFn: () => {
        commands += 1;
        return "";
      },
    }), /forbidden for the disposable npm-pack E2E/);
    assert.equal(commands, 0);
  }
});

test("npm-pack E2E safety gate preserves a non-pristine root and rejects cleanup", async (t) => {
  const hubRoot = await createDisposableRoot(t);
  const sentinel = path.join(hubRoot, "must-survive.json");
  await writeFile(sentinel, "preserved\n", "utf8");

  assert.throws(() => assertE2eNpmPackSafety({
    env: validEnv(hubRoot),
    root: repoRoot,
    execSyncFn: validExec(),
  }), /must be pristine/);
  assert.equal(await readFile(sentinel, "utf8"), "preserved\n");
});

test("npm-pack E2E safety gate rejects a marker that does not authorize the exact issue", async (t) => {
  const hubRoot = await createDisposableRoot(t);

  assert.throws(() => assertE2eNpmPackSafety({
    env: validEnv(hubRoot),
    root: repoRoot,
    execSyncFn: validExec(disposableTargetMarker({ allowedIssueNumbers: [18] })),
  }), /issue #17/);
});

test("npm-pack E2E safety gate rejects an automation label that could enqueue more than the authorized issue", async (t) => {
  const hubRoot = await createDisposableRoot(t);

  assert.throws(() => assertE2eNpmPackSafety({
    env: validEnv(hubRoot),
    root: repoRoot,
    execSyncFn: validExec(disposableTargetMarker(), [{ number: 17 }, { number: 18 }]),
  }), /must select only authorized issue #17/);
});

test("npm-pack E2E safety gate rejects a source branch that is not the bound default branch", async (t) => {
  const hubRoot = await createDisposableRoot(t);
  const baseExec = validExec();
  assert.throws(() => assertE2eNpmPackSafety({
    env: validEnv(hubRoot),
    root: repoRoot,
    execSyncFn: (command) => command === "git branch --show-current"
      ? "feature/not-authorized\n"
      : baseExec(command),
  }), /must equal disposable target default branch main/);
});

test("npm-pack E2E module import is hermetic and never invokes git or gh", async (t) => {
  const fakeBin = await mkdtemp(path.join(os.tmpdir(), "cpb-e2e-hermetic-bin-"));
  const invocationMarker = path.join(fakeBin, "invoked");
  const trap = `#!/bin/sh\nprintf '%s\\n' "$0 $*" >> ${JSON.stringify(invocationMarker)}\nexit 91\n`;
  for (const command of ["git", "gh"]) {
    const executable = path.join(fakeBin, command);
    await writeFile(executable, trap, "utf8");
    await chmod(executable, 0o700);
  }
  t.after(() => rm(fakeBin, { recursive: true, force: true }));

  const childEnv: NodeJS.ProcessEnv = { ...process.env, PATH: fakeBin };
  delete childEnv.CPB_E2E_GITHUB_REPO;
  delete childEnv.GITHUB_REPOSITORY;
  const moduleUrl = new URL("../scripts/e2e-npm-pack.js", import.meta.url).href;
  await execFileAsync(process.execPath, [
    "--input-type=module",
    "--eval",
    `await import(${JSON.stringify(moduleUrl)});`,
  ], { env: childEnv });
  assert.equal(existsSync(invocationMarker), false);
});

test("npm-pack E2E scrubs mixed-case npm and shell startup injection from trusted children", () => {
  const sanitized = sanitizeE2eChildEnvironment({
    PATH: "/hostile/bin",
    NPM_CONFIG_SCRIPT_SHELL: "/usr/bin/true",
    nPm_CoNfIg_CaChE: "/outside/cache",
    BASH_ENV: "/outside/bash-env",
    ENV: "/outside/sh-env",
    SHELLOPTS: "xtrace",
    CDPATH: "/outside",
    GLOBIGNORE: "*",
    HTTP_PROXY: "http://outside.invalid",
    npm_token: "secret",
    NODE_OPTIONS: "--import=/outside/inject.mjs",
    NODE_PATH: "/outside/modules",
    SAFE_VALUE: "preserved",
  }, {
    npm: true,
    ownedHome: "/owned/home",
    ownedTemp: "/owned/tmp",
    pathValue: "/owned/bin",
  });
  assert.equal(Object.keys(sanitized).some((key) => /^npm_config_/i.test(key)), false);
  for (const key of [
    "BASH_ENV",
    "ENV",
    "SHELLOPTS",
    "CDPATH",
    "GLOBIGNORE",
    "HTTP_PROXY",
    "NODE_OPTIONS",
    "NODE_PATH",
  ]) assert.equal(sanitized[key], undefined);
  assert.equal(sanitized.HOME, "/owned/home");
  assert.equal(sanitized.TMPDIR, "/owned/tmp");
  assert.equal(sanitized.PATH, "/owned/bin");
  assert.equal(sanitized.SAFE_VALUE, "preserved");
});

test("npm-pack E2E resolves npm from canonical Node instead of a fake PATH npm", async (t) => {
  const fakeBin = await mkdtemp(path.join(os.tmpdir(), "cpb-e2e-fake-npm-"));
  const marker = path.join(fakeBin, "fake-npm-ran");
  await writeFile(path.join(fakeBin, "npm"), `#!/bin/sh\nprintf invoked > ${JSON.stringify(marker)}\nexit 97\n`, { mode: 0o700 });
  t.after(() => rm(fakeBin, { recursive: true, force: true }));
  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${previousPath || ""}`;
  try {
    const runtime = resolveTrustedNpmRuntime();
    assert.notEqual(runtime.canonicalNpmCli, path.join(fakeBin, "npm"));
    assert.match(runtime.canonicalNpmCli, /\/npm\/bin\/npm-cli\.js$/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
  assert.equal(existsSync(marker), false);
});

test("npm-pack E2E binds nested npm runtime bytes and detects same-size mutation", async (t) => {
  const npmRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-e2e-npm-runtime-"));
  t.after(() => rm(npmRoot, { recursive: true, force: true }));
  await mkdir(path.join(npmRoot, "bin"), { mode: 0o755 });
  await mkdir(path.join(npmRoot, "lib"), { mode: 0o755 });
  await writeFile(path.join(npmRoot, "bin", "npm-cli.js"), "entry\n", { mode: 0o755 });
  const nested = path.join(npmRoot, "lib", "nested.js");
  await writeFile(nested, "alpha", { mode: 0o644 });
  const authority = bindTrustedRuntimeTree(await realpath(npmRoot));
  authority.validate();
  await writeFile(nested, "ALPHA", { mode: 0o644 });
  assert.throws(() => authority.validate(), /execution bytes changed/);
  assert.throws(() => authority.dispose(), /execution bytes changed/);
});

test("npm-pack E2E detects replacement of the bound codegraph runtime shim", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-e2e-codegraph-shim-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeBin = path.join(root, "bin");
  await mkdir(runtimeBin, { mode: 0o700 });
  const target = path.join(root, "codegraph.js");
  const replacement = path.join(root, "replacement.js");
  await writeFile(target, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(replacement, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const canonicalBin = await realpath(runtimeBin);
  const authority = bindTrustedToolShim(canonicalBin, "codegraph", await realpath(target));
  authority.validate();
  await rename(path.join(canonicalBin, "codegraph"), path.join(root, "displaced-codegraph-shim"));
  await symlink(await realpath(replacement), path.join(canonicalBin, "codegraph"));
  assert.throws(() => authority.validate(), /tool shim changed/);
  assert.throws(() => authority.dispose(), /tool shim changed/);
});

test("npm-pack E2E rejects wrong lock SRI and locally tampered bundled dependency bytes", () => {
  const registryManifest: PackedTreeManifest = {
    schemaVersion: 1,
    entries: [{
      path: "package.json",
      type: "file",
      mode: 0o644,
      size: 2,
      sha256: "a".repeat(64),
    }],
  };
  const bundledManifest: PackedTreeManifest = {
    schemaVersion: 1,
    entries: [{
      ...registryManifest.entries[0],
      path: "node_modules/chokidar/package.json",
    }],
  };
  const integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
  const dependency = {
    packagePath: "node_modules/chokidar",
    name: "chokidar",
    version: "4.0.3",
    integrity,
    dependencies: { readdirp: "^4.0.1" },
  };
  const proof = {
    path: "/verified/chokidar.tgz",
    dev: "1",
    ino: "2",
    birthtimeNs: "3",
    mode: "33188",
    uid: "1",
    gid: "1",
    nlink: "1",
    size: "1",
    mtimeNs: "4",
    ctimeNs: "5",
    sha512: integrity,
    sha1: "b".repeat(40),
    manifest: registryManifest,
  } satisfies PackedTarballProof;
  const registryEntry = { name: "chokidar", version: "4.0.3", integrity };
  const registryMetadata = { name: "chokidar", version: "4.0.3", dependencies: { readdirp: "^4.0.1" } };
  assert.doesNotThrow(() => assertRegistryDependencyProvenance({
    dependency,
    registryEntry,
    registryProof: proof,
    registryMetadata,
    bundledManifest,
  }));
  assert.throws(() => assertRegistryDependencyProvenance({
    dependency: { ...dependency, integrity: `sha512-${Buffer.alloc(64, 2).toString("base64")}` },
    registryEntry,
    registryProof: proof,
    registryMetadata,
    bundledManifest,
  }), /SRI/);
  const tampered: PackedTreeManifest = {
    schemaVersion: 1,
    entries: [{ ...bundledManifest.entries[0], sha256: "c".repeat(64) }],
  };
  assert.throws(() => assertManifestSubtreeMatchesRegistryPackage({
    bundledManifest: tampered,
    packagePath: "node_modules/chokidar",
    registryManifest,
  }), /bytes differ/);
});

test("npm-pack E2E dependency edge verifier is fail-closed for ranges and prereleases", () => {
  assert.doesNotThrow(() => assertLockedVersionSatisfiesRange("4.1.2", "^4.0.1", "chokidar -> readdirp"));
  assert.throws(
    () => assertLockedVersionSatisfiesRange("5.0.0", "^4.0.1", "chokidar -> readdirp"),
    /violates declared range/,
  );
  assert.throws(
    () => assertLockedVersionSatisfiesRange("4.1.2-beta.1", "^4.0.1", "chokidar -> readdirp"),
    /not a supported semantic version/,
  );
  assert.throws(
    () => assertLockedVersionSatisfiesRange("4.1.2", ">=4", "chokidar -> readdirp"),
    /unsupported/,
  );
});

test("npm-pack E2E validates conflicting nested dependency packages independently", () => {
  const file = (filePath: string, sha256: string): PackedTreeManifest["entries"][number] => ({
    path: filePath,
    type: "file",
    mode: 0o644,
    size: 2,
    sha256,
  });
  const directory = (directoryPath: string): PackedTreeManifest["entries"][number] => ({
    path: directoryPath,
    type: "directory",
    mode: 0o755,
    size: 0,
    sha256: null,
  });
  const parentHash = "a".repeat(64);
  const nestedHash = "b".repeat(64);
  const rootHash = "c".repeat(64);
  const bundled: PackedTreeManifest = {
    schemaVersion: 1,
    entries: [
      directory("node_modules"),
      directory("node_modules/parent"),
      file("node_modules/parent/package.json", parentHash),
      directory("node_modules/parent/node_modules"),
      directory("node_modules/parent/node_modules/shared"),
      file("node_modules/parent/node_modules/shared/package.json", nestedHash),
      directory("node_modules/shared"),
      file("node_modules/shared/package.json", rootHash),
    ].sort((left, right) => left.path.localeCompare(right.path)),
  };
  const packageRoots = [
    "node_modules/parent",
    "node_modules/parent/node_modules/shared",
    "node_modules/shared",
  ];
  assert.doesNotThrow(() => assertBundledManifestOwnership(bundled, packageRoots));
  assert.doesNotThrow(() => assertManifestSubtreeMatchesRegistryPackage({
    bundledManifest: bundled,
    packagePath: "node_modules/parent",
    registryManifest: { schemaVersion: 1, entries: [file("package.json", parentHash)] },
  }));
  assert.doesNotThrow(() => assertManifestSubtreeMatchesRegistryPackage({
    bundledManifest: bundled,
    packagePath: "node_modules/parent/node_modules/shared",
    registryManifest: { schemaVersion: 1, entries: [file("package.json", nestedHash)] },
  }));
  const tampered: PackedTreeManifest = {
    schemaVersion: 1,
    entries: bundled.entries.map((entry) => entry.path === "node_modules/parent/node_modules/shared/package.json"
      ? { ...entry, sha256: "d".repeat(64) }
      : entry),
  };
  assert.throws(() => assertManifestSubtreeMatchesRegistryPackage({
    bundledManifest: tampered,
    packagePath: "node_modules/parent/node_modules/shared",
    registryManifest: { schemaVersion: 1, entries: [file("package.json", nestedHash)] },
  }), /bytes differ/);
});

test("npm-pack E2E rejects unowned artifacts inside nested node_modules", () => {
  const bundled: PackedTreeManifest = {
    schemaVersion: 1,
    entries: [
      {
        path: "node_modules",
        type: "directory",
        mode: 0o755,
        size: 0,
        sha256: null,
      },
      {
        path: "node_modules/parent",
        type: "directory",
        mode: 0o755,
        size: 0,
        sha256: null,
      },
      {
        path: "node_modules/parent/package.json",
        type: "file",
        mode: 0o644,
        size: 2,
        sha256: "a".repeat(64),
      },
      {
        path: "node_modules/parent/node_modules",
        type: "directory",
        mode: 0o755,
        size: 0,
        sha256: null,
      },
      {
        path: "node_modules/parent/node_modules/.cache",
        type: "directory",
        mode: 0o755,
        size: 0,
        sha256: null,
      },
      {
        path: "node_modules/parent/node_modules/.cache/payload",
        type: "file",
        mode: 0o644,
        size: 7,
        sha256: "b".repeat(64),
      },
    ],
  };
  assert.throws(
    () => assertBundledManifestOwnership(bundled, ["node_modules/parent"]),
    /not owned by an independently locked package/,
  );
});

test("manual E2E bootstrap cannot use fake npm or NPM_CONFIG_SCRIPT_SHELL to skip the build", async (t) => {
  const fakeBin = await mkdtemp(path.join(os.tmpdir(), "cpb-e2e-shell-fake-npm-"));
  const marker = path.join(fakeBin, "fake-npm-ran");
  const nodeMarker = path.join(fakeBin, "node-options-ran");
  const nodeInjection = path.join(fakeBin, "inject.cjs");
  await writeFile(path.join(fakeBin, "npm"), `#!/bin/sh\nprintf invoked > ${JSON.stringify(marker)}\nexit 97\n`, { mode: 0o700 });
  await writeFile(nodeInjection, `require("node:fs").writeFileSync(${JSON.stringify(nodeMarker)}, "invoked")\n`, "utf8");
  t.after(() => rm(fakeBin, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${fakeBin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
    NPM_CONFIG_SCRIPT_SHELL: "/usr/bin/true",
    nPm_CoNfIg_CaChE: "/outside/cache",
    NODE_OPTIONS: `--require=${nodeInjection}`,
    CPB_BUILD_TEST_FAULTS: "owner-temp-before-rename",
    CPB_E2E_ALLOW_DESTRUCTIVE: "1",
  };
  delete env.CPB_HUB_ROOT;
  delete env.CPB_E2E_REMOTE_ACK;
  delete env.CPB_E2E_ALLOW_REMOTE_WRITES;
  await assert.rejects(
    execFileAsync("/bin/sh", [path.join(repoRoot, "scripts", "e2e-test.sh")], {
      cwd: repoRoot,
      env,
      timeout: 180_000,
    }),
    (error: unknown) => {
      const output = `${String((error as { stdout?: unknown }).stdout || "")}\n${String((error as { stderr?: unknown }).stderr || "")}`;
      return /CPB_HUB_ROOT is required/.test(output);
    },
  );
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(nodeMarker), false);
});

test("npm-pack E2E compiled entry resolves the release package root, not the dist staging package", () => {
  assert.equal(resolveE2ePackageRoot(path.join(repoRoot, "dist", "scripts")), repoRoot);
  assert.equal(resolveE2ePackageRoot(path.join(repoRoot, "dist-tests", "scripts")), repoRoot);
  assert.equal(resolveE2ePackageRoot(path.join(repoRoot, "scripts")), repoRoot);
});

test("npm-pack E2E binds executor requirements to exact packaged dist paths", () => {
  const expected = ["cpb", ...REQUIRED_EXECUTOR_FILES.map((required) => `dist/${required}`)];
  const valid = { files: expected.map((filePath) => ({ path: filePath })) };
  assert.deepEqual(assertPackedExecutorFiles(valid), expected);

  const required = "dist/server/services/setup-events.js";
  assert.ok(expected.includes(required));
  for (const substitute of [
    "server/services/setup-events.js",
    "./dist/server/services/setup-events.js",
    "dist/core/../server/services/setup-events.js",
  ]) {
    const hostile = expected
      .filter((filePath) => filePath !== required)
      .concat(substitute)
      .map((filePath) => ({ path: filePath }));
    assert.throws(
      () => assertPackedExecutorFiles({ files: hostile }),
      /dist\/server\/services\/setup-events\.js/,
    );
  }
});

test("npm-pack E2E accepts only an owned single-link tarball basename", async (t) => {
  const packDir = await mkdtemp(path.join(os.tmpdir(), "cpb-e2e-pack-path-"));
  t.after(() => rm(packDir, { recursive: true, force: true }));
  const tarball = path.join(packDir, "codepatchbay-0.4.1.tgz");
  const payload = testTarball([{ path: "package/cpb", body: "package", mode: 0o755 }]);
  await writeFile(tarball, payload);
  const canonicalTarball = resolvePackedTarballPath(packDir, path.basename(tarball));
  assert.equal(canonicalTarball, await realpath(tarball));

  const packEntry = tarballEntry(payload, [{ path: "cpb", size: 7, mode: 0o755 }]);
  const proof = assertPackedTarballIntegrity(canonicalTarball, packEntry);
  assert.equal(proof.sha512, packEntry.integrity);
  assert.deepEqual(proof.manifest.entries, [{
    path: "cpb",
    type: "file",
    mode: 0o755,
    size: 7,
    sha256: createHash("sha256").update("package").digest("hex"),
  }]);
  assert.throws(
    () => assertPackedTarballIntegrity(canonicalTarball, { ...packEntry, shasum: "0".repeat(40) }),
    /do not match npm integrity metadata/,
  );
  const changedPayload = testTarball([{ path: "package/cpb", body: "PACKAGE", mode: 0o755 }]);
  await writeFile(canonicalTarball, changedPayload);
  assert.throws(
    () => assertPackedTarballIntegrity(canonicalTarball, packEntry, proof),
    /identity changed|descriptor is not bound|bytes do not match npm integrity metadata|declared size/,
  );

  for (const hostile of ["../outside.tgz", "nested/package.tgz", "package.tar", ""]) {
    assert.throws(() => resolvePackedTarballPath(packDir, hostile), /unsafe tarball filename/);
  }

  const symlinkPath = path.join(packDir, "symlink.tgz");
  await symlink(tarball, symlinkPath);
  assert.throws(() => resolvePackedTarballPath(packDir, path.basename(symlinkPath)), /single-link regular file/);

  const hardlinkPath = path.join(packDir, "hardlink.tgz");
  await link(tarball, hardlinkPath);
  assert.throws(() => resolvePackedTarballPath(packDir, path.basename(hardlinkPath)), /single-link regular file/);
});

test("npm-pack E2E tar manifest rejects traversal, duplicate paths, links, bad checksum, and trailing bytes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-e2e-hostile-tar-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canonicalRoot = await realpath(root);
  const cases: Array<{ name: string; payload: Buffer; pattern: RegExp }> = [
    {
      name: "traversal",
      payload: testTarball([{ path: "package/../escape", body: "x" }]),
      pattern: /not canonical/,
    },
    {
      name: "duplicate",
      payload: testTarball([
        { path: "package/file", body: "x" },
        { path: "package/file", body: "x" },
      ]),
      pattern: /duplicate path/,
    },
    {
      name: "symlink",
      payload: testTarball([{ path: "package/link", type: "2", linkname: "/outside" }]),
      pattern: /unsupported link or special type/,
    },
    {
      name: "hardlink",
      payload: testTarball([{ path: "package/link", type: "1", linkname: "package/file" }]),
      pattern: /unsupported link or special type/,
    },
  ];
  const validTar = gunzipSync(testTarball([{ path: "package/file", body: "x" }]));
  const badChecksum = Buffer.from(validTar);
  badChecksum[0] ^= 1;
  cases.push({ name: "checksum", payload: gzipSync(badChecksum), pattern: /checksum/ });
  const badTrailing = Buffer.from(validTar);
  badTrailing[badTrailing.length - 1] = 1;
  cases.push({ name: "trailing", payload: gzipSync(badTrailing), pattern: /second zero end block|trailing bytes/ });

  for (const hostile of cases) {
    const tarball = path.join(canonicalRoot, `${hostile.name}.tgz`);
    await writeFile(tarball, hostile.payload);
    assert.throws(
      () => assertPackedTarballIntegrity(tarball, tarballEntry(hostile.payload)),
      hostile.pattern,
    );
  }
});

test("npm-pack E2E prefix authority rejects symlink and inode replacement", async (t) => {
  for (const replacement of ["directory", "symlink"] as const) {
    await t.test(replacement, async (st) => {
      const packDir = await mkdtemp(path.join(os.tmpdir(), `cpb-e2e-prefix-${replacement}-`));
      st.after(() => rm(packDir, { recursive: true, force: true }));
      const prefix = path.join(packDir, "install-prefix");
      await mkdir(prefix, { mode: 0o700 });
      const canonicalPackDir = await realpath(packDir);
      const canonicalPrefix = await realpath(prefix);
      const authority = bindInstallPrefixAuthority(canonicalPackDir, canonicalPrefix);
      const displaced = path.join(packDir, "displaced-prefix");
      await rename(prefix, displaced);
      if (replacement === "directory") {
        await mkdir(prefix, { mode: 0o700 });
      } else {
        const outside = await mkdtemp(path.join(os.tmpdir(), "cpb-e2e-prefix-outside-"));
        st.after(() => rm(outside, { recursive: true, force: true }));
        await symlink(outside, prefix);
      }
      assert.throws(() => authority.validate(), /identity changed|no longer canonical/);
      assert.throws(() => authority.dispose(), /identity changed|no longer canonical/);
    });
  }
});

async function createFakeInstalledPackage(prefix: string) {
  const packageRoot = path.join(prefix, "lib", "node_modules", "codepatchbay");
  const executorRoot = path.join(packageRoot, "dist");
  const binDir = path.join(prefix, "bin");
  await mkdir(executorRoot, { recursive: true, mode: 0o755 });
  await mkdir(binDir, { recursive: true, mode: 0o755 });
  await writeFile(path.join(packageRoot, "cpb"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const nestedFile = path.join(executorRoot, "nested.js");
  await writeFile(nestedFile, "alpha", { mode: 0o644 });
  await symlink("../lib/node_modules/codepatchbay/cpb", path.join(binDir, "cpb"));
  return { packageRoot, executorRoot, nestedFile, binDir };
}

function fakeInstalledManifest(): PackedTreeManifest {
  const launcher = Buffer.from("#!/bin/sh\nexit 0\n", "utf8");
  const nested = Buffer.from("alpha", "utf8");
  return {
    schemaVersion: 1,
    entries: [
      {
        path: "cpb",
        type: "file",
        mode: 0o755,
        size: launcher.length,
        sha256: createHash("sha256").update(launcher).digest("hex"),
      },
      {
        path: "dist",
        type: "directory",
        mode: 0o755,
        size: 0,
        sha256: null,
      },
      {
        path: "dist/nested.js",
        type: "file",
        mode: 0o644,
        size: nested.length,
        sha256: createHash("sha256").update(nested).digest("hex"),
      },
    ].sort((left, right) => left.path.localeCompare(right.path)) as PackedTreeManifest["entries"],
  };
}

test("npm-pack E2E exact installed manifest rejects unexpected, missing, symlink, hardlink, and in-place mutation", async (t) => {
  for (const hostile of ["unexpected", "missing", "symlink", "hardlink", "mutation"] as const) {
    await t.test(hostile, async (st) => {
      const root = await mkdtemp(path.join(os.tmpdir(), `cpb-e2e-installed-${hostile}-`));
      st.after(() => rm(root, { recursive: true, force: true }));
      const prefix = path.join(root, "install-prefix");
      await mkdir(prefix, { mode: 0o700 });
      const layout = await createFakeInstalledPackage(prefix);
      const manifest = fakeInstalledManifest();
      const canonicalPackageRoot = await realpath(layout.packageRoot);
      assert.equal(assertInstalledTreeMatchesManifest(canonicalPackageRoot, manifest), 3);
      const displaced = path.join(root, `displaced-${hostile}`);
      if (hostile === "unexpected") {
        await writeFile(path.join(layout.executorRoot, "extra.js"), "extra", { mode: 0o644 });
      } else if (hostile === "missing") {
        await rename(layout.nestedFile, displaced);
      } else if (hostile === "symlink") {
        await rename(layout.nestedFile, displaced);
        await symlink(displaced, layout.nestedFile);
      } else if (hostile === "hardlink") {
        await rename(layout.nestedFile, displaced);
        await link(displaced, layout.nestedFile);
      } else {
        await writeFile(layout.nestedFile, "ALPHA", { mode: 0o644 });
      }
      assert.throws(
        () => assertInstalledTreeMatchesManifest(canonicalPackageRoot, manifest),
        /unexpected|missing|symlink|link count|bytes do not match|type/,
      );
    });
  }
});

test("npm-pack E2E installed package authority rejects an external package symlink", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-e2e-package-symlink-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "cpb-e2e-package-outside-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const prefix = path.join(root, "install-prefix");
  await mkdir(path.join(prefix, "lib", "node_modules"), { recursive: true, mode: 0o755 });
  await mkdir(path.join(prefix, "bin"), { recursive: true, mode: 0o755 });
  const external = await createFakeInstalledPackage(outside);
  await symlink(external.packageRoot, path.join(prefix, "lib", "node_modules", "codepatchbay"));
  await symlink(external.packageRoot + "/cpb", path.join(prefix, "bin", "cpb"));
  const canonicalPrefix = await realpath(prefix);

  assert.throws(
    () => bindInstalledPackageAuthority({
      canonicalPrefix,
      packageName: "codepatchbay",
    }),
    /identity is unsafe|escaped|changed/,
  );
});

test("npm-pack E2E installed package authority detects executor inode replacement through validate and dispose", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-e2e-package-replace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prefix = path.join(root, "install-prefix");
  await mkdir(prefix, { mode: 0o700 });
  const layout = await createFakeInstalledPackage(prefix);
  const authority = bindInstalledPackageAuthority({
    canonicalPrefix: await realpath(prefix),
    packageName: "codepatchbay",
  });
  authority.validate();
  await rename(layout.executorRoot, `${layout.executorRoot}-displaced`);
  await mkdir(layout.executorRoot, { mode: 0o755 });
  assert.throws(() => authority.validate(), /identity (?:is unsafe or )?changed|descriptor identity changed/);
  assert.throws(() => authority.dispose(), /identity (?:is unsafe or )?changed|descriptor identity changed/);
});

test("npm-pack E2E validates installed runtime around every shell spawn and aggregates later disposal failure", async () => {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
  let valid = true;
  let validations = 0;
  const disposal = new Error("runtime disposal detected replacement");
  await assert.rejects(
    withIsolatedPackInstallation(
      async () => {
        run(`${JSON.stringify(process.execPath)} --version`, { silent: true });
      },
      {
        env,
        createWorkspace: async () => ({
          rootPath: "/owned/workspace",
          cleanup: async () => ({} as never),
        }),
        prepare: async () => ({
          binDir: "/isolated/bin",
          validateRuntime() {
            validations += 1;
            if (!valid) throw new Error("runtime identity changed during command");
            valid = false;
          },
          dispose() {
            throw disposal;
          },
        }),
      },
    ),
    (error) => error instanceof AggregateError
      && error.errors.some((entry) => entry instanceof Error && /runtime identity changed during command/.test(entry.message))
      && error.errors.includes(disposal),
  );
  assert.ok(validations >= 2);
});

test("npm-pack E2E scopes its installed launcher to a temporary PATH and restores the caller environment", async () => {
  const env: NodeJS.ProcessEnv = {
    PATH: "/caller/bin",
    CPB_ROOT: "/stale/cpb-root",
    CPB_EXECUTOR_ROOT: "/stale/executor-root",
    CPB_PROJECT_RUNTIME_ROOT: "/stale/project-runtime",
    NODE_OPTIONS: "--import=/stale/inject.mjs",
    NODE_PATH: "/stale/node-path",
  };
  let cleanupCalls = 0;
  const result = await withIsolatedPackInstallation(
    async () => {
      assert.equal(env.PATH, "/isolated/bin");
      assert.equal(env.CPB_ROOT, undefined);
      assert.equal(env.CPB_EXECUTOR_ROOT, undefined);
      assert.equal(env.CPB_PROJECT_RUNTIME_ROOT, undefined);
      assert.equal(env.NODE_OPTIONS, undefined);
      assert.equal(env.NODE_PATH, undefined);
      return "complete";
    },
    {
      env,
      createWorkspace: async () => ({
        rootPath: "/owned/workspace",
        cleanup: async () => {
          cleanupCalls += 1;
          return {} as never;
        },
      }),
      prepare: async () => ({ binDir: "/isolated/bin" }),
    },
  );

  assert.equal(result, "complete");
  assert.equal(env.PATH, "/caller/bin");
  assert.equal(env.CPB_ROOT, "/stale/cpb-root");
  assert.equal(env.CPB_EXECUTOR_ROOT, "/stale/executor-root");
  assert.equal(env.CPB_PROJECT_RUNTIME_ROOT, "/stale/project-runtime");
  assert.equal(env.NODE_OPTIONS, "--import=/stale/inject.mjs");
  assert.equal(env.NODE_PATH, "/stale/node-path");
  assert.equal(cleanupCalls, 1);
});

test("npm-pack E2E preserves operation and temporary-install cleanup failures", async () => {
  const primary = new Error("pipeline failed");
  const cleanup = new Error("temporary install cleanup failed");
  const env: NodeJS.ProcessEnv = { PATH: "/caller/bin" };

  await assert.rejects(
    withIsolatedPackInstallation(
      async () => {
        throw primary;
      },
      {
        env,
        createWorkspace: async () => ({
          rootPath: "/owned/workspace",
          cleanup: async () => {
            throw cleanup;
          },
        }),
        prepare: async () => ({ binDir: "/isolated/bin" }),
      },
    ),
    (error) => error instanceof AggregateError
      && error.errors[0] === primary
      && error.errors[1] === cleanup,
  );
  assert.equal(env.PATH, "/caller/bin");
});

test("npm-pack E2E restores environment and cleans workspace after prepare failure", async () => {
  const primary = new Error("pack prepare failed");
  const env: NodeJS.ProcessEnv = {
    PATH: "/caller/bin",
    CPB_ROOT: "/caller/root",
    NODE_OPTIONS: "--trace-warnings",
  };
  let cleanupCalls = 0;
  await assert.rejects(
    withIsolatedPackInstallation(async () => "unreachable", {
      env,
      createWorkspace: async () => ({
        rootPath: "/owned/workspace",
        cleanup: async () => {
          cleanupCalls += 1;
          return {} as never;
        },
      }),
      prepare: async () => {
        throw primary;
      },
    }),
    (error) => error === primary,
  );
  assert.equal(cleanupCalls, 1);
  assert.equal(env.PATH, "/caller/bin");
  assert.equal(env.CPB_ROOT, "/caller/root");
  assert.equal(env.NODE_OPTIONS, "--trace-warnings");
});

test("npm-pack E2E disposes installation and cleans workspace after verify failure", async () => {
  const primary = new Error("installed runtime verification failed");
  const env: NodeJS.ProcessEnv = { PATH: "/caller/bin" };
  let operationCalls = 0;
  let disposeCalls = 0;
  let cleanupCalls = 0;
  await assert.rejects(
    withIsolatedPackInstallation(async () => {
      operationCalls += 1;
    }, {
      env,
      createWorkspace: async () => ({
        rootPath: "/owned/workspace",
        cleanup: async () => {
          cleanupCalls += 1;
          return {} as never;
        },
      }),
      prepare: async () => ({
        binDir: "/isolated/bin",
        verify() {
          throw primary;
        },
        dispose() {
          disposeCalls += 1;
        },
      }),
    }),
    (error) => error === primary,
  );
  assert.equal(operationCalls, 0);
  assert.equal(disposeCalls, 1);
  assert.equal(cleanupCalls, 1);
  assert.equal(env.PATH, "/caller/bin");
});

test("npm-pack E2E formats every aggregate child for top-level recovery diagnostics", () => {
  const primary = Object.assign(new Error("pipeline failed"), { code: "PIPELINE_FAILED" });
  const cleanup = Object.assign(new Error("workspace cleanup failed"), { code: "TEMPORARY_WORKSPACE_RECOVERY_REQUIRED" });
  const formatted = JSON.parse(formatE2eError(new AggregateError(
    [primary, cleanup],
    "operation and cleanup failed",
  )));
  assert.equal(formatted.name, "AggregateError");
  assert.equal(formatted.errors.length, 2);
  assert.deepEqual(
    formatted.errors.map((entry: { code: string }) => entry.code),
    ["PIPELINE_FAILED", "TEMPORARY_WORKSPACE_RECOVERY_REQUIRED"],
  );
  assert.match(formatted.errors[0].message, /pipeline failed/);
  assert.match(formatted.errors[1].message, /workspace cleanup failed/);
});

test("npm-pack E2E disables automation before Hub startup", async () => {
  const order: string[] = [];
  const result = await enqueueExactIssueBeforeHubStart({
    enqueueExactIssue: async () => {
      order.push("enqueue");
      return true;
    },
    disableAutomation: async () => {
      order.push("disable");
    },
    startHub: async () => {
      order.push("start");
      return "started";
    },
  });
  assert.equal(result, "started");
  assert.deepEqual(order, ["enqueue", "disable", "start"]);
});

test("npm-pack E2E disables automation after exact enqueue failure and never starts Hub", async () => {
  const primary = new Error("exact enqueue failed");
  const order: string[] = [];
  await assert.rejects(
    enqueueExactIssueBeforeHubStart({
      enqueueExactIssue: async () => {
        order.push("enqueue");
        throw primary;
      },
      disableAutomation: async () => {
        order.push("disable");
      },
      startHub: async () => {
        order.push("start");
      },
    }),
    (error) => error === primary,
  );
  assert.deepEqual(order, ["enqueue", "disable"]);
});

test("npm-pack E2E source has no repository-wide or recursive cleanup primitive", async () => {
  const source = await readFile(path.join(repoRoot, "scripts", "e2e-npm-pack.ts"), "utf8");
  assert.doesNotMatch(source, /git worktree prune/);
  assert.doesNotMatch(source, /git branch -D/);
  assert.doesNotMatch(source, /\brmSync\s*\(/);
  assert.doesNotMatch(source, /process\.exit\s*\(/);
  assert.doesNotMatch(source, /leaving services up/i);
  assert.doesNotMatch(source, /\bmkdtempSync\s*\(/);
  assert.doesNotMatch(source, /npm install -g\s+\$\{shellQuote\(tgzPath\)\}/);
  assert.doesNotMatch(source, /run\s*\(\s*[`'"]npm\s/);
  assert.doesNotMatch(source, /run\s*\(\s*[`'"]cpb\s/);
  assert.match(source, /"--offline=true"/);
  assert.match(source, /npmExecution\.runtime\.canonicalNode, \[canonicalLauncher/);
});

test("npm-pack E2E preserves the primary failure and always attempts Hub teardown", async () => {
  const primary = new Error("pipeline failed");
  let teardowns = 0;
  await assert.rejects(
    withGuaranteedHubTeardown(
      async () => {
        throw primary;
      },
      async () => {
        teardowns += 1;
      },
    ),
    (error) => error === primary,
  );
  assert.equal(teardowns, 1);

  const teardown = new Error("Hub teardown failed");
  await assert.rejects(
    withGuaranteedHubTeardown(
      async () => {
        throw primary;
      },
      async () => {
        throw teardown;
      },
    ),
    (error) => error instanceof AggregateError
      && error.errors[0] === primary
      && error.errors[1] === teardown,
  );
});

test("npm-pack E2E health and terminal outcomes fail closed", () => {
  assert.deepEqual(assertDoctorHealth({
    ok: true,
    stdout: JSON.stringify({ checks: [{ status: "ok" }], summary: { ok: 1, warn: 0, error: 0 } }),
  }), { ok: 1, warn: 0, error: 0 });
  assert.throws(
    () => assertDoctorHealth({
      ok: true,
      stdout: JSON.stringify({ checks: [{ status: "error", message: "storage corrupt" }], summary: { error: 1 } }),
    }),
    /storage corrupt/,
  );
  assert.throws(() => assertDoctorHealth({ ok: false, stdout: "{}" }), /command failed/);
  assert.throws(() => assertDoctorHealth({ ok: true, stdout: "not-json" }), /valid JSON/);
  assert.equal(e2eResultExitCode("completed"), 0);
  for (const result of ["failed", "blocked", "cancelled", "timeout", "unknown"]) {
    assert.equal(e2eResultExitCode(result), 1);
  }
});
