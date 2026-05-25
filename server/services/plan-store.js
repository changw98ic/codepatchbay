import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { runtimeDataPath } from "./runtime-root.js";

export function parentPlanStoreDir(cpbRoot, project) {
  return runtimeDataPath(cpbRoot, "plan-cache", project);
}

export function parentPlanRecordPath(cpbRoot, project, planCacheKey) {
  return path.join(parentPlanStoreDir(cpbRoot, project), `${planCacheKey}.json`);
}

async function writeAtomic(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, filePath);
}

export async function readParentPlanRecord(cpbRoot, project, planCacheKey) {
  if (!planCacheKey) return null;
  const file = parentPlanRecordPath(cpbRoot, project, planCacheKey);
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeParentPlanRecord(cpbRoot, project, planCacheKey, record) {
  if (!planCacheKey) throw new Error("planCacheKey is required");
  const file = parentPlanRecordPath(cpbRoot, project, planCacheKey);
  await writeAtomic(file, `${JSON.stringify(record, null, 2)}\n`);
  return { ...record, cachePath: file };
}
