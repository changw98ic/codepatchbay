import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  loadRegistry,
  mutateRegistry,
  registerProject,
  saveRegistry,
  updateProject,
} from "../server/services/hub/hub-registry.js";
import { writeProjectIndex } from "../server/services/project-index.js";

async function fixture() {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-hub-registry-"));
  const sourcePath = await mkdtemp(path.join(os.tmpdir(), "cpb-hub-source-"));
  const project = await registerProject(hubRoot, {
    id: "project",
    sourcePath,
    skipCodeGraphGate: true,
  });
  return { hubRoot, sourcePath, projectId: project.id };
}

async function runChild(script: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`registry child failed (${code ?? signal}): ${stderr}`));
    });
  });
}

test("registry transactions serialize concurrent read-modify-write operations", async () => {
  const { hubRoot, projectId } = await fixture();

  await Promise.all(Array.from({ length: 24 }, async () => {
    await mutateRegistry(hubRoot, async (registry) => {
      const project = registry.projects[projectId];
      const metadata = project.metadata || {};
      const counter = Number(metadata.concurrentCounter || 0);
      await delay(2);
      project.metadata = { ...metadata, concurrentCounter: counter + 1 };
    });
  }));

  const registry = await loadRegistry(hubRoot);
  assert.equal(registry.projects[projectId].metadata?.concurrentCounter, 24);
  assert.equal(registry.revision, 25);
});

test("registry transactions serialize real competing Node processes", async () => {
  const { hubRoot, projectId } = await fixture();
  const moduleUrl = new URL("../server/services/hub/hub-registry.js", import.meta.url).href;
  const script = `
    import { mutateRegistry } from ${JSON.stringify(moduleUrl)};
    const [hubRoot, projectId, iterationsText] = process.argv.slice(1);
    for (let index = 0; index < Number(iterationsText); index += 1) {
      await mutateRegistry(hubRoot, async (registry) => {
        const project = registry.projects[projectId];
        const metadata = project.metadata || {};
        const counter = Number(metadata.processCounter || 0);
        await new Promise((resolve) => setTimeout(resolve, 2));
        project.metadata = { ...metadata, processCounter: counter + 1 };
      });
    }
  `;

  await Promise.all(Array.from({ length: 4 }, () => runChild(script, [hubRoot, projectId, "8"])));
  const registry = await loadRegistry(hubRoot);
  assert.equal(registry.projects[projectId].metadata?.processCounter, 32);
  assert.equal(registry.revision, 33);
});

test("saveRegistry rejects a stale snapshot instead of losing a committed update", async () => {
  const { hubRoot, projectId } = await fixture();
  const first = await loadRegistry(hubRoot);
  const stale = await loadRegistry(hubRoot);

  first.projects[projectId].metadata = { committed: true };
  await saveRegistry(hubRoot, first);

  stale.projects[projectId].metadata = { staleOverwrite: true };
  await assert.rejects(
    saveRegistry(hubRoot, stale),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "HUB_REGISTRY_CONFLICT");
      return true;
    },
  );

  const registry = await loadRegistry(hubRoot);
  assert.equal(registry.projects[projectId].metadata?.committed, true);
  assert.equal(registry.projects[projectId].metadata?.staleOverwrite, undefined);
});

test("project index persistence participates in the registry transaction", async () => {
  const { hubRoot, projectId } = await fixture();
  let releaseTransaction!: () => void;
  const transactionMayFinish = new Promise<void>((resolve) => {
    releaseTransaction = resolve;
  });
  let transactionStarted!: () => void;
  const transactionIsRunning = new Promise<void>((resolve) => {
    transactionStarted = resolve;
  });

  const metadataUpdate = mutateRegistry(hubRoot, async (registry) => {
    transactionStarted();
    await transactionMayFinish;
    const project = registry.projects[projectId];
    project.metadata = { ...(project.metadata || {}), concurrentMarker: "preserved" };
  });
  await transactionIsRunning;

  let indexSettled = false;
  const indexUpdate = writeProjectIndex(hubRoot, null, projectId, {
    state: "indexed",
    branch: "main",
    gitHead: "1234567890abcdef",
    timestamp: new Date().toISOString(),
  }).finally(() => {
    indexSettled = true;
  });

  await delay(30);
  assert.equal(indexSettled, false, "project index write bypassed the active registry transaction");
  releaseTransaction();
  await Promise.all([metadataUpdate, indexUpdate]);

  const registry = await loadRegistry(hubRoot);
  assert.equal(registry.projects[projectId].metadata?.concurrentMarker, "preserved");
  const projectIndex = registry.projects[projectId].metadata?.projectIndex as { state?: string } | undefined;
  assert.equal(projectIndex?.state, "indexed");
});

test("an old timestamp cannot make a live same-host registry owner stealable", async () => {
  const { hubRoot, projectId } = await fixture();
  const lockDir = path.join(hubRoot, "projects.json.lock");
  await mkdir(lockDir);
  await writeFile(path.join(lockDir, "lock.json"), `${JSON.stringify({
    format: "cpb-hub-registry-lock/v1",
    ownerToken: "live-owner",
    ownerPid: process.pid,
    ownerHost: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
  })}\n`);

  try {
    let settled = false;
    const update = updateProject(hubRoot, projectId, { name: "after-live-owner-releases" })
      .finally(() => {
        settled = true;
      });
    await delay(100);
    assert.equal(settled, false, "the live owner's lock was stolen");
    const owner = JSON.parse(await readFile(path.join(lockDir, "lock.json"), "utf8"));
    assert.equal(owner.ownerToken, "live-owner");
    await rm(lockDir, { recursive: true, force: true });
    const updated = await update;
    assert.equal(updated?.name, "after-live-owner-releases");
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
});

test("a stale lock owned by a dead same-host process is recovered", async () => {
  const { hubRoot, projectId } = await fixture();
  const lockDir = path.join(hubRoot, "projects.json.lock");
  await mkdir(lockDir);
  await writeFile(path.join(lockDir, "lock.json"), `${JSON.stringify({
    format: "cpb-hub-registry-lock/v1",
    ownerToken: "dead-owner",
    ownerPid: 2_147_483_647,
    ownerHost: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
  })}\n`);
  const old = new Date(0);
  await utimes(lockDir, old, old);

  const updated = await updateProject(hubRoot, projectId, { name: "recovered" });
  assert.equal(updated?.name, "recovered");
  const registry = await loadRegistry(hubRoot);
  assert.equal(registry.projects[projectId].name, "recovered");
});

test("a symbolic-link registry lock is rejected without touching its target", async () => {
  const { hubRoot, projectId } = await fixture();
  const external = await mkdtemp(path.join(os.tmpdir(), "cpb-hub-lock-target-"));
  const sentinel = path.join(external, "sentinel.txt");
  await writeFile(sentinel, "preserve\n");
  await symlink(external, path.join(hubRoot, "projects.json.lock"));

  await assert.rejects(
    updateProject(hubRoot, projectId, { name: "must-not-commit" }),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "HUB_REGISTRY_LOCK_UNSAFE");
      return true;
    },
  );
  assert.equal(await readFile(sentinel, "utf8"), "preserve\n");
});

test("a symbolic-link registry file is rejected without modifying its target", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-hub-registry-link-"));
  const external = path.join(await mkdtemp(path.join(os.tmpdir(), "cpb-hub-registry-target-")), "target.json");
  const original = `${JSON.stringify({ version: 1, revision: 0, projects: {} })}\n`;
  await writeFile(external, original);
  await symlink(external, path.join(hubRoot, "projects.json"));

  await assert.rejects(
    loadRegistry(hubRoot),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "HUB_REGISTRY_UNSAFE");
      return true;
    },
  );
  await assert.rejects(
    saveRegistry(hubRoot, { projects: {} }),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "HUB_REGISTRY_UNSAFE");
      return true;
    },
  );
  assert.equal(await readFile(external, "utf8"), original);
});

test("oversized registry and lock metadata files fail closed with bounded errors", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-hub-registry-large-"));
  const registryHandle = await open(path.join(hubRoot, "projects.json"), "w");
  await registryHandle.truncate(16 * 1024 * 1024 + 1);
  await registryHandle.close();
  await assert.rejects(
    loadRegistry(hubRoot),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "HUB_REGISTRY_TOO_LARGE");
      return true;
    },
  );

  await rm(path.join(hubRoot, "projects.json"));
  const sourcePath = await mkdtemp(path.join(os.tmpdir(), "cpb-hub-large-source-"));
  const project = await registerProject(hubRoot, { id: "project", sourcePath, skipCodeGraphGate: true });
  const lockDir = path.join(hubRoot, "projects.json.lock");
  await mkdir(lockDir);
  const lockHandle = await open(path.join(lockDir, "lock.json"), "w");
  await lockHandle.truncate(16 * 1024 + 1);
  await lockHandle.close();
  await assert.rejects(
    updateProject(hubRoot, project.id, { name: "must-not-commit" }),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "HUB_REGISTRY_LOCK_TOO_LARGE");
      return true;
    },
  );
});

test("a transaction that loses its lock token cannot commit or remove the successor lock", async () => {
  const { hubRoot, projectId } = await fixture();
  const lockDir = path.join(hubRoot, "projects.json.lock");

  await assert.rejects(
    mutateRegistry(hubRoot, async (registry) => {
      const lockPath = path.join(lockDir, "lock.json");
      const lock = JSON.parse(await readFile(lockPath, "utf8"));
      await writeFile(lockPath, `${JSON.stringify({
        ...lock,
        ownerToken: "successor-owner",
        ownerPid: process.pid,
        ownerHost: os.hostname(),
      })}\n`);
      registry.projects[projectId].name = "must-not-commit";
    }),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "HUB_REGISTRY_LOCK_LOST");
      return true;
    },
  );

  const successor = JSON.parse(await readFile(path.join(lockDir, "lock.json"), "utf8"));
  assert.equal(successor.ownerToken, "successor-owner");
  const registry = await loadRegistry(hubRoot);
  assert.notEqual(registry.projects[projectId].name, "must-not-commit");
  await rm(lockDir, { recursive: true, force: true });
});
