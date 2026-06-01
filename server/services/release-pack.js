import { execFile } from "node:child_process";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { assertExecutorRoot, readExecutorPackage } from "./executor-root.js";

const execFileAsync = promisify(execFile);

const CRITICAL_TARBALL_FILES = ["cpb", "cli/cpb.mjs", "package.json"];

export function createManifestTempPath(manifestPath, idFn = randomUUID) {
  return `${manifestPath}.tmp-${idFn()}`;
}

async function resolvePackedTarball(tgzPath, statFn = stat) {
  let info;
  try {
    info = await statFn(tgzPath);
  } catch (err) {
    throw new Error(`npm pack tarball was not found at ${tgzPath}: ${err.message}`);
  }

  if (typeof info.isFile === "function" && !info.isFile()) {
    throw new Error(`npm pack output is not a file: ${tgzPath}`);
  }
  if (!Number.isFinite(info.size) || info.size <= 0) {
    throw new Error(`npm pack tarball is empty or unreadable: ${tgzPath}`);
  }

  return { tgzPath, tgzSize: info.size };
}

export async function packRelease({
  sourceRoot,
  outputDir,
  json,
  execFileFn = execFileAsync,
  statFn = stat,
  tempIdFn = randomUUID,
} = {}) {
  const resolvedSource = await assertExecutorRoot(sourceRoot);
  const pkg = await readExecutorPackage(resolvedSource);

  const resolvedOutput = outputDir
    ? path.resolve(outputDir)
    : resolvedSource;

  await mkdir(resolvedOutput, { recursive: true });

  const { stdout } = await execFileFn("npm", ["pack", "--silent", "--pack-destination", resolvedOutput], {
    cwd: resolvedSource,
    timeout: 120_000,
  });

  const tgzFilename = stdout.trim().split("\n").pop();
  if (!tgzFilename) {
    throw new Error("npm pack produced no output");
  }

  const tgzPath = path.join(resolvedOutput, tgzFilename);
  const tarball = await resolvePackedTarball(tgzPath, statFn);

  const manifest = {
    packageName: pkg.name,
    version: pkg.version,
    tgzFilename,
    tgzPath: tarball.tgzPath,
    tgzSize: tarball.tgzSize,
    sourceRoot: resolvedSource,
    createdAt: new Date().toISOString(),
  };

  const manifestPath = path.join(resolvedOutput, `${tgzFilename}.manifest.json`);
  const tmpManifest = createManifestTempPath(manifestPath, tempIdFn);
  await writeFile(tmpManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rename(tmpManifest, manifestPath);

  return manifest;
}

export async function verifyTarball({ tgzPath }) {
  const resolved = path.resolve(tgzPath);
  const checks = [];

  try {
    const info = await stat(resolved);
    if (info.size === 0) {
      checks.push({ id: "tarball_empty", status: "fail", message: "Tarball is empty" });
      return { tgzPath: resolved, checks, summary: { ok: 0, warn: 0, fail: checks.length, success: false } };
    }
    checks.push({ id: "tarball_exists", status: "ok", message: `Tarball exists (${(info.size / 1024).toFixed(0)} KB)` });
  } catch (err) {
    checks.push({ id: "tarball_exists", status: "fail", message: `Tarball not found: ${err.message}` });
    return { tgzPath: resolved, checks, summary: { ok: 0, warn: 0, fail: checks.length, success: false } };
  }

  let tarEntries = [];
  try {
    const { stdout: tarContents } = await execFileAsync("tar", ["-tzf", resolved], { timeout: 15_000 });
    tarEntries = tarContents.trim().split("\n").filter(Boolean);
    checks.push({ id: "tarball_entries", status: "ok", message: `Tarball contains ${tarEntries.length} entries`, details: { entryCount: tarEntries.length } });
  } catch {
    checks.push({ id: "tarball_entries", status: "warn", message: "Could not list tarball entries" });
  }

  if (tarEntries.length > 0) {
    for (const cf of CRITICAL_TARBALL_FILES) {
      const found = tarEntries.some(entry => {
        const normalized = entry.replace(/^[^/]+\//, "");
        return normalized === cf || normalized === `${cf}/` || entry.endsWith(`/${cf}`);
      });
      if (!found) {
        checks.push({
          id: `missing_${cf.replace(/[/.]/g, "_")}`,
          status: "warn",
          message: `Critical file '${cf}' may be missing from tarball`,
        });
      } else {
        checks.push({
          id: `present_${cf.replace(/[/.]/g, "_")}`,
          status: "ok",
          message: `Critical file '${cf}' found in tarball`,
        });
      }
    }
  }

  const summary = { ok: 0, warn: 0, fail: 0 };
  for (const c of checks) summary[c.status]++;
  summary.success = summary.fail === 0;

  return { tgzPath: resolved, checks, summary };
}

export function formatPackResult(manifest, { json } = {}) {
  if (json) {
    return JSON.stringify(manifest, null, 2);
  }
  const lines = [
    `Release packed: ${manifest.tgzFilename}`,
    `  Path: ${manifest.tgzPath}`,
    `  Size: ${(manifest.tgzSize / 1024).toFixed(0)} KB`,
    `  Package: ${manifest.packageName} v${manifest.version}`,
  ];
  return lines.join("\n");
}
