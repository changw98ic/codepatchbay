import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_SLOT_TTL_MS = 300_000; // 5 minutes

function providerDir(flowRoot, provider) {
  return path.join(flowRoot, ".omc", "provider-slots", provider);
}

function isSlotStale(slot, slotTtlMs, now = Date.now()) {
  const acquiredAtMs = new Date(slot.acquiredAt).getTime();
  if (Number.isNaN(acquiredAtMs)) return true;
  return now - acquiredAtMs > slotTtlMs;
}

export async function listProviderSlots(flowRoot, provider, { slotTtlMs } = {}) {
  const dir = providerDir(flowRoot, provider);
  try {
    const files = await readdir(dir);
    const slots = [];
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      slots.push(JSON.parse(await readFile(path.join(dir, file), "utf8")));
    }
    if (slotTtlMs !== undefined) {
      const now = Date.now();
      return slots.filter((slot) => !isSlotStale(slot, slotTtlMs, now));
    }
    return slots;
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
}

export async function cleanupStaleSlots(flowRoot, { provider, slotTtlMs = DEFAULT_SLOT_TTL_MS } = {}) {
  const dir = providerDir(flowRoot, provider);
  try {
    const files = await readdir(dir);
    const now = Date.now();
    const removed = [];
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      const filePath = path.join(dir, file);
      const slot = JSON.parse(await readFile(filePath, "utf8"));
      if (isSlotStale(slot, slotTtlMs, now)) {
        await unlink(filePath);
        removed.push(slot);
      }
    }
    return removed;
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
}

export async function acquireProviderSlot(flowRoot, { provider, jobId, limit, slotTtlMs = DEFAULT_SLOT_TTL_MS }) {
  const dir = providerDir(flowRoot, provider);
  await mkdir(dir, { recursive: true });
  await cleanupStaleSlots(flowRoot, { provider, slotTtlMs });
  const slots = await listProviderSlots(flowRoot, provider, { slotTtlMs });
  if (slots.length >= limit) return { acquired: false, provider, jobId };
  const slot = { provider, jobId, acquiredAt: new Date().toISOString() };
  await writeFile(path.join(dir, `${jobId}.json`), JSON.stringify(slot, null, 2), { flag: "wx" });
  return { acquired: true, ...slot };
}

export async function releaseProviderSlot(flowRoot, { provider, jobId }) {
  try {
    await unlink(path.join(providerDir(flowRoot, provider), `${jobId}.json`));
  } catch (err) {
    if (err && err.code !== "ENOENT") throw err;
  }
}
