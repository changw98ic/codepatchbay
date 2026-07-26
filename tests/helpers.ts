import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
