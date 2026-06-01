import { execFile as execFileCb } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const repoRoot = path.resolve(import.meta.dirname, "..");

describe("legacy queue daemon removal", () => {
  it("removes cpb daemon as a CLI entrypoint", async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-no-daemon-"));

    try {
      await assert.rejects(
        execFile(process.execPath, [path.join(repoRoot, "cli", "cpb.mjs"), "daemon", "status"], {
          cwd: tmpRoot,
          env: {
            ...process.env,
            CPB_ROOT: tmpRoot,
            CPB_EXECUTOR_ROOT: repoRoot,
            CPB_HUB_ROOT: path.join(tmpRoot, "hub"),
          },
        }),
        (error) => {
          assert.equal(error.code, 1);
          assert.match(error.stderr, /Unknown command:.*daemon/);
          return true;
        },
      );
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("keeps Hub shutdown independent of the removed queue-daemon service", async () => {
    const hubCli = await readFile(path.join(repoRoot, "server", "services", "hub-cli.js"), "utf8");

    assert.doesNotMatch(hubCli, /queue-daemon/);
    assert.doesNotMatch(hubCli, /stopDaemon/);
  });
});
