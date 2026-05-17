import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

function envFor(hubRoot) {
  return { ...process.env, CPB_HUB_ROOT: hubRoot };
}

test("cpb attach writes a project to the global Hub registry", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-hub-"));
  const projectRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-project-"));
  const canonicalProjectRoot = await realpath(projectRoot);

  const { stdout } = await execFileAsync("./cpb", ["attach", projectRoot, "cli-project"], {
    cwd: process.cwd(),
    env: envFor(hubRoot),
  });
  const attached = JSON.parse(stdout);

  assert.equal(attached.attached, true);
  assert.equal(attached.project.id, "cli-project");
  assert.equal(attached.project.sourcePath, canonicalProjectRoot);

  const projects = JSON.parse((await execFileAsync("./cpb", ["hub", "projects", "--json"], {
    cwd: process.cwd(),
    env: envFor(hubRoot),
  })).stdout);

  assert.equal(projects.length, 1);
  assert.equal(projects[0].id, "cli-project");
});

test("cpb evolve-multi dry-run consumes Hub registry projects", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-hub-evolve-"));
  const projectRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-project-evolve-"));
  const canonicalProjectRoot = await realpath(projectRoot);

  await execFileAsync("./cpb", ["attach", projectRoot, "cli-evolve"], {
    cwd: process.cwd(),
    env: envFor(hubRoot),
  });

  const { stdout } = await execFileAsync("./cpb", ["evolve-multi", "--dry-run"], {
    cwd: process.cwd(),
    env: envFor(hubRoot),
  });
  const result = JSON.parse(stdout);

  assert.equal(result.dryRun, true);
  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0].id, "cli-evolve");
  assert.equal(result.projects[0].sourcePath, canonicalProjectRoot);
});
