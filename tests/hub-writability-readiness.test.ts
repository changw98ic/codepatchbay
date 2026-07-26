import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  checkHubWritability,
  withHubWritabilityProbeTestHooksForTests,
} from "../server/services/readiness-checks.js";
import { tempRoot } from "./helpers.js";

type WritabilityDetails = {
  path: string;
  probeDir: string;
  probeFile: string;
  persistent: boolean;
  slot?: number;
  slotCount?: number;
  fileBytes?: number;
  code?: string | null;
  error?: string;
  errors?: Array<{ code?: string | null; message?: string }>;
};

function details(result: { details?: unknown }) {
  return result.details as WritabilityDetails;
}

async function assertPersistentProbeEvidence(probeFile: string) {
  const content = await readFile(probeFile);
  assert.equal(content.byteLength, 32 * 1024);
  assert.equal(content.includes(Buffer.from("cpb-hub-writability-probe/v1 ", "utf8")), true);
}

async function hubFixture(label: string) {
  const root = await tempRoot(`cpb-hub-writability-${label}`);
  return { root, hubRoot: path.join(root, "hub") };
}

async function disposeFixture(root: string) {
  if (!path.basename(root).startsWith("cpb-hub-writability-")) {
    throw new Error(`refusing to remove unexpected Hub writability fixture: ${root}`);
  }
  await rm(root, { recursive: true, force: true });
}

test("Hub writability probe performs a durable readback and retains its private evidence", async () => {
  const fixture = await hubFixture("normal");
  try {
    const result = await checkHubWritability(fixture.hubRoot);
    assert.equal(result.status, "ok");
    const evidence = details(result);
    assert.equal(evidence.persistent, true);
    assert.equal(path.dirname(evidence.probeFile), evidence.probeDir);
    assert.equal(evidence.slotCount, 256);
    assert.equal(evidence.fileBytes, 32 * 1024);
    const slotBytes = Number(evidence.fileBytes) / Number(evidence.slotCount);
    const content = await readFile(evidence.probeFile);
    const slot = content.subarray(Number(evidence.slot) * slotBytes, (Number(evidence.slot) + 1) * slotBytes);
    assert.match(slot.toString("utf8"), /^cpb-hub-writability-probe\/v1 [0-9a-f-]+\n/);
    const fileStats = await lstat(evidence.probeFile);
    const directoryStats = await lstat(evidence.probeDir);
    assert.equal(fileStats.isFile(), true);
    assert.equal(fileStats.isSymbolicLink(), false);
    assert.equal(fileStats.nlink, 1);
    assert.equal(fileStats.mode & 0o777, 0o600);
    assert.equal(directoryStats.isDirectory(), true);
    assert.equal(directoryStats.isSymbolicLink(), false);
    assert.equal(directoryStats.mode & 0o777, 0o700);
  } finally {
    await disposeFixture(fixture.root);
  }
});

test("high-frequency concurrent Hub writability probes stay within one bounded persistent file", async () => {
  const fixture = await hubFixture("concurrent");
  try {
    const results = await Promise.all(Array.from({ length: 64 }, () => checkHubWritability(fixture.hubRoot)));
    for (let index = 0; index < 100; index += 1) {
      results.push(await checkHubWritability(fixture.hubRoot));
    }
    assert.equal(results.every((result) => result.status === "ok"), true);
    const probeFiles = results.map((result) => details(result).probeFile);
    assert.equal(new Set(probeFiles).size, 1);
    const entries = await readdir(details(results[0]).probeDir);
    assert.deepEqual(entries, ["writability-slots-v1.bin"]);
    assert.equal((await lstat(probeFiles[0])).size, details(results[0]).fileBytes);
  } finally {
    await disposeFixture(fixture.root);
  }
});

test("Hub writability probe safely initializes an owner-bound empty persistent slot file", async () => {
  const fixture = await hubFixture("empty-file");
  const probeDir = path.join(fixture.hubRoot, "state", ".readiness-probes");
  const probeFile = path.join(probeDir, "writability-slots-v1.bin");
  try {
    await mkdir(probeDir, { recursive: true, mode: 0o700 });
    await writeFile(probeFile, "", { encoding: "utf8", mode: 0o600 });

    const result = await checkHubWritability(fixture.hubRoot);
    assert.equal(result.status, "ok");
    assert.equal(path.basename(details(result).probeFile), path.basename(probeFile));
    await assertPersistentProbeEvidence(details(result).probeFile);
    assert.deepEqual(await readdir(probeDir), ["writability-slots-v1.bin"]);
  } finally {
    await disposeFixture(fixture.root);
  }
});

test("Hub writability probe rejects and preserves a symlink successor", async () => {
  const fixture = await hubFixture("symlink");
  let ownedFile = "";
  try {
    const result = await withHubWritabilityProbeTestHooksForTests({
      async afterProbeWritten({ probeFile }) {
        ownedFile = `${probeFile}.owned`;
        await rename(probeFile, ownedFile);
        await symlink(ownedFile, probeFile);
      },
    }, () => checkHubWritability(fixture.hubRoot));

    assert.equal(result.status, "error");
    assert.equal(details(result).code, "HUB_WRITABILITY_PROBE_UNSAFE_PATH");
    assert.equal((await lstat(details(result).probeFile)).isSymbolicLink(), true);
    await assertPersistentProbeEvidence(ownedFile);
  } finally {
    await disposeFixture(fixture.root);
  }
});

test("Hub writability probe never follows a pre-existing probe-directory symlink", async () => {
  const fixture = await hubFixture("directory-symlink");
  const stateDir = path.join(fixture.hubRoot, "state");
  const targetDir = path.join(fixture.root, "symlink-target");
  const probeDir = path.join(stateDir, ".readiness-probes");
  try {
    await mkdir(stateDir, { recursive: true });
    await mkdir(targetDir, { mode: 0o700 });
    await symlink(targetDir, probeDir, "dir");

    const result = await checkHubWritability(fixture.hubRoot);
    assert.equal(result.status, "error");
    assert.equal(details(result).code, "HUB_WRITABILITY_PROBE_UNSAFE_PATH");
    assert.equal((await lstat(probeDir)).isSymbolicLink(), true);
    assert.deepEqual(await readdir(targetDir), []);
  } finally {
    await disposeFixture(fixture.root);
  }
});

test("Hub writability probe rejects and preserves a hard-linked generation", async () => {
  const fixture = await hubFixture("hardlink");
  let hardlink = "";
  try {
    const result = await withHubWritabilityProbeTestHooksForTests({
      async afterProbeWritten({ probeFile }) {
        hardlink = `${probeFile}.hardlink`;
        await link(probeFile, hardlink);
      },
    }, () => checkHubWritability(fixture.hubRoot));

    assert.equal(result.status, "error");
    assert.equal(details(result).code, "HUB_WRITABILITY_PROBE_HARDLINKED");
    assert.equal((await lstat(details(result).probeFile)).nlink, 2);
    assert.equal((await lstat(hardlink)).nlink, 2);
  } finally {
    await disposeFixture(fixture.root);
  }
});

test("Hub writability probe rejects unsafe file permissions without deleting evidence", async () => {
  const fixture = await hubFixture("permissions");
  try {
    const result = await withHubWritabilityProbeTestHooksForTests({
      async afterProbeWritten({ probeFile }) {
        await chmod(probeFile, 0o666);
      },
    }, () => checkHubWritability(fixture.hubRoot));

    assert.equal(result.status, "error");
    assert.equal(details(result).code, "HUB_WRITABILITY_PROBE_UNSAFE_PERMISSIONS");
    assert.equal((await lstat(details(result).probeFile)).mode & 0o777, 0o666);
  } finally {
    await disposeFixture(fixture.root);
  }
});

test("Hub writability probe rejects a same-mode replacement and preserves both generations", async () => {
  const fixture = await hubFixture("replacement");
  let ownedFile = "";
  try {
    const result = await withHubWritabilityProbeTestHooksForTests({
      async afterProbeWritten({ probeFile }) {
        ownedFile = `${probeFile}.owned`;
        await rename(probeFile, ownedFile);
        await writeFile(probeFile, "hostile successor\n", { encoding: "utf8", mode: 0o600 });
      },
    }, () => checkHubWritability(fixture.hubRoot));

    assert.equal(result.status, "error");
    assert.equal(details(result).code, "HUB_WRITABILITY_PROBE_IDENTITY_CHANGED");
    assert.equal(await readFile(details(result).probeFile, "utf8"), "hostile successor\n");
    await assertPersistentProbeEvidence(ownedFile);
  } finally {
    await disposeFixture(fixture.root);
  }
});

test("Hub writability probe rejects a state-directory successor without deleting either generation", async () => {
  const fixture = await hubFixture("state-replacement");
  let ownedState = "";
  let ownedProbe = "";
  try {
    const result = await withHubWritabilityProbeTestHooksForTests({
      async afterProbeWritten({ stateDir, probeFile }) {
        ownedState = `${stateDir}.owned`;
        ownedProbe = path.join(ownedState, path.relative(stateDir, probeFile));
        await rename(stateDir, ownedState);
        await mkdir(stateDir, { mode: 0o700 });
        await writeFile(path.join(stateDir, "successor.txt"), "preserve state successor\n", "utf8");
      },
    }, () => checkHubWritability(fixture.hubRoot));

    assert.equal(result.status, "error");
    assert.equal(details(result).code, "HUB_WRITABILITY_PROBE_IDENTITY_CHANGED");
    assert.equal(await readFile(path.join(details(result).path, "successor.txt"), "utf8"), "preserve state successor\n");
    await assertPersistentProbeEvidence(ownedProbe);
  } finally {
    await disposeFixture(fixture.root);
  }
});

test("Hub writability probe reports a handle close failure after a successful readback", async () => {
  const fixture = await hubFixture("close");
  try {
    const result = await withHubWritabilityProbeTestHooksForTests({
      async closeHandle({ stage, close }) {
        await close();
        if (stage === "probe-file") throw Object.assign(new Error("simulated probe close failure"), { code: "EIO" });
      },
    }, () => checkHubWritability(fixture.hubRoot));

    assert.equal(result.status, "error");
    assert.equal(details(result).code, "HUB_WRITABILITY_PROBE_CLOSE_FAILED");
    assert.match(details(result).error || "", /simulated probe close failure/);
    await assertPersistentProbeEvidence(details(result).probeFile);
  } finally {
    await disposeFixture(fixture.root);
  }
});

test("Hub writability probe preserves both replacement and close failures", async () => {
  const fixture = await hubFixture("primary-close");
  let ownedFile = "";
  try {
    const result = await withHubWritabilityProbeTestHooksForTests({
      async afterProbeWritten({ probeFile }) {
        ownedFile = `${probeFile}.owned`;
        await rename(probeFile, ownedFile);
        await writeFile(probeFile, "hostile successor\n", { encoding: "utf8", mode: 0o600 });
      },
      async closeHandle({ stage, close }) {
        await close();
        if (stage === "probe-file") throw Object.assign(new Error("simulated close after replacement"), { code: "EIO" });
      },
    }, () => checkHubWritability(fixture.hubRoot));

    const evidence = details(result);
    assert.equal(result.status, "error");
    assert.equal(evidence.code, "HUB_WRITABILITY_PROBE_AND_CLOSE_FAILED");
    assert.deepEqual(evidence.errors?.map((entry) => entry.code), [
      "HUB_WRITABILITY_PROBE_IDENTITY_CHANGED",
      "HUB_WRITABILITY_PROBE_CLOSE_FAILED",
    ]);
    assert.match(evidence.errors?.[0]?.message || "", /changed during the writability check/);
    assert.match(evidence.errors?.[1]?.message || "", /simulated close after replacement/);
    assert.equal(await readFile(evidence.probeFile, "utf8"), "hostile successor\n");
    await assertPersistentProbeEvidence(ownedFile);
  } finally {
    await disposeFixture(fixture.root);
  }
});
