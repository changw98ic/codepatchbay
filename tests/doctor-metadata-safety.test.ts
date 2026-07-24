import assert from "node:assert/strict";
import { readFile, symlink, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { _readDoctorJsonFileForTests } from "../cli/commands/doctor.js";
import { tempRoot } from "./helpers.js";

test("doctor metadata reader refuses a symlink without reading its target", async () => {
  const root = await tempRoot("cpb-doctor-metadata-symlink");
  const target = path.join(root, "target.json");
  const candidate = path.join(root, "lease.json");
  await writeFile(target, `${JSON.stringify({ ownerToken: "outside" })}\n`, "utf8");
  await symlink(target, candidate);

  await assert.rejects(_readDoctorJsonFileForTests(candidate), { code: "BOUNDED_FILE_UNSAFE" });
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { ownerToken: "outside" });
});

test("doctor metadata reader refuses an oversized sparse file", async () => {
  const root = await tempRoot("cpb-doctor-metadata-oversized");
  const candidate = path.join(root, "lease.json");
  await writeFile(candidate, "{}\n", "utf8");
  await truncate(candidate, 64 * 1024 + 1);

  await assert.rejects(_readDoctorJsonFileForTests(candidate), { code: "BOUNDED_FILE_TOO_LARGE" });
});
