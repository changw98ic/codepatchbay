import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("cpb hub acp shows durable provider backoff", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-acp-hub-"));
  await mkdir(path.join(hubRoot, "providers"), { recursive: true });
  await writeFile(
    path.join(hubRoot, "providers", "rate-limits.json"),
    JSON.stringify({
      codex: {
        agent: "codex",
        untilTs: "2026-05-17T10:00:00.000Z",
        reason: "429",
      },
    }),
    "utf8",
  );

  const { stdout } = await execFileAsync("./cpb", ["hub", "acp", "--json"], {
    cwd: process.cwd(),
    env: { ...process.env, CPB_HUB_ROOT: hubRoot },
  });
  const status = JSON.parse(stdout);

  assert.equal(status.pools.codex.mode, "bounded-one-shot");
  assert.equal(status.rateLimits.codex.reason, "429");
});
