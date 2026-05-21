import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test, describe, beforeEach, afterEach } from "node:test";

const execFileAsync = promisify(execFile);

const CPB_ROOT = path.resolve(import.meta.dirname, "..");
const CPB_BIN = path.join(CPB_ROOT, "cpb");

const REQUIRED_KEYS = [
  "codeVersion",
  "runtimeBackend",
  "runtimeBinaryPath",
  "CPB_ROOT",
  "CPB_EXECUTOR_ROOT",
  "hubRoot",
  "activeAppReleaseId",
  "stateFormatVersions",
];

const REQUIRED_FORMAT_KEYS = [
  "queue",
  "jobsEvents",
  "leases",
  "processRegistry",
  "releaseMetadata",
];

describe("cpb version", () => {
  test("plain output includes version string and is not JSON", async () => {
    const { stdout } = await execFileAsync(CPB_BIN, ["version"], {
      env: { ...process.env, CPB_ROOT, CPB_EXECUTOR_ROOT: CPB_ROOT },
    });
    if (!stdout.includes("cpb v0.2.0")) {
      throw new Error(`Expected "cpb v0.2.0" in output, got: ${stdout.trim()}`);
    }
    try {
      JSON.parse(stdout);
      throw new Error("Plain version output should not be valid JSON");
    } catch (err) {
      if (err.message === "Plain version output should not be valid JSON") throw err;
    }
  });

  test("cpb --version alias outputs version string", async () => {
    const { stdout } = await execFileAsync(CPB_BIN, ["--version"], {
      env: { ...process.env, CPB_ROOT, CPB_EXECUTOR_ROOT: CPB_ROOT },
    });
    if (!stdout.includes("cpb v0.2.0")) {
      throw new Error(`Expected "cpb v0.2.0", got: ${stdout.trim()}`);
    }
  });
});

describe("cpb version --json (default checkout)", () => {
  test("returns valid JSON with all required fields", async () => {
    const { stdout } = await execFileAsync(CPB_BIN, ["version", "--json"], {
      env: { ...process.env, CPB_ROOT, CPB_EXECUTOR_ROOT: CPB_ROOT },
    });

    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (err) {
      throw new Error(`Output is not valid JSON: ${stdout.slice(0, 200)}`);
    }

    for (const key of REQUIRED_KEYS) {
      if (!(key in parsed)) {
        throw new Error(`Missing required key: ${key}`);
      }
    }

    if (parsed.codeVersion !== "0.2.0") {
      throw new Error(`Expected codeVersion "0.2.0", got: ${parsed.codeVersion}`);
    }
    if (parsed.runtimeBackend !== "node") {
      throw new Error(`Expected runtimeBackend "node", got: ${parsed.runtimeBackend}`);
    }
    if (parsed.runtimeBinaryPath !== null) {
      throw new Error(`Expected runtimeBinaryPath null, got: ${parsed.runtimeBinaryPath}`);
    }

    const expectedRoot = path.resolve(CPB_ROOT);
    if (parsed.CPB_ROOT !== expectedRoot) {
      throw new Error(`Expected CPB_ROOT ${expectedRoot}, got: ${parsed.CPB_ROOT}`);
    }
    if (parsed.CPB_EXECUTOR_ROOT !== expectedRoot) {
      throw new Error(`Expected CPB_EXECUTOR_ROOT ${expectedRoot}, got: ${parsed.CPB_EXECUTOR_ROOT}`);
    }
    if (parsed.activeAppReleaseId !== null) {
      throw new Error(`Expected activeAppReleaseId null, got: ${parsed.activeAppReleaseId}`);
    }

    for (const key of REQUIRED_FORMAT_KEYS) {
      if (typeof parsed.stateFormatVersions[key] !== "number") {
        throw new Error(`stateFormatVersions.${key} should be a number, got: ${typeof parsed.stateFormatVersions[key]}`);
      }
    }
  });
});

describe("cpb version --json (explicit root separation)", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = path.join(CPB_ROOT, ".test-tmp-version-" + process.pid);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test("honors explicit CPB_ROOT and CPB_EXECUTOR_ROOT", async () => {
    const { stdout } = await execFileAsync(CPB_BIN, ["version", "--json"], {
      env: {
        ...process.env,
        CPB_ROOT: tmpDir,
        CPB_EXECUTOR_ROOT: CPB_ROOT,
        CPB_HUB_ROOT: path.join(tmpDir, "hub"),
      },
    });

    const parsed = JSON.parse(stdout);

    if (parsed.CPB_ROOT !== path.resolve(tmpDir)) {
      throw new Error(`Expected CPB_ROOT ${path.resolve(tmpDir)}, got: ${parsed.CPB_ROOT}`);
    }
    if (parsed.CPB_EXECUTOR_ROOT !== path.resolve(CPB_ROOT)) {
      throw new Error(`Expected CPB_EXECUTOR_ROOT ${path.resolve(CPB_ROOT)}, got: ${parsed.CPB_EXECUTOR_ROOT}`);
    }
    if (parsed.hubRoot !== path.resolve(path.join(tmpDir, "hub"))) {
      throw new Error(`Expected hubRoot ${path.resolve(path.join(tmpDir, "hub"))}, got: ${parsed.hubRoot}`);
    }
    if (parsed.runtimeBackend !== "node") {
      throw new Error(`Expected runtimeBackend "node", got: ${parsed.runtimeBackend}`);
    }
    if (parsed.runtimeBinaryPath !== null) {
      throw new Error(`Expected runtimeBinaryPath null, got: ${parsed.runtimeBinaryPath}`);
    }
  });
});
