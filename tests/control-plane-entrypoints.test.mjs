import { describe, it } from "node:test";
import { ok, strictEqual } from "node:assert";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

const FORBIDDEN_PATTERNS = [
  /cpb-task\/events/,
  /cpb-task\/leases/,
  /mkdir.*LOCK_DIR/,
  /record_repair_event/,
  /create_lineage_task/,
  /\.jsonl.*>>/,
  /queue\.json/,
];

async function read(relPath) {
  return readFile(path.join(ROOT, relPath), "utf8");
}

function assertNoForbiddenPatterns(label, content) {
  for (const pat of FORBIDDEN_PATTERNS) {
    ok(!pat.test(content), `${label}: must not contain forbidden pattern ${pat}`);
  }
}

// ─── 1. Shell wrappers are thin ───

describe("control-plane entrypoints", () => {
  const thinWrappers = [
    "bridges/planner.sh",
    "bridges/executor.sh",
    "bridges/verifier.sh",
    "bridges/reviewer.sh",
    "bridges/run-pipeline.sh",
  ];

  for (const relPath of thinWrappers) {
    describe(relPath, () => {
      it("forwards to Node via exec (direct or array expansion)", async () => {
        const src = await read(relPath);
        const direct = /\bexec\s+node\b/.test(src);
        const viaArray = /\bexec\s+"?\$\{?cmd/.test(src);
        ok(direct || viaArray, `${relPath} must forward to Node via exec`);
      });

      it("does not contain direct state mutation patterns", async () => {
        const src = await read(relPath);
        assertNoForbiddenPatterns(relPath, src);
      });

      it("does not source common.sh", async () => {
        const src = await read(relPath);
        ok(!/source.*common\.sh/.test(src), `${relPath} must not source common.sh`);
        ok(!/^\.\s+.*common\.sh/.test(src), `${relPath} must not source common.sh via dot syntax`);
      });
    });
  }

  // ─── 2. repairer.sh is thin ───

  describe("bridges/repairer.sh", () => {
    it("contains exec node (forwarding to Node)", async () => {
      const src = await read("bridges/repairer.sh");
      ok(/exec node/.test(src), "repairer.sh must contain 'exec node'");
    });

    it("forwards to run-phase.mjs repair", async () => {
      const src = await read("bridges/repairer.sh");
      ok(/run-phase\.mjs/.test(src), "repairer.sh must reference run-phase.mjs");
      ok(/\brepair\b/.test(src), "repairer.sh must pass 'repair' as the phase argument");
    });

    it("does not contain direct state mutation patterns", async () => {
      const src = await read("bridges/repairer.sh");
      assertNoForbiddenPatterns("bridges/repairer.sh", src);
    });

    it("does not source common.sh", async () => {
      const src = await read("bridges/repairer.sh");
      ok(!/source.*common\.sh/.test(src), "repairer.sh must not source common.sh");
      ok(!/^\.\s+.*common\.sh/.test(src), "repairer.sh must not source common.sh via dot syntax");
    });
  });

  // ─── 3. Node services don't delegate to Rust ───

  describe("Node workflow services do not import shouldUseRustRuntime", () => {
    const nodeOnlyServices = [
      "server/services/job-store.js",
      "server/services/lease-manager.js",
      "server/services/hub-queue.js",
      "server/services/runtime-events.js",
    ];

    for (const relPath of nodeOnlyServices) {
      it(`${relPath} does not import shouldUseRustRuntime`, async () => {
        const src = await read(relPath);
        ok(
          !src.includes("shouldUseRustRuntime"),
          `${relPath} must not import shouldUseRustRuntime`,
        );
      });
    }
  });

  // ─── 4. Node identity/reporting services don't delegate to Rust ───

  describe("Node identity/reporting services do not import shouldUseRustRuntime", () => {
    const reportingServices = [
      "server/services/version-identity.js",
      "server/services/hub-runtime.js",
      "server/services/observability.js",
    ];

    for (const relPath of reportingServices) {
      it(`${relPath} does not import shouldUseRustRuntime`, async () => {
        const src = await read(relPath);
        ok(
          !src.includes("shouldUseRustRuntime"),
          `${relPath} must not import shouldUseRustRuntime`,
        );
      });
    }
  });

  // ─── 5. run-pipeline.mjs uses dispatchPhase ───

  describe("bridges/run-pipeline.mjs phase dispatch", () => {
    it("imports dispatchPhase from phase-runner.js", async () => {
      const src = await read("bridges/run-pipeline.mjs");
      ok(
        src.includes('import { dispatchPhase }') || src.includes("import { dispatchPhase }"),
        "run-pipeline.mjs must import dispatchPhase from phase-runner.js",
      );
      ok(
        src.includes("phase-runner.js"),
        "run-pipeline.mjs must import from phase-runner.js",
      );
    });

    it("does not define runPhaseWithLease or runBridge functions", async () => {
      const src = await read("bridges/run-pipeline.mjs");
      ok(
        !/function\s+runPhaseWithLease/.test(src),
        "run-pipeline.mjs must not define runPhaseWithLease",
      );
      ok(
        !/function\s+runBridge/.test(src),
        "run-pipeline.mjs must not define runBridge",
      );
    });
  });
});
