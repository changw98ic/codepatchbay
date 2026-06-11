import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

type PlanStoreRootOptions = {
  dataRoot?: string | null;
};

function requireDataRoot(dataRoot?: string | null) {
  if (!dataRoot) {
    throw new Error("project runtime root required for parent plan cache");
  }
  return path.resolve(dataRoot);
}

export function parentPlanStoreDir(_cpbRoot: string, project: string, { dataRoot }: PlanStoreRootOptions = {}) {
  return path.join(requireDataRoot(dataRoot), "plan-cache", project);
}

export function parentPlanRecordPath(cpbRoot: string, project: string, planCacheKey: string, opts: PlanStoreRootOptions = {}) {
  return path.join(parentPlanStoreDir(cpbRoot, project, opts), `${planCacheKey}.json`);
}

async function writeAtomic(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, filePath);
}

export async function readParentPlanRecord(cpbRoot: string, project: string, planCacheKey?: string | null, opts: PlanStoreRootOptions = {}) {
  if (!planCacheKey) return null;
  const file = parentPlanRecordPath(cpbRoot, project, planCacheKey, opts);
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error: any) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeParentPlanRecord(cpbRoot: string, project: string, planCacheKey: string, record: Record<string, any>, opts: PlanStoreRootOptions = {}) {
  if (!planCacheKey) throw new Error("planCacheKey is required");
  const file = parentPlanRecordPath(cpbRoot, project, planCacheKey, opts);
  await writeAtomic(file, `${JSON.stringify(record, null, 2)}\n`);
  return { ...record, cachePath: file };
}
