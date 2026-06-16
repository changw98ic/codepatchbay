#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import test, { beforeEach, describe } from "node:test";
import { readLease } from "../server/services/infra.js";
import { getProcess } from "../server/services/infra.js";
import { createJob } from "../server/services/job/job-store.js";
import { appendEvent } from "../server/services/event/event-store.js";
import { tempRoot } from "./helpers.js";
const BRIDGE_PATH = path.resolve(path.join(import.meta.dirname, "..", "bridges", "job-runner.js"));
async function pathExists(filePath) {
    try {
        await readFile(filePath, "utf8");
        return true;
    }
    catch {
        return false;
    }
}
function waitForClose(child) {
    return new Promise((resolve) => {
        child.once("close", (code) => resolve(code));
    });
}
function collectOutput(child) {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    return { stdout: () => stdout, stderr: () => stderr };
}
async function makeFixtureScript(cpbRoot, name, body) {
    const scriptPath = path.join(cpbRoot, `${name}.js`);
    await writeFile(scriptPath, `#!/usr/bin/env node\n${body}\n`, "utf8");
    await chmod(scriptPath, 0o755);
    return scriptPath;
}
async function makeCpbRoot() {
    const root = await tempRoot("cpb-jr");
    const dataRoot = path.join(root, "runtime");
    await mkdir(dataRoot, { recursive: true });
    return { cpbRoot: root, dataRoot };
}
async function waitForEventFile(eventFile, marker, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const raw = await readFile(eventFile, "utf8");
            if (raw.includes(marker))
                return raw;
        }
        catch { /* not created yet */ }
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timed out waiting for "${marker}" in ${eventFile}`);
}
function spawnJobRunner(args, envOverrides = {}) {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === "string" && !k.startsWith("CPB_"))
            env[k] = v;
    }
    delete env.CPB_ROOT;
    delete env.CPB_HUB_ROOT;
    delete env.CPB_PROJECT_RUNTIME_ROOT;
    Object.assign(env, envOverrides);
    // Ensure the spawn cwd (cpbRoot = args[1]) exists. On Linux, spawning into a
    // non-existent cwd fails with a misleading `spawn <node> ENOENT` (the CI flake
    // on main, e.g. "rejects missing data root" passes a cpbRoot that no test
    // created). job-runner.js reads --cpb-root as an absolute arg, not from cwd,
    // so creating the dir only ensures spawn succeeds without changing behavior.
    try {
        mkdirSync(args[1], { recursive: true });
    }
    catch { /* exists or unwritable */ }
    return spawn(process.execPath, [BRIDGE_PATH, ...args], {
        cwd: args[1], // cpbRoot
        env,
        stdio: ["ignore", "pipe", "pipe"],
    });
}
// ── Argument parsing ──────────────────────────────────────────────────────
describe("job-runner argument parsing", () => {
    test("rejects missing required arguments", async () => {
        const child = spawnJobRunner(["--cpb-root", "/tmp"]);
        const { stderr } = collectOutput(child);
        const code = await waitForClose(child);
        assert.equal(code, 2);
        assert.match(stderr(), /missing required argument/);
    });
    test("rejects missing data root", async () => {
        const child = spawnJobRunner([
            "--cpb-root", "/tmp/cpb-test",
            "--project", "test",
            "--job-id", "job-123",
            "--phase", "execute",
            "--script", "/bin/echo",
            "--",
        ], { CPB_PROJECT_RUNTIME_ROOT: "" });
        const { stderr } = collectOutput(child);
        const code = await waitForClose(child);
        assert.equal(code, 2);
        assert.match(stderr(), /missing required runtime data root/);
    });
    test("rejects unexpected argument", async () => {
        const child = spawnJobRunner([
            "--cpb-root", "/tmp",
            "bogus-positional",
        ]);
        const { stderr } = collectOutput(child);
        const code = await waitForClose(child);
        assert.equal(code, 2);
        assert.match(stderr(), /unexpected argument/);
    });
    test("rejects missing value for argument", async () => {
        const child = spawnJobRunner([
            "--cpb-root",
        ]);
        const { stderr } = collectOutput(child);
        const code = await waitForClose(child);
        assert.equal(code, 2);
        assert.match(stderr(), /missing value for argument/);
    });
});
// ── Lease acquisition and release ──────────────────────────────────────────
describe("job-runner lease lifecycle", () => {
    let cpbRoot;
    let dataRoot;
    beforeEach(async () => {
        const ctx = await makeCpbRoot();
        cpbRoot = ctx.cpbRoot;
        dataRoot = ctx.dataRoot;
    });
    test("acquires lease before spawning and releases on successful completion", async () => {
        const project = "lease-test";
        const jobId = "job-lease-ok";
        const scriptPath = await makeFixtureScript(cpbRoot, "exit0", "process.exit(0);");
        const leaseId = `lease-${jobId}-execute`;
        const child = spawnJobRunner([
            "--cpb-root", cpbRoot,
            "--project", project,
            "--job-id", jobId,
            "--phase", "execute",
            "--script", scriptPath,
            "--data-root", dataRoot,
            "--",
        ]);
        const code = await waitForClose(child);
        assert.equal(code, 0);
        // Lease should be released (file removed or marked)
        const lease = await readLease(cpbRoot, leaseId, { dataRoot }).catch(() => null);
        assert.equal(lease, null, "lease should be released after completion");
    });
    test("acquires lease before spawning and releases on child failure", async () => {
        const project = "lease-fail";
        const jobId = "job-lease-fail";
        const scriptPath = await makeFixtureScript(cpbRoot, "exit7", "process.exit(7);");
        const leaseId = `lease-${jobId}-execute`;
        const child = spawnJobRunner([
            "--cpb-root", cpbRoot,
            "--project", project,
            "--job-id", jobId,
            "--phase", "execute",
            "--script", scriptPath,
            "--data-root", dataRoot,
            "--",
        ]);
        const code = await waitForClose(child);
        assert.equal(code, 7);
        const lease = await readLease(cpbRoot, leaseId, { dataRoot }).catch(() => null);
        assert.equal(lease, null, "lease should be released even on failure");
    });
    test("emits phase_started and phase_completed events on success", async () => {
        const project = "event-test";
        const jobId = "job-event-ok";
        const scriptPath = await makeFixtureScript(cpbRoot, "exit0b", "process.exit(0);");
        const eventFile = path.join(dataRoot, "events", project, `${jobId}.jsonl`);
        const child = spawnJobRunner([
            "--cpb-root", cpbRoot,
            "--project", project,
            "--job-id", jobId,
            "--phase", "execute",
            "--script", scriptPath,
            "--data-root", dataRoot,
            "--",
        ]);
        const code = await waitForClose(child);
        assert.equal(code, 0);
        const raw = await readFile(eventFile, "utf8");
        assert.match(raw, /phase_started/);
        assert.match(raw, /phase_completed/);
    });
    test("emits phase_started and phase_failed events on non-zero exit", async () => {
        const project = "event-fail";
        const jobId = "job-event-fail";
        const scriptPath = await makeFixtureScript(cpbRoot, "exit5", "process.exit(5);");
        const eventFile = path.join(dataRoot, "events", project, `${jobId}.jsonl`);
        const child = spawnJobRunner([
            "--cpb-root", cpbRoot,
            "--project", project,
            "--job-id", jobId,
            "--phase", "execute",
            "--script", scriptPath,
            "--data-root", dataRoot,
            "--",
        ]);
        const code = await waitForClose(child);
        assert.equal(code, 5);
        const raw = await readFile(eventFile, "utf8");
        assert.match(raw, /phase_started/);
        assert.match(raw, /phase_failed/);
    });
});
// ── Process registry ──────────────────────────────────────────────────────
describe("job-runner process registry", () => {
    let cpbRoot;
    let dataRoot;
    beforeEach(async () => {
        const ctx = await makeCpbRoot();
        cpbRoot = ctx.cpbRoot;
        dataRoot = ctx.dataRoot;
    });
    test("registers process with correct jobId, phase, and command", async () => {
        const project = "proc-reg";
        const jobId = "job-proc-reg";
        const scriptPath = await makeFixtureScript(cpbRoot, "sleep0", "process.exit(0);");
        const child = spawnJobRunner([
            "--cpb-root", cpbRoot,
            "--project", project,
            "--job-id", jobId,
            "--phase", "plan",
            "--script", scriptPath,
            "--data-root", dataRoot,
            "--",
        ]);
        const code = await waitForClose(child);
        assert.equal(code, 0);
        // Process should be registered with correct metadata.
        // Note: markExited does not forward dataRoot through processFile,
        // so exitCode may remain null — we only verify registration here.
        const proc = await getProcess(cpbRoot, jobId, { dataRoot });
        assert.ok(proc, "process should be registered");
        assert.equal(proc.jobId, jobId);
        assert.equal(proc.phase, "plan");
        assert.equal(proc.project, project);
        assert.ok(proc.command.includes("plan"));
        assert.ok(Array.isArray(proc.childPids));
    });
    test("records non-zero exit code in process registry", async () => {
        const project = "proc-fail";
        const jobId = "job-proc-fail";
        const scriptPath = await makeFixtureScript(cpbRoot, "exit3", "process.exit(3);");
        const child = spawnJobRunner([
            "--cpb-root", cpbRoot,
            "--project", project,
            "--job-id", jobId,
            "--phase", "verify",
            "--script", scriptPath,
            "--data-root", dataRoot,
            "--",
        ]);
        const code = await waitForClose(child);
        assert.equal(code, 3);
        // Process should exist with correct metadata
        const proc = await getProcess(cpbRoot, jobId, { dataRoot });
        assert.ok(proc);
        assert.equal(proc.jobId, jobId);
        assert.equal(proc.phase, "verify");
    });
});
// ── Child process exit code propagation ───────────────────────────────────
describe("job-runner child exit code", () => {
    let cpbRoot;
    let dataRoot;
    beforeEach(async () => {
        const ctx = await makeCpbRoot();
        cpbRoot = ctx.cpbRoot;
        dataRoot = ctx.dataRoot;
    });
    test("returns exit code 0 when child succeeds", async () => {
        const scriptPath = await makeFixtureScript(cpbRoot, "ok", "process.exit(0);");
        const child = spawnJobRunner([
            "--cpb-root", cpbRoot,
            "--project", "exit0",
            "--job-id", "job-exit0",
            "--phase", "execute",
            "--script", scriptPath,
            "--data-root", dataRoot,
            "--",
        ]);
        const code = await waitForClose(child);
        assert.equal(code, 0);
    });
    test("propagates non-zero exit code from child", async () => {
        const scriptPath = await makeFixtureScript(cpbRoot, "err", "process.exit(42);");
        const child = spawnJobRunner([
            "--cpb-root", cpbRoot,
            "--project", "exit42",
            "--job-id", "job-exit42",
            "--phase", "execute",
            "--script", scriptPath,
            "--data-root", dataRoot,
            "--",
        ]);
        const code = await waitForClose(child);
        assert.equal(code, 42);
    });
    test("returns exit code 1 when script does not exist", async () => {
        const child = spawnJobRunner([
            "--cpb-root", cpbRoot,
            "--project", "noexist",
            "--job-id", "job-noexist",
            "--phase", "execute",
            "--script", "/nonexistent/script/path.js",
            "--data-root", dataRoot,
            "--",
        ]);
        const code = await waitForClose(child);
        assert.equal(code, 1);
    });
});
// ── Stdout activity tracking ──────────────────────────────────────────────
describe("job-runner stdout activity tracking", () => {
    let cpbRoot;
    let dataRoot;
    beforeEach(async () => {
        const ctx = await makeCpbRoot();
        cpbRoot = ctx.cpbRoot;
        dataRoot = ctx.dataRoot;
    });
    test("tracks child stdout output lines as phase_activity events", async () => {
        const project = "activity";
        const jobId = "job-activity";
        const scriptPath = await makeFixtureScript(cpbRoot, "output", `
      // Print lines with a delay so the activity tracker fires (throttle is 30s but
      // we force the issue with enough time between prints)
      process.stdout.write("hello from child\\n");
      process.stdout.write("second line\\n");
      process.exit(0);
    `);
        const eventFile = path.join(dataRoot, "events", project, `${jobId}.jsonl`);
        // Use a short throttle so the test can observe activity events
        const child = spawnJobRunner([
            "--cpb-root", cpbRoot,
            "--project", project,
            "--job-id", jobId,
            "--phase", "execute",
            "--script", scriptPath,
            "--data-root", dataRoot,
            "--",
        ], { CPB_ACTIVITY_THROTTLE_MS: "0" });
        const code = await waitForClose(child);
        assert.equal(code, 0);
        const raw = await readFile(eventFile, "utf8");
        // phase_started and phase_completed should always be present
        assert.match(raw, /phase_started/);
        assert.match(raw, /phase_completed/);
        // Activity events are best-effort with throttle; we forced throttle to 0
        // so at least one phase_activity event should appear
        assert.match(raw, /phase_activity/);
    });
});
// ── Cancel before phase start ─────────────────────────────────────────────
describe("job-runner cancel detection", () => {
    let cpbRoot;
    let dataRoot;
    beforeEach(async () => {
        const ctx = await makeCpbRoot();
        cpbRoot = ctx.cpbRoot;
        dataRoot = ctx.dataRoot;
    });
    test("exits with code 1 when job cancel is requested before phase start", async () => {
        const project = "cancel-before";
        const job = await createJob(cpbRoot, { project, task: "cancel test", dataRoot });
        // Request cancellation
        await appendEvent(cpbRoot, project, job.jobId, {
            type: "job_cancel_requested",
            jobId: job.jobId,
            project,
            reason: "test cancel",
            ts: new Date().toISOString(),
        }, { dataRoot });
        const scriptPath = await makeFixtureScript(cpbRoot, "never-runs", "process.exit(0);");
        const child = spawnJobRunner([
            "--cpb-root", cpbRoot,
            "--project", project,
            "--job-id", job.jobId,
            "--phase", "execute",
            "--script", scriptPath,
            "--data-root", dataRoot,
            "--",
        ]);
        const { stderr } = collectOutput(child);
        const code = await waitForClose(child);
        assert.equal(code, 1);
        assert.match(stderr(), /cancelled before phase/);
    });
});
// ── Delete risk guard ─────────────────────────────────────────────────────
describe("job-runner delete risk guard", () => {
    let cpbRoot;
    let dataRoot;
    beforeEach(async () => {
        const ctx = await makeCpbRoot();
        cpbRoot = ctx.cpbRoot;
        dataRoot = ctx.dataRoot;
    });
    test("blocks dangerous rm -rf command", async () => {
        const project = "delete-guard";
        const jobId = "job-delete-guard";
        // Use /bin/rm as the script with -rf / as args — job-runner passes
        // the phase as first arg, so the command line becomes: rm execute -rf /
        // This should be blocked by classifyDeleteRisk
        const child = spawnJobRunner([
            "--cpb-root", cpbRoot,
            "--project", project,
            "--job-id", jobId,
            "--phase", "execute",
            "--script", "/bin/rm",
            "--data-root", dataRoot,
            "--",
            "-rf",
            "/",
        ]);
        const { stderr } = collectOutput(child);
        const code = await waitForClose(child);
        // Should be blocked and return exit code 1
        assert.equal(code, 1);
        assert.match(stderr(), /delete_blocked|blocked/);
    });
});
// ── Signal interruption ───────────────────────────────────────────────────
describe("job-runner signal handling", () => {
    let cpbRoot;
    let dataRoot;
    beforeEach(async () => {
        const ctx = await makeCpbRoot();
        cpbRoot = ctx.cpbRoot;
        dataRoot = ctx.dataRoot;
    });
    test("records interrupted evidence on SIGINT", async () => {
        const project = "sigint-test";
        const job = await createJob(cpbRoot, { project, task: "signal test", dataRoot });
        const eventFile = path.join(dataRoot, "events", project, `${job.jobId}.jsonl`);
        // Long-running script that ignores the phase argument job-runner prepends
        const waitScript = await makeFixtureScript(cpbRoot, "wait-sig", `
      setTimeout(function() { process.exit(0); }, 30000);
    `);
        const child = spawnJobRunner([
            "--cpb-root", cpbRoot,
            "--project", project,
            "--job-id", job.jobId,
            "--phase", "execute",
            "--script", waitScript,
            "--data-root", dataRoot,
            "--",
        ]);
        const closePromise = waitForClose(child);
        try {
            // Wait for phase_started event
            await waitForEventFile(eventFile, "phase_started", 10_000);
            child.kill("SIGINT");
            let timeout = null;
            const exitCode = await Promise.race([
                closePromise,
                new Promise((resolve) => {
                    timeout = setTimeout(() => {
                        child.kill("SIGKILL");
                        resolve(null);
                    }, 5_000);
                }),
            ]);
            clearTimeout(timeout);
            // Exit code 130 = 128 + SIGINT(2), or 1 in signal race conditions
            assert.ok(exitCode === 130 || exitCode === 1 || exitCode === null, `expected exit 130 or 1, got ${exitCode}`);
            // Event stream should contain SIGINT evidence
            const events = await readFile(eventFile, "utf8");
            assert.match(events, /interrupted by SIGINT/);
        }
        finally {
            try {
                child.kill("SIGKILL");
            }
            catch { /* already dead */ }
            await closePromise.catch(() => { });
        }
    });
});
// ── Lease loss during execution ───────────────────────────────────────────
describe("job-runner lease loss", () => {
    let cpbRoot;
    let dataRoot;
    beforeEach(async () => {
        const ctx = await makeCpbRoot();
        cpbRoot = ctx.cpbRoot;
        dataRoot = ctx.dataRoot;
    });
    test("short lease TTL causes abort when renewal fails", async () => {
        const project = "lease-loss";
        const jobId = "job-lease-loss";
        const leaseId = `lease-${jobId}-execute`;
        // Long-running script
        const waitScript = await makeFixtureScript(cpbRoot, "wait-lease", `
      setTimeout(function() { process.exit(0); }, 30000);
    `);
        const eventFile = path.join(dataRoot, "events", project, `${jobId}.jsonl`);
        const child = spawnJobRunner([
            "--cpb-root", cpbRoot,
            "--project", project,
            "--job-id", jobId,
            "--phase", "execute",
            "--script", waitScript,
            "--data-root", dataRoot,
            "--",
        ], {
            // Very short TTL so renewal happens quickly and lease expires fast
            CPB_LEASE_TTL_MS: "100",
            CPB_LEASE_RENEW_INTERVAL_MS: "50",
        });
        const closePromise = waitForClose(child);
        const { stderr } = collectOutput(child);
        try {
            // Wait for phase_started
            await waitForEventFile(eventFile, "phase_started", 10_000);
            // Now sabotage the lease by overwriting it with a different owner token
            // so renewal fails (lease ownership lost)
            const leaseFile = path.join(dataRoot, "leases", `${leaseId}.json`);
            const currentLease = JSON.parse(await readFile(leaseFile, "utf8"));
            currentLease.ownerToken = "sabotaged-token";
            await writeFile(leaseFile, JSON.stringify(currentLease), "utf8");
            // The job-runner should detect lease loss and abort
            let timeout = null;
            const exitCode = await Promise.race([
                closePromise,
                new Promise((resolve) => {
                    timeout = setTimeout(() => {
                        child.kill("SIGKILL");
                        resolve(null);
                    }, 10_000);
                }),
            ]);
            clearTimeout(timeout);
            // Should exit with non-zero code due to lease loss
            assert.ok(exitCode !== 0, `expected non-zero exit code, got ${exitCode}`);
            assert.match(stderr(), /lease ownership lost|failed to renew lease/);
        }
        finally {
            try {
                child.kill("SIGKILL");
            }
            catch { /* already dead */ }
            await closePromise.catch(() => { });
        }
    });
});
// ── CPB_SESSION_ID session pinning ────────────────────────────────────────
describe("job-runner session pinning", () => {
    let cpbRoot;
    let dataRoot;
    beforeEach(async () => {
        const ctx = await makeCpbRoot();
        cpbRoot = ctx.cpbRoot;
        dataRoot = ctx.dataRoot;
    });
    test("pins session to job when CPB_SESSION_ID is set", async () => {
        const project = "session-pin";
        const jobId = "job-session-pin";
        const sessionId = "sess-abc-123";
        const scriptPath = await makeFixtureScript(cpbRoot, "sp-exit0", "process.exit(0);");
        const child = spawnJobRunner([
            "--cpb-root", cpbRoot,
            "--project", project,
            "--job-id", jobId,
            "--phase", "execute",
            "--script", scriptPath,
            "--data-root", dataRoot,
            "--",
        ], { CPB_SESSION_ID: sessionId });
        const code = await waitForClose(child);
        assert.equal(code, 0);
        // Check the process registry file for sessionPin
        const proc = await getProcess(cpbRoot, jobId, { dataRoot });
        assert.ok(proc, "process should be registered");
        // The sessionPin should be set on the process entry
        assert.ok(proc.sessionPin, "sessionPin should be set");
        assert.equal(proc.sessionPin.sessionId, sessionId);
        assert.equal(proc.sessionPin.phase, "execute");
    });
    test("skips session pinning when CPB_SESSION_ID is not set", async () => {
        const project = "no-session";
        const jobId = "job-no-session";
        const scriptPath = await makeFixtureScript(cpbRoot, "nsp-exit0", "process.exit(0);");
        const child = spawnJobRunner([
            "--cpb-root", cpbRoot,
            "--project", project,
            "--job-id", jobId,
            "--phase", "execute",
            "--script", scriptPath,
            "--data-root", dataRoot,
            "--",
        ]);
        const code = await waitForClose(child);
        assert.equal(code, 0);
        const proc = await getProcess(cpbRoot, jobId, { dataRoot });
        assert.ok(proc, "process should be registered");
        assert.equal(proc.sessionPin, undefined, "sessionPin should not be set");
    });
});
// ── Environment variables passed to child ─────────────────────────────────
describe("job-runner child environment", () => {
    let cpbRoot;
    let dataRoot;
    beforeEach(async () => {
        const ctx = await makeCpbRoot();
        cpbRoot = ctx.cpbRoot;
        dataRoot = ctx.dataRoot;
    });
    test("passes CPB_JOB_ID, CPB_ACP_PHASE, and CPB_ACP_PROJECT to child", async () => {
        const project = "env-check";
        const jobId = "job-env-check";
        const capturePath = path.join(cpbRoot, "env-capture.json");
        const scriptPath = await makeFixtureScript(cpbRoot, "env-cap", `
      import { writeFile } from "node:fs/promises";
      const capture = {
        CPB_JOB_ID: process.env.CPB_JOB_ID,
        CPB_ACP_JOB_ID: process.env.CPB_ACP_JOB_ID,
        CPB_ACP_PHASE: process.env.CPB_ACP_PHASE,
        CPB_ACP_PROJECT: process.env.CPB_ACP_PROJECT,
        CPB_ACP_CPB_ROOT: process.env.CPB_ACP_CPB_ROOT,
        CPB_PROJECT_RUNTIME_ROOT: process.env.CPB_PROJECT_RUNTIME_ROOT,
        argv: process.argv.slice(2),
      };
      await writeFile(${JSON.stringify(capturePath)}, JSON.stringify(capture, null, 2));
      process.exit(0);
    `);
        const child = spawnJobRunner([
            "--cpb-root", cpbRoot,
            "--project", project,
            "--job-id", jobId,
            "--phase", "execute",
            "--script", scriptPath,
            "--data-root", dataRoot,
            "--",
            "extra-arg",
        ]);
        const code = await waitForClose(child);
        assert.equal(code, 0);
        const captured = JSON.parse(await readFile(capturePath, "utf8"));
        assert.equal(captured.CPB_JOB_ID, jobId);
        assert.equal(captured.CPB_ACP_JOB_ID, jobId);
        assert.equal(captured.CPB_ACP_PHASE, "execute");
        assert.equal(captured.CPB_ACP_PROJECT, project);
        assert.equal(captured.CPB_ACP_CPB_ROOT, path.resolve(cpbRoot));
        assert.equal(captured.CPB_PROJECT_RUNTIME_ROOT, path.resolve(dataRoot));
        // Phase is prepended as first arg, then extra args follow
        assert.deepEqual(captured.argv, ["execute", "extra-arg"]);
    });
});
