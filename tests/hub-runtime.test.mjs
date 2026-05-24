import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getHubRuntime, readHubLiveness, resetInstances } from "../server/services/hub-runtime.js";

describe("hub runtime liveness ownership", () => {
  let roots = [];

  beforeEach(async () => {
    resetInstances();
  });

  afterEach(async () => {
    resetInstances();
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }).catch(() => {})));
    roots = [];
  });

  async function tempRoot(prefix) {
    const root = await mkdtemp(path.join(os.tmpdir(), prefix));
    roots.push(root);
    return root;
  }

  it("does not let a second runtime persist over an already-live hub owner", async () => {
    const hubRoot = await tempRoot("cpb-hub-runtime-");
    const primaryRoot = await tempRoot("cpb-primary-runtime-");
    const secondaryRoot = await tempRoot("cpb-secondary-runtime-");

    const primary = getHubRuntime(primaryRoot, hubRoot);
    await primary.persist();

    const secondary = getHubRuntime(secondaryRoot, hubRoot);
    await secondary.persist();

    const raw = JSON.parse(await readFile(path.join(hubRoot, "state", "hub.json"), "utf8"));
    assert.equal(raw.health, "alive");
    assert.equal(raw.cpbRoot, path.resolve(primaryRoot));
  });

  it("does not let a second runtime mark another live hub owner as dead", async () => {
    const hubRoot = await tempRoot("cpb-hub-runtime-");
    const primaryRoot = await tempRoot("cpb-primary-runtime-");
    const secondaryRoot = await tempRoot("cpb-secondary-runtime-");

    const primary = getHubRuntime(primaryRoot, hubRoot);
    await primary.persist();

    const secondary = getHubRuntime(secondaryRoot, hubRoot);
    await secondary.markDead();

    const liveness = await readHubLiveness(hubRoot);
    assert.equal(liveness.alive, true);

    const raw = JSON.parse(await readFile(path.join(hubRoot, "state", "hub.json"), "utf8"));
    assert.equal(raw.health, "alive");
    assert.equal(raw.cpbRoot, path.resolve(primaryRoot));
  });
});
