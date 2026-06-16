#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { readdir } from "node:fs/promises";
const repoRoot = path.resolve(import.meta.dirname, "..");
function normalizeRequestedFile(arg) {
    const resolved = path.isAbsolute(arg) ? arg : path.resolve(process.cwd(), arg);
    let relative = path.relative(repoRoot, resolved).split(path.sep).join("/");
    if (relative.startsWith("../")) {
        const cwdRelative = path.relative(process.cwd(), resolved).split(path.sep).join("/");
        relative = cwdRelative.startsWith("dist/")
            ? cwdRelative.slice("dist/".length)
            : cwdRelative;
    }
    return relative.replace(/\.ts$/, ".js");
}
async function collectTestFiles(dir) {
    const results = [];
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...await collectTestFiles(full));
        }
        else if (entry.name.endsWith(".test.js")) {
            results.push(path.relative(repoRoot, full).split(path.sep).join("/"));
        }
    }
    return results;
}
async function runTests(files, opts = {}) {
    const { concurrency = undefined, env: envOverrides = {}, label = "tests" } = opts;
    const args = ["--test", ...files];
    if (concurrency !== undefined) {
        args.unshift(`--test-concurrency=${concurrency}`);
    }
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (key.startsWith("CPB_"))
            delete env[key];
    }
    env.CPB_WORKER_DISPATCH_ENABLED = "0";
    // Tests use fake agent pools; the default-on LLM checklist decomposition (a
    // real planner call in phase 3) is opt-in per test via process.env. Production
    // does not run through this script, so the default-on behavior is unchanged.
    env.CPB_CHECKLIST_DECOMPOSE = "0";
    Object.assign(env, envOverrides);
    console.log(`Running ${label}: ${files.length} file(s)`);
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, {
            cwd: repoRoot,
            stdio: "inherit",
            env,
        });
        child.on("close", (code) => {
            if (code !== 0) {
                reject(new Error(`${label} exited with code ${code}`));
            }
            else {
                resolve(code);
            }
        });
    });
}
const requestedFiles = process.argv.slice(2)
    .filter((arg) => !arg.startsWith("-"))
    .map(normalizeRequestedFile);
const allFiles = requestedFiles.length > 0
    ? requestedFiles
    : await collectTestFiles(path.join(repoRoot, "tests"));
if (allFiles.length === 0) {
    console.error("No Node test files found");
    process.exit(1);
}
const integrationFiles = allFiles.filter((f) => f.startsWith("tests/integration/"));
const unitFiles = allFiles.filter((f) => !f.startsWith("tests/integration/"));
const isolatedIntegrationFiles = new Set([
    "tests/integration/acp-test-agent.test.js",
    "tests/integration/managed-worker.test.js",
    "tests/integration/worker-supervisor.test.js",
    "tests/integration/reconcile.test.js",
]);
const isolatedFiles = integrationFiles.filter((f) => isolatedIntegrationFiles.has(f));
const parallelIntegrationFiles = integrationFiles.filter((f) => !isolatedFiles.includes(f));
// When --unit flag is passed, only run unit tests (fast, <15s)
const unitOnly = process.argv.includes("--unit");
// When --integration flag is passed, only run integration tests
const integrationOnly = process.argv.includes("--integration");
try {
    if (unitOnly) {
        if (unitFiles.length > 0) {
            await runTests(unitFiles, { label: "unit tests" });
        }
    }
    else if (integrationOnly) {
        // Parallel-safe integration tests
        if (parallelIntegrationFiles.length > 0) {
            await runTests(parallelIntegrationFiles, { label: "integration tests" });
        }
        // Real-process integration tests need isolation from parallel load.
        if (isolatedFiles.length > 0) {
            await runTests(isolatedFiles, { concurrency: 1, label: "isolated integration tests" });
        }
    }
    else {
        // Default: run everything
        // Unit tests: run in parallel (fast)
        if (unitFiles.length > 0) {
            await runTests(unitFiles, { label: "unit tests" });
        }
        // Parallel-safe integration tests
        if (parallelIntegrationFiles.length > 0) {
            await runTests(parallelIntegrationFiles, { label: "integration tests" });
        }
        // Isolated integration tests (serial)
        if (isolatedFiles.length > 0) {
            await runTests(isolatedFiles, { concurrency: 1, label: "isolated integration tests" });
        }
    }
}
catch (err) {
    console.error(err.message);
    process.exitCode = 1;
}
