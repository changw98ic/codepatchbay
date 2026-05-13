import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

function providerDir(flowRoot, provider) {
  return path.join(flowRoot, ".omc", "provider-slots", provider);
}

export async function listProviderSlots(flowRoot, provider) {
  const dir = providerDir(flowRoot, provider);
  try {
    const files = await readdir(dir);
    const slots = [];
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      slots.push(JSON.parse(await readFile(path.join(dir, file), "utf8")));
    }
    return slots;
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
}

export async function acquireProviderSlot(flowRoot, { provider, jobId, limit }) {
  const dir = providerDir(flowRoot, provider);
  await mkdir(dir, { recursive: true });
  const slots = await listProviderSlots(flowRoot, provider);
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
