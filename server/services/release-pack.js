import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { assertExecutorRoot, readExecutorPackage } from "./executor-root.js";

const execFileAsync = promisify(execFile);

export async function packRelease({ sourceRoot, outputDir, json } = {}) {
  const resolvedSource = await assertExecutorRoot(sourceRoot);
  const pkg = await readExecutorPackage(resolvedSource);

  const resolvedOutput = outputDir
    ? path.resolve(outputDir)
    : resolvedSource;

  await mkdir(resolvedOutput, { recursive: true });

  const { stdout } = await execFileAsync("npm", ["pack", "--silent", "--pack-destination", resolvedOutput], {
    cwd: resolvedSource,
    timeout: 120_000,
  });

  const tgzFilename = stdout.trim().split("\n").pop();
  if (!tgzFilename) {
    throw new Error("npm pack produced no output");
  }

  const tgzPath = path.join(resolvedOutput, tgzFilename);

  let tgzSize = 0;
  try {
    const info = await stat(tgzPath);
    tgzSize = info.size;
  } catch {}

  const manifest = {
    packageName: pkg.name,
    version: pkg.version,
    tgzFilename,
    tgzPath,
    tgzSize,
    sourceRoot: resolvedSource,
    createdAt: new Date().toISOString(),
  };

  const manifestPath = path.join(resolvedOutput, `${tgzFilename}.manifest.json`);
  const tmpManifest = `${manifestPath}.tmp-${Date.now()}`;
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

  try {
    const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"], {
      cwd: path.dirname(resolved),
      timeout: 30_000,
      env: { ...process.env },
    });
    const packInfo = JSON.parse(stdout);
    if (Array.isArray(packInfo) && packInfo.length > 0) {
      const files = packInfo[0].files || [];
      const totalFiles = files.length;
      checks.push({ id: "tarball_contents", status: "ok", message: `Pack would include ${totalFiles} entries`, details: { totalFiles } });

      const criticalFiles = ["cpb", "cli/cpb.mjs", "package.json"];
      for (const cf of criticalFiles) {
        if (!files.some(f => f.path === cf)) {
          checks.push({ id: `missing_${cf.replace(/[/.]/g, "_")}`, status: "warn", message: `Critical file '${cf}' may be missing from tarball` });
        }
      }
    }
  } catch (err) {
    checks.push({ id: "tarball_inspect", status: "warn", message: `Could not inspect tarball contents: ${err.message}` });
  }

  try {
    const { stdout: tarContents } = await execFileAsync("tar", ["-tzf", resolved], { timeout: 15_000 });
    const entryCount = tarContents.trim().split("\n").filter(Boolean).length;
    checks.push({ id: "tarball_entries", status: "ok", message: `Tarball contains ${entryCount} entries` });
  } catch {
    checks.push({ id: "tarball_entries", status: "warn", message: "Could not list tarball entries" });
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
