import { readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { generateContextPack, contextPackDirForProject } from "./repo-graph.js";
import { createContextPack } from "../../core/artifacts/context-pack.js";
import { validateContextPack } from "../../core/artifacts/validators.js";

const CACHE_MAX_PER_PROJECT = 10;

const packCache = new Map();

function cacheKey(project, task) {
  const hash = createHash("sha256").update(`${project}\0${task || ""}`).digest("hex").slice(0, 16);
  return `${project}:${hash}`;
}

function trimCache(project) {
  const entries = [...packCache.entries()]
    .filter(([key]) => key.startsWith(`${project}:`))
    .sort(([, a], [, b]) => (a.cachedAt || "").localeCompare(b.cachedAt || ""));
  while (entries.length > CACHE_MAX_PER_PROJECT) {
    const [key] = entries.shift();
    packCache.delete(key);
  }
}

async function verifyIntegrity(filePath, expectedSha256) {
  try {
    const content = await readFile(filePath, "utf8");
    const actual = createHash("sha256").update(content, "utf8").digest("hex");
    return actual === expectedSha256 ? content : null;
  } catch {
    return null;
  }
}

export async function generateAndRegister(
  project,
  { hubRoot, task = "", target = null, limit, jobId = null, producerAgent = null } = {},
) {
  const result = await generateContextPack(project, { hubRoot, task, target, limit });
  const pack = result.contextPack;
  const content = await readFile(pack.path, "utf8");

  const artifact = createContextPack({
    id: path.basename(pack.path, ".md").replace("context-pack-", ""),
    path: pack.path,
    project: project.id,
    jobId,
    task: pack.task || task,
    target: pack.target || target,
    files: pack.files || [],
    edges: [],
    graphStats: result.stats || null,
    producerAgent,
    content,
  });

  const validation = validateContextPack(artifact);
  if (!validation.ok) {
    return { artifact, valid: false, reason: validation.reason };
  }

  const key = cacheKey(project.id, task);
  packCache.set(key, { artifact, cachedAt: new Date().toISOString() });
  trimCache(project.id);

  return { artifact, valid: true, result };
}

export async function getLatestContextPack(project, { hubRoot } = {}) {
  const dir = contextPackDirForProject(project, hubRoot);
  try {
    const entries = await readdir(dir);
    const packs = entries
      .filter((e) => e.startsWith("context-pack-") && e.endsWith(".md"))
      .sort()
      .reverse();
    if (packs.length === 0) return null;

    const latest = path.join(dir, packs[0]);
    const content = await readFile(latest, "utf8");
    const sha256 = createHash("sha256").update(content, "utf8").digest("hex");

    return createContextPack({
      id: packs[0].replace("context-pack-", "").replace(".md", ""),
      path: latest,
      project: project.id,
      content,
      graphStats: null,
    });
  } catch {
    return null;
  }
}

export async function getContextPackForJob(project, jobId, { hubRoot } = {}) {
  const dir = contextPackDirForProject(project, hubRoot);
  try {
    const entries = await readdir(dir);
    const packs = entries
      .filter((e) => e.startsWith("context-pack-") && e.endsWith(".md"))
      .sort()
      .reverse();

    for (const packFile of packs) {
      const filePath = path.join(dir, packFile);
      const content = await readFile(filePath, "utf8");

      if (content.includes(`Job: ${jobId}`) || content.includes(`jobId: ${jobId}`)) {
        const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
        return createContextPack({
          id: packFile.replace("context-pack-", "").replace(".md", ""),
          path: filePath,
          project: project.id,
          jobId,
          content,
          graphStats: null,
        });
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function getCachedContextPack(project, task, { hubRoot } = {}) {
  const key = cacheKey(project.id, task);
  const cached = packCache.get(key);
  if (!cached) return null;

  const integrity = await verifyIntegrity(cached.artifact.path, cached.artifact.sha256);
  if (integrity === null) {
    packCache.delete(key);
    return null;
  }

  return cached.artifact;
}

export function clearCache() {
  packCache.clear();
}
