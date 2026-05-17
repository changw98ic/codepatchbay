import { spawn } from "node:child_process";
import path from "node:path";

export function shouldUseRustRuntime() {
  return process.env.CPB_RUNTIME === "rust";
}

export function resolveRuntimeBin(cpbRoot) {
  if (process.env.CPB_RUNTIME_BIN) {
    return process.env.CPB_RUNTIME_BIN;
  }

  const debugBin = path.resolve(cpbRoot, "runtime", "target", "debug", "cpb-runtime");
  const releaseBin = path.resolve(cpbRoot, "runtime", "target", "release", "cpb-runtime");
  return process.env.CPB_RUNTIME_PROFILE === "release" ? releaseBin : debugBin;
}

export function runRuntime(cpbRoot, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveRuntimeBin(cpbRoot), args, {
      cwd: path.resolve(cpbRoot),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const err = new Error(stderr.trim() || `cpb-runtime exited with code ${code}`);
        err.code = code;
        err.stderr = stderr;
        err.stdout = stdout;
        reject(err);
        return;
      }

      const trimmed = stdout.trim();
      if (trimmed.length === 0) {
        resolve(null);
        return;
      }

      try {
        resolve(JSON.parse(trimmed));
      } catch (err) {
        err.message = `invalid cpb-runtime JSON: ${err.message}`;
        err.stdout = stdout;
        reject(err);
      }
    });
  });
}

function baseArgs(group, command, cpbRoot) {
  return [group, command, "--cpb-root", path.resolve(cpbRoot)];
}

export async function appendEvent(cpbRoot, project, jobId, event) {
  return await runRuntime(cpbRoot, [
    ...baseArgs("events", "append", cpbRoot),
    "--project", project,
    "--job-id", jobId,
    "--event", JSON.stringify(event),
  ]);
}

export async function readEvents(cpbRoot, project, jobId) {
  return await runRuntime(cpbRoot, [
    ...baseArgs("events", "read", cpbRoot),
    "--project", project,
    "--job-id", jobId,
  ]);
}

export async function getJob(cpbRoot, project, jobId) {
  return await runRuntime(cpbRoot, [
    ...baseArgs("jobs", "get", cpbRoot),
    "--project", project,
    "--job-id", jobId,
  ]);
}

export async function listJobs(cpbRoot, { project } = {}) {
  const args = [...baseArgs("jobs", "list", cpbRoot)];
  if (project) {
    args.push("--project", project);
  }
  return await runRuntime(cpbRoot, args);
}

export async function acquireLease(cpbRoot, { leaseId, jobId, phase, ttlMs, ownerPid = process.pid }) {
  return await runRuntime(cpbRoot, [
    ...baseArgs("leases", "acquire", cpbRoot),
    "--lease-id", leaseId,
    "--job-id", jobId,
    "--phase", phase,
    "--ttl-ms", String(ttlMs),
    "--owner-pid", String(ownerPid),
  ]);
}

export async function readLease(cpbRoot, leaseId) {
  return await runRuntime(cpbRoot, [
    ...baseArgs("leases", "read", cpbRoot),
    "--lease-id", leaseId,
  ]);
}

export async function renewLease(cpbRoot, leaseId, { ttlMs, ownerToken } = {}) {
  const args = [
    ...baseArgs("leases", "renew", cpbRoot),
    "--lease-id", leaseId,
    "--ttl-ms", String(ttlMs),
  ];
  if (ownerToken) {
    args.push("--owner-token", ownerToken);
  }
  return await runRuntime(cpbRoot, args);
}

export async function releaseLease(cpbRoot, leaseId, { ownerToken } = {}) {
  const args = [
    ...baseArgs("leases", "release", cpbRoot),
    "--lease-id", leaseId,
  ];
  if (ownerToken) {
    args.push("--owner-token", ownerToken);
  }
  return await runRuntime(cpbRoot, args);
}

export async function compilePolicy(cpbRoot, { role, phase = "" }) {
  return await runRuntime(cpbRoot, [
    ...baseArgs("policy", "compile", cpbRoot),
    "--role", role,
    "--phase", phase,
  ]);
}
