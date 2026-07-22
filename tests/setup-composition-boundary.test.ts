import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const SETUP_AGGREGATE = path.join(REPO_ROOT, "server", "services", "setup.ts");
const SETUP_AGGREGATE_JS = path.join(REPO_ROOT, "server", "services", "setup.js");
const SOURCE_ROOTS = ["bridges", "cli", "scripts", "server", "runtime"].map((dir) => path.join(REPO_ROOT, dir));
const SOURCE_EXTENSIONS = /\.(?:ts|js|mjs)$/;
const CANONICAL_IMPORTS = [
  {
    file: "cli/commands/agents.ts",
    specifier: "../../server/services/setup-events.js",
    names: ["runInstallPlanWithEvents"],
  },
  {
    file: "cli/commands/setup.ts",
    specifier: "../../server/services/setup-events.js",
    names: ["runInstallPlanWithEvents"],
  },
  {
    file: "bridges/run-pipeline.ts",
    specifier: "../server/services/executor-root.js",
    names: ["executorEnv", "executorMetadata", "resolveExecutorRoot"],
  },
  {
    file: "bridges/project-worker.ts",
    specifier: "../server/services/executor-root.js",
    names: ["executorEnv", "resolveExecutorRoot"],
  },
  {
    file: "server/orchestrator/worker-supervisor.ts",
    specifier: "../services/executor-root.js",
    names: ["executorEnv", "resolveExecutorRoot"],
  },
  {
    file: "server/orchestrator/hub-orchestrator.ts",
    specifier: "../services/executor-root.js",
    names: ["resolveExecutorRoot"],
  },
  {
    file: "bridges/run-phase.ts",
    specifier: "../server/services/apply-variant.js",
    names: ["applyVariant"],
  },
  {
    file: "server/services/acp/acp-pool.ts",
    specifier: "../apply-variant.js",
    names: ["applyVariantToEnv", "resolveVariantConfig"],
  },
  {
    file: "server/services/readiness-checks.ts",
    specifier: "./executor-root.js",
    names: ["executorMetadata"],
  },
  {
    file: "server/services/release/release-store.ts",
    specifier: "../executor-root.js",
    names: ["assertExecutorRoot", "readExecutorPackage", "REQUIRED_EXECUTOR_FILES"],
  },
  {
    file: "scripts/e2e-npm-pack.ts",
    specifier: "../server/services/executor-root.js",
    names: ["REQUIRED_EXECUTOR_FILES"],
  },
  {
    file: "tests/integration/fake-acp-smoke.test.ts",
    specifier: "../../server/services/readiness-checks.js",
    names: ["runDemo"],
  },
];

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      files.push(...await listSourceFiles(full));
    } else if (SOURCE_EXTENSIONS.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function setupAggregateImportHits(source: string, file: string): string[] {
  const hits = new Set<string>();
  const patterns = [
    /from\s+["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
    /require\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source))) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) continue;
      const resolved = path.normalize(path.resolve(path.dirname(file), specifier));
      if (resolved === SETUP_AGGREGATE_JS) {
        hits.add(`${path.relative(REPO_ROOT, file)} -> ${specifier}`);
      }
    }
  }
  return [...hits];
}

function hasImportSpecifier(source: string, specifier: string) {
  return source.includes(`"${specifier}"`) || source.includes(`'${specifier}'`);
}

test("server/services/setup.ts aggregate is removed after composition-root migration", async () => {
  await assert.rejects(
    () => access(SETUP_AGGREGATE),
    { code: "ENOENT" },
    "server/services/setup.ts must not remain as a broad composition aggregate; split services must expose direct canonical imports",
  );
});

test("production runtime entrypoints import canonical service modules instead of setup aggregate", async () => {
  const hits = [];
  for (const root of SOURCE_ROOTS) {
    for (const file of await listSourceFiles(root)) {
      const source = await readFile(file, "utf8");
      hits.push(...setupAggregateImportHits(source, file));
    }
  }

  assert.deepEqual(
    hits.sort(),
    [],
    "production source must not import server/services/setup.js; migrate each consumer to the direct owning service module:\n" +
      hits.sort().join("\n"),
  );
});

test("current setup consumers use direct owning service imports", async () => {
  for (const expected of CANONICAL_IMPORTS) {
    const source = await readFile(path.join(REPO_ROOT, expected.file), "utf8");
    assert.equal(
      hasImportSpecifier(source, expected.specifier),
      true,
      `${expected.file} must import ${expected.names.join(", ")} from ${expected.specifier}`,
    );
    for (const name of expected.names) {
      assert.match(
        source,
        new RegExp(`\\b${name}\\b`),
        `${expected.file} must import ${name} from ${expected.specifier}`,
      );
    }
  }
});

test("migration plan and architecture docs do not preserve setup aggregate as an allowed boundary", async () => {
  const docs = [
    "server/services/MERGE_PLAN.json",
    "docs/architecture/runtime-boundaries.md",
    "docs/product/cpb-stabilization-baseline-2026-06-22.md",
  ];
  const staleFragments = [
    "server/services/setup.ts",
    "../services/setup.js",
    "../server/services/setup.js",
    "setup.ts aggregate remains",
    "setup.ts` aggregate remains",
  ];
  const hits = [];
  for (const doc of docs) {
    const source = await readFile(path.join(REPO_ROOT, doc), "utf8");
    for (const fragment of staleFragments) {
      if (source.includes(fragment)) hits.push(`${doc}: ${fragment}`);
    }
  }
  assert.deepEqual(
    hits,
    [],
    "docs and migration metadata must not document setup.ts as retained or canonical:\n" + hits.join("\n"),
  );
});

test("setup aggregate scanner catches static and dynamic imports", () => {
  const source = `
    import { executorEnv } from "../server/services/setup.js";
    const setup = await import("../services/setup.js");
  `;
  const fakeFile = path.join(REPO_ROOT, "bridges", "fake.ts");

  assert.deepEqual(setupAggregateImportHits(source, fakeFile), [
    "bridges/fake.ts -> ../server/services/setup.js",
  ]);
});
