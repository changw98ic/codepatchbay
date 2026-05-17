import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const hasRuntimeBinary = Boolean(process.env.CPB_RUNTIME_BIN);

test("cpb attach uses Rust registry upsert when CPB_RUNTIME=rust", { skip: !hasRuntimeBinary }, async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-rust-registry-hub-"));
  const projectRoot = await mkdtemp(path.join(tmpdir(), "cpb-rust-registry-project-"));
  const canonicalProjectRoot = await realpath(projectRoot);
  const wrapperDir = await mkdtemp(path.join(tmpdir(), "cpb-rust-registry-wrapper-"));
  const wrapper = path.join(wrapperDir, "runtime-wrapper.sh");
  const logPath = path.join(wrapperDir, "runtime.log");
  const runtimeBin = path.resolve(process.env.CPB_RUNTIME_BIN);

  await writeFile(wrapper, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${logPath}"\nexec "${runtimeBin}" "$@"\n`, "utf8");
  await chmod(wrapper, 0o755);

  const env = {
    ...process.env,
    CPB_HUB_ROOT: hubRoot,
    CPB_RUNTIME: "rust",
    CPB_RUNTIME_BIN: wrapper,
  };

  const { stdout } = await execFileAsync("./cpb", ["attach", projectRoot, "rust-project"], {
    cwd: process.cwd(),
    env,
  });
  const attached = JSON.parse(stdout);
  assert.equal(attached.project.sourcePath, canonicalProjectRoot);

  const log = await readFile(logPath, "utf8");
  assert.match(log, /registry upsert/);

  const projects = JSON.parse((await execFileAsync("./cpb", ["hub", "projects", "--json"], {
    cwd: process.cwd(),
    env,
  })).stdout);
  assert.equal(projects[0].id, "rust-project");
});
