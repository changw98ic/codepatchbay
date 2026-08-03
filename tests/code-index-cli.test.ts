import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

type CliResult = Readonly<{
  status: number | null;
  stdout: string;
  stderr: string;
}>;

function runCodeIndexCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): CliResult {
  const result = spawnSync(
    process.execPath,
    [path.resolve("dist/cli/cpb.js"), "code-index", ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...env, NO_COLOR: "1" },
    },
  );
  return {
    status: result.status,
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
}

async function fixture(label: string): Promise<Readonly<{
  root: string;
  sourcePath: string;
  cpbRoot: string;
}>> {
  const root = await mkdtemp(path.join(os.tmpdir(), `cpb-cli-${label}-`));
  const sourcePath = path.join(root, "source");
  const cpbRoot = path.join(root, "runtime");
  await mkdir(sourcePath, { recursive: true });
  await mkdir(cpbRoot, { recursive: true });
  await writeFile(
    path.join(sourcePath, "main.ts"),
    "export function cliFixture(): string { return 'ok'; }\n",
  );
  return { root, sourcePath, cpbRoot };
}

test("status --json is machine-readable and exits 1 when the canonical index is missing", async () => {
  const fx = await fixture("missing");
  try {
    const result = runCodeIndexCli([
      "status",
      fx.sourcePath,
      "--cpb-root",
      fx.cpbRoot,
      "--json",
    ]);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(
      {
        available: parsed.available,
        fresh: parsed.fresh,
        exact: parsed.exact,
        reason: parsed.reason,
      },
      {
        available: false,
        fresh: false,
        exact: false,
        reason: "missing_local_code_index",
      },
    );
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("build and status use the canonical v2 snapshot", async () => {
  const fx = await fixture("built");
  try {
    const build = runCodeIndexCli([
      "build",
      fx.sourcePath,
      "--cpb-root",
      fx.cpbRoot,
      "--json",
    ]);
    assert.equal(build.status, 0, build.stderr || build.stdout);
    const buildResult = JSON.parse(build.stdout);
    assert.equal(buildResult.available, true);
    assert.equal(buildResult.ref.schemaVersion, 2);

    const status = runCodeIndexCli([
      "status",
      fx.sourcePath,
      "--cpb-root",
      fx.cpbRoot,
      "--json",
    ]);
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const statusResult = JSON.parse(status.stdout);
    assert.equal(statusResult.available, true);
    assert.equal(statusResult.fresh, true);
    assert.equal(statusResult.exact, true);
    assert.equal(statusResult.ref.snapshotId, buildResult.ref.snapshotId);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("status exits 1 and reports stale after the source changes", async () => {
  const fx = await fixture("stale");
  try {
    const build = runCodeIndexCli([
      "build",
      fx.sourcePath,
      "--cpb-root",
      fx.cpbRoot,
      "--json",
    ]);
    assert.equal(build.status, 0, build.stderr || build.stdout);
    await writeFile(path.join(fx.sourcePath, "changed.ts"), "export const changed = true;\n");

    const status = runCodeIndexCli([
      "status",
      fx.sourcePath,
      "--cpb-root",
      fx.cpbRoot,
      "--json",
    ]);
    assert.equal(status.status, 1, status.stderr || status.stdout);
    const parsed = JSON.parse(status.stdout);
    assert.equal(parsed.available, true);
    assert.equal(parsed.fresh, false);
    assert.equal(parsed.exact, true);
    assert.equal(parsed.reason, "local_code_index_stale");
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("query crosses only the canonical v2 query interface", async () => {
  const fx = await fixture("query");
  try {
    const build = runCodeIndexCli([
      "build",
      fx.sourcePath,
      "--cpb-root",
      fx.cpbRoot,
      "--json",
    ]);
    assert.equal(build.status, 0, build.stderr || build.stdout);

    const query = runCodeIndexCli([
      "query",
      "definitions",
      "--symbol",
      "cliFixture",
      "--source",
      fx.sourcePath,
      "--cpb-root",
      fx.cpbRoot,
      "--json",
    ]);
    assert.equal(query.status, 0, query.stderr || query.stdout);
    const result = JSON.parse(query.stdout);
    assert.equal(result.kind, "definitions");
    assert.ok(result.occurrences.some((item: { symbol: string }) => item.symbol === "cliFixture"));
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("query rejects the removed selector-flag syntax", async () => {
  const fx = await fixture("removed-query-syntax");
  try {
    const query = runCodeIndexCli([
      "query",
      "--source",
      fx.sourcePath,
      "--cpb-root",
      fx.cpbRoot,
      "--definitions",
      "cliFixture",
      "--json",
    ]);
    assert.equal(query.status, 2, query.stderr || query.stdout);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("explicit --cpb-root wins over the router CPB_ROOT", async () => {
  const fx = await fixture("precedence");
  const routerRoot = path.join(fx.root, "router-runtime");
  await mkdir(routerRoot, { recursive: true });
  try {
    const build = runCodeIndexCli(
      [
        "build",
        fx.sourcePath,
        "--cpb-root",
        fx.cpbRoot,
        "--json",
      ],
      {
        ...process.env,
        CPB_ROOT: routerRoot,
        CPB_EXECUTOR_ROOT: path.resolve("dist"),
      },
    );
    assert.equal(build.status, 0, build.stderr || build.stdout);

    const explicitStatus = runCodeIndexCli(
      [
        "status",
        fx.sourcePath,
        "--cpb-root",
        fx.cpbRoot,
        "--json",
      ],
      {
        ...process.env,
        CPB_ROOT: routerRoot,
        CPB_EXECUTOR_ROOT: path.resolve("dist"),
      },
    );
    assert.equal(explicitStatus.status, 0, explicitStatus.stderr || explicitStatus.stdout);

    const routerStatus = runCodeIndexCli(
      ["status", fx.sourcePath, "--json"],
      {
        ...process.env,
        CPB_ROOT: routerRoot,
        CPB_EXECUTOR_ROOT: path.resolve("dist"),
      },
    );
    assert.equal(routerStatus.status, 1, routerStatus.stderr || routerStatus.stdout);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("ambiguous source syntax exits 2", async () => {
  const fx = await fixture("syntax");
  try {
    const result = runCodeIndexCli([
      "status",
      fx.sourcePath,
      "--source",
      fx.sourcePath,
      "--cpb-root",
      fx.cpbRoot,
      "--json",
    ]);
    assert.equal(result.status, 2, result.stderr || result.stdout);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("unknown status options and invalid repair scope exit 2", async () => {
  const fx = await fixture("syntax-options");
  try {
    const status = runCodeIndexCli(["status", fx.sourcePath, "--bogus", "--json"]);
    assert.equal(status.status, 2, status.stderr || status.stdout);
    const repair = runCodeIndexCli([
      "repair-lock",
      fx.sourcePath,
      "--cpb-root",
      fx.cpbRoot,
      "--scope",
      "invalid",
      "--action",
      "quarantine-stale",
      "--json",
    ]);
    assert.equal(repair.status, 2, repair.stderr || repair.stdout);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("canonical CLI never writes a legacy index.json", async () => {
  const fx = await fixture("no-legacy-index");
  try {
    const result = runCodeIndexCli([
      "build",
      fx.sourcePath,
      "--cpb-root",
      fx.cpbRoot,
      "--json",
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    await assert.rejects(
      readFile(path.join(fx.cpbRoot, "indexes", "local-code", "v2", "index.json")),
      /ENOENT/,
    );
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});
