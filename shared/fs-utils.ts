// @ts-nocheck
import { mkdir, open, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Atomic JSON write: write to temp file, then rename.
 * Crash-safe — partial writes go to .tmp, final file is always complete.
 */
export async function writeJsonAtomic(filePath, data) {
  const content = typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`;
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, filePath);
}

/**
 * Write-once: fails if file already exists (O_EXCL).
 * Returns true if written, false if already exists.
 * Use for result files that must not be overwritten.
 */
export async function writeJsonOnce(filePath, data) {
  const content = typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`;
  await mkdir(path.dirname(filePath), { recursive: true });
  let fh;
  try {
    fh = await open(filePath, "wx");
    await fh.writeFile(content, "utf8");
    return true;
  } catch (err) {
    if (err.code === "EEXIST") return false;
    throw err;
  } finally {
    if (fh) await fh.close();
  }
}
