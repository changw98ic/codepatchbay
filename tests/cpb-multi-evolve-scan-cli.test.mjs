import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

function envFor(hubRoot, extra = {}) {
  return { ...process.env, CPB_HUB_ROOT: hubRoot, ...extra };
}

test("cpb evolve-multi --scan --dry-run writes project backlog from scan output", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-scan-hub-"));
  const projectRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-scan-project-"));
  const canonicalProjectRoot = await realpath(projectRoot);

  await execFileAsync("./cpb", ["attach", projectRoot, "scan-project"], {
    cwd: process.cwd(),
    env: envFor(hubRoot),
  });

  const { stdout } = await execFileAsync("./cpb", ["evolve-multi", "--scan", "--dry-run"], {
    cwd: process.cwd(),
    env: envFor(hubRoot, {
      CPB_MULTI_EVOLVE_SCAN_FIXTURE: "[ISSUE] P1 tighten CLI scan-only coverage",
    }),
  });
  const result = JSON.parse(stdout);

  assert.equal(result.dryRun, true);
  assert.equal(result.projects[0].id, "scan-project");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].description, "tighten CLI scan-only coverage");

  const backlogPath = path.join(canonicalProjectRoot, "cpb-task", "evolve", "scan-project", "backlog.json");
  const backlog = JSON.parse(await readFile(backlogPath, "utf8"));
  assert.equal(backlog.length, 1);
  assert.equal(backlog[0].status, "pending");
});
