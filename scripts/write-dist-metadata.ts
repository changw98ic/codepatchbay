#!/usr/bin/env node
// @ts-nocheck
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const distRoot = path.join(repoRoot, "dist");

const rootPackage = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));

const distPackage = {
  name: rootPackage.name,
  version: rootPackage.version,
  license: rootPackage.license,
  type: "module",
  bin: {
    cpb: "cpb",
    "cpb-browser-agent-acp": "server/services/browser-agent-acp.js",
    "cpb-test-acp-agent": "server/services/test-acp-agent.js",
  },
  files: [
    "cpb",
    "bridges/",
    "cli/",
    "core/",
    "shared/",
    "runtime/",
    "server/",
    "scripts/",
    "profiles/",
    "skills/",
    "templates/",
    "wiki/schema.md",
    "wiki/projects/_template/",
    "web/dist/",
    "!tests/",
    "!server/.omc/",
  ],
  dependencies: rootPackage.dependencies || {},
  engines: rootPackage.engines || {},
  scripts: {
    test: "node scripts/run-node-tests.js",
    "test:node": "node scripts/run-node-tests.js",
    "test:unit": "node scripts/run-node-tests.js --unit",
    "test:integration": "node scripts/run-node-tests.js --integration",
  },
};

await mkdir(distRoot, { recursive: true });
await writeFile(path.join(distRoot, "package.json"), `${JSON.stringify(distPackage, null, 2)}\n`, "utf8");

const launcher = `#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.CPB_EXECUTOR_ROOT = process.env.CPB_EXECUTOR_ROOT || path.resolve(__dirname);
process.env.CPB_ROOT = process.env.CPB_ROOT || path.resolve(__dirname, "..");

const { main } = await import("./cli/cpb.js");
const code = await main();
if (Number.isInteger(code)) process.exitCode = code;
`;

const launcherPath = path.join(distRoot, "cpb");
await writeFile(launcherPath, launcher, "utf8");
await chmod(launcherPath, 0o755);

for (const relative of [
  "cli/cpb.js",
  "server/services/browser-agent-acp.js",
  "server/services/test-acp-agent.js",
  "bridges/job-runner.js",
  "bridges/project-worker.js",
  "bridges/run-phase.js",
  "bridges/run-pipeline.js",
]) {
  try {
    await chmod(path.join(distRoot, relative), 0o755);
  } catch {
    // Optional output may be absent in partial builds.
  }
}
