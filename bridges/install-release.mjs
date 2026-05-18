#!/usr/bin/env node
import { chmod, cp, mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertExecutorRoot, readExecutorPackage } from "../server/services/executor-root.js";

function usage() {
  return [
    "Usage: cpb release install [--name ID] [--dest-root DIR] [--json]",
    "",
    "Copies CPB executor assets into an immutable release directory.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    name: null,
    destRoot: path.join(os.homedir(), ".cpb", "releases"),
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--name") {
      if (!argv[i + 1]) throw new Error("--name requires a value");
      options.name = argv[i + 1];
      i += 1;
    } else if (arg === "--dest-root") {
      if (!argv[i + 1]) throw new Error("--dest-root requires a value");
      options.destRoot = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function timestampId(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function exists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function copyItem(sourceRoot, destRoot, relativePath) {
  await cp(path.join(sourceRoot, relativePath), path.join(destRoot, relativePath), {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => {
      const base = path.basename(source);
      if (base === "node_modules" || base === ".git") return false;
      if (base === "cpb-task" || base === ".omx" || base === "omx_wiki") return false;
      return true;
    },
  });
}

export async function installRelease({
  sourceRoot,
  destRoot,
  name,
} = {}) {
  const resolvedSource = await assertExecutorRoot(sourceRoot);
  const pkg = await readExecutorPackage(resolvedSource);
  const releaseId = name || `${pkg.version || "dev"}-${timestampId()}`;
  if (!/^[a-zA-Z0-9._-]+$/.test(releaseId)) {
    throw new Error(`invalid release id: ${releaseId}`);
  }

  const resolvedDestRoot = path.resolve(destRoot);
  const releaseRoot = path.join(resolvedDestRoot, releaseId);
  if (await exists(releaseRoot)) {
    throw new Error(`release already exists: ${releaseRoot}`);
  }

  await mkdir(releaseRoot, { recursive: true });
  for (const item of ["bridges", "server", "profiles", "templates", "package.json", "cpb"]) {
    await copyItem(resolvedSource, releaseRoot, item);
  }
  await mkdir(path.join(releaseRoot, "wiki"), { recursive: true });
  await copyItem(resolvedSource, releaseRoot, path.join("wiki", "system"));
  await copyItem(resolvedSource, releaseRoot, path.join("wiki", "projects", "_template"));
  await chmod(path.join(releaseRoot, "cpb"), 0o755).catch(() => {});

  const manifest = {
    releaseId,
    sourceRoot: resolvedSource,
    releaseRoot,
    packageName: pkg.name,
    version: pkg.version,
    installedAt: new Date().toISOString(),
  };
  await mkdir(path.join(releaseRoot, "release"), { recursive: true });
  await cp(
    path.join(resolvedSource, "package.json"),
    path.join(releaseRoot, "release", "package.json"),
  );
  await writeFile(path.join(releaseRoot, "release", "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const sourceRoot = path.resolve(
    process.env.CPB_EXECUTOR_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
  );
  const manifest = await installRelease({
    sourceRoot,
    destRoot: options.destRoot,
    name: options.name,
  });

  if (options.json) console.log(JSON.stringify(manifest, null, 2));
  else {
    console.log(`Release installed: ${manifest.releaseRoot}`);
    console.log(`Use: CPB_EXECUTOR_ROOT=${manifest.releaseRoot} CPB_ROOT=<project-cpb-root> cpb supervisor`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
