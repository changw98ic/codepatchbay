import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { runPhase } from "../core/engine/run-phase.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
let counter = 0;

function pascalForPhase(phase: string) {
  return phase
    .split(/[_-]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

async function writePhaseAdapter(body: string) {
  counter += 1;
  const phase = `unit_run_phase_${process.pid}_${Date.now()}_${counter}`;
  const exportName = `run${pascalForPhase(phase)}`;
  const phasesDir = path.join(repoRoot, "core", "phases");
  await mkdir(phasesDir, { recursive: true });
  await writeFile(
    path.join(phasesDir, `${phase}.js`),
    `export async function ${exportName}(ctx) { ${body} }\n`,
    "utf8",
  );
  return phase;
}

test("runPhase loads an adapter, returns its result, and releases worktree resources", async () => {
  const phase = await writePhaseAdapter(`
    return {
      schemaVersion: 1,
      phase: ctx.phase,
      status: "passed",
      artifact: { kind: "test", name: ctx.phase },
      failure: null,
      diagnostics: {},
    };
  `);
  const releases: Array<{ cwd: string; reason: string; options: Record<string, unknown> }> = [];

  const result = await runPhase({
    phase,
    sourcePath: "/tmp/cpb-worktree",
    pool: {
      releaseWorktree: async (cwd: string, reason: string, options: Record<string, unknown>) => {
        releases.push({ cwd, reason, options });
      },
    },
  });

  assert.equal(result.status, "passed");
  assert.equal(result.phase, phase);
  assert.deepEqual(releases, [{
    cwd: "/tmp/cpb-worktree",
    reason: `phase_${phase}_complete`,
    options: { closeProvider: true },
  }]);
});

test("runPhase converts adapter errors to failed phase results and still releases resources", async () => {
  const phase = await writePhaseAdapter('throw new Error("adapter exploded");');
  const releases: string[] = [];

  const result = await runPhase({
    phase,
    cpbRoot: "/tmp/cpb-root",
    pool: {
      releaseWorktree: async (cwd: string) => {
        releases.push(cwd);
      },
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.phase, phase);
  assert.equal(result.failure?.kind, "unknown");
  assert.equal(result.failure?.reason, "adapter exploded");
  assert.deepEqual(releases, ["/tmp/cpb-root"]);
});

test("runPhase rethrows pool exhaustion while still releasing resources", async () => {
  const phase = await writePhaseAdapter(`
    const err = new Error("pool empty");
    err.code = "POOL_EXHAUSTED";
    err.name = "PoolExhaustedError";
    throw err;
  `);
  const releases: string[] = [];

  await assert.rejects(
    runPhase({
      phase,
      cwd: "/tmp/cpb-cwd",
      pool: {
        releaseWorktree: async (cwd: string) => {
          releases.push(cwd);
        },
      },
    }),
    /pool empty/,
  );
  assert.deepEqual(releases, ["/tmp/cpb-cwd"]);
});
