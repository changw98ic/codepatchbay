import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function listFiles(dir) {
  const out = [];
  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "target" || entry.name === "node_modules") continue;
        await walk(full);
      } else if (/\.(js|mjs)$/.test(entry.name)) {
        out.push(full);
      }
    }
  }
  await walk(path.join(repoRoot, dir));
  return out;
}

test("core stays pure", async () => {
  for (const file of await listFiles("core")) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /from ["'][.\/]+(?:server|bridges|cli|runtime)\//, `${path.relative(repoRoot, file)} imports outside core`);
  }
});

test("runtime bridge dependency is limited to acp client exception", async () => {
  const offenders = [];
  for (const file of await listFiles("runtime")) {
    const source = await readFile(file, "utf8");
    if (source.includes("../bridges/") && !file.endsWith(path.join("runtime", "acp-pool.js"))) {
      offenders.push(path.relative(repoRoot, file));
    }
  }
  assert.deepEqual(offenders, []);
});

test("server does not import from bridges (except acp-pool)", async () => {
  const offenders = [];
  for (const file of await listFiles("server")) {
    const source = await readFile(file, "utf8");
    if (source.includes("../bridges/") || source.includes("../../bridges/")) {
      if (file.endsWith(path.join("server", "services", "acp-pool.js"))) continue;
      offenders.push(path.relative(repoRoot, file));
    }
  }
  assert.deepEqual(offenders, []);
});
