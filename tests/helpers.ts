import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

const tempRoots = [];

after(async () => {
  if (process.env.CPB_KEEP_TEMP) {
    for (const root of tempRoots.splice(0)) process.stderr.write(`[keep-temp] ${root}\n`);
    return;
  }
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

export async function tempRoot(prefix) {
  const created = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  // Resolve the macOS tmpdir symlink (/var/folders -> /private/var/folders) so
  // directory-authority validators that reject symlinks accept the temp root.
  // No-op on Linux /tmp (already a real path).
  const root = await realpath(created);
  tempRoots.push(root);
  return root;
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function oldIso(msAgo = 300_000) {
  return new Date(Date.now() - msAgo).toISOString();
}

/** Recursively list all files under a directory (empty array if missing). */
export async function listFiles(dir: string): Promise<string[]> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(full));
    else out.push(full);
  }
  return out;
}

/** Read every file under a directory as utf-8 text, in sorted path order. */
export async function readDirFilesSorted(dir: string): Promise<string[]> {
  const files = await listFiles(dir);
  return Promise.all(files.sort().map((f) => readFile(f, "utf8")));
}
