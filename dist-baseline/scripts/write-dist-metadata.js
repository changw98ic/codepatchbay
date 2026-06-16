#!/usr/bin/env node
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
// Every .js file spawned with {shell:false} as a direct executable MUST be
// chmod'd here — the kernel needs the +x bit (plus a #!/usr/bin/env node
// shebang) to exec it. job-runner spawns the phase bridge script via
// spawn(script, {shell:false}) at bridges/job-runner.ts:374, so run-phase.js
// (and any other directly-executed bridge) must be executable, or spawn
// fails with EACCES.
for (const relative of [
    "cli/cpb.js",
    "server/services/test-acp-agent.js",
    "bridges/job-runner.js",
    "bridges/project-worker.js",
    "bridges/run-pipeline.js",
    "bridges/run-phase.js",
]) {
    try {
        await chmod(path.join(distRoot, relative), 0o755);
    }
    catch {
        // Optional output may be absent in partial builds.
    }
}
