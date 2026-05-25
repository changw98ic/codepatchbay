#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CPB = path.join(ROOT, "cli", "cpb.mjs");

const PASS = "\x1b[0;32mPASS\x1b[0m";
const FAIL = "\x1b[0;31mFAIL\x1b[0m";

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cmd, ...args], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    const chunks = { stdout: [], stderr: [] };
    child.stdout.on("data", (d) => chunks.stdout.push(d));
    child.stderr.on("data", (d) => chunks.stderr.push(d));
    child.on("close", (code) => {
      const stdout = Buffer.concat(chunks.stdout).toString("utf8");
      const stderr = Buffer.concat(chunks.stderr).toString("utf8");
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.on("error", (err) => {
      resolve({ code: 1, stdout: "", stderr: err.message });
    });
  });
}

function snippet(text, maxLen = 500) {
  const s = text.trim();
  return s.length <= maxLen ? s : s.slice(0, maxLen) + "...";
}

function failContext(label, result, detail) {
  const lines = [`${FAIL} ${label}`];
  lines.push(`  command: ${result.commandText}`);
  lines.push(`  exit code: ${result.code}`);
  if (result.stdout) lines.push(`  stdout: ${snippet(result.stdout)}`);
  if (result.stderr) lines.push(`  stderr: ${snippet(result.stderr)}`);
  if (detail) lines.push(`  validation error: ${detail}`);
  return lines.join("\n");
}

// --- validators ---

function validateSetup(data) {
  const setup = data.detected || data;
  if (!setup.system || typeof setup.system !== "object") return "missing or invalid detected .system";
  if (typeof setup.system.platform !== "string") return ".detected.system.platform is not a string";
  if (typeof setup.system.arch !== "string") return ".detected.system.arch is not a string";

  if (!setup.agents || typeof setup.agents !== "object") return "missing or invalid detected .agents";
  for (const id of ["codex", "claude", "opencode"]) {
    if (!setup.agents[id]) return `.detected.agents.${id} is missing`;
    if (typeof setup.agents[id].installed !== "boolean") return `.detected.agents.${id}.installed is not boolean`;
  }
  if (data.detected) {
    if (data.schemaVersion !== 1) return ".schemaVersion must be 1";
    if (!data.profile || typeof data.profile !== "object") return "missing setup wizard .profile";
    if (data.executed !== false) return "cpb setup --json alone must not execute installs";
    if (!Array.isArray(data.selectedAgents)) return ".selectedAgents must be an array";
  }
  return null;
}

function validateDemo(data) {
  if (data.ok !== true) return `.ok is not true (got ${JSON.stringify(data.ok)})`;

  if (!data.job || typeof data.job !== "object") return "missing or invalid .job";
  if (data.job.status !== "completed") return `.job.status is "${data.job.status}", expected "completed"`;

  const phases = data.job.completedPhases;
  if (!Array.isArray(phases)) return ".job.completedPhases is not an array";
  for (const p of ["plan", "execute", "verify"]) {
    if (!phases.includes(p)) return `.job.completedPhases is missing "${p}" (got [${phases.map(String).join(", ")}])`;
  }

  if (typeof data.eventLog !== "string" || !data.eventLog) return ".eventLog is missing or not a string";

  const artifacts = data.artifacts;
  if (!artifacts || typeof artifacts !== "object") return "missing or invalid .artifacts";
  for (const key of ["plan", "deliverable", "verdict"]) {
    if (!artifacts[key]) return `.artifacts.${key} is missing`;
    if (typeof artifacts[key].path !== "string") return `.artifacts.${key}.path is not a string`;
  }
  return null;
}

// --- runner ---

async function smoke(label, args, validator) {
  const result = await run(CPB, args);
  result.command = CPB;
  result.commandText = `node ${path.relative(ROOT, CPB)} ${args.join(" ")}`;

  if (result.code !== 0) {
    console.error(failContext(label, result, "non-zero exit code"));
    return false;
  }

  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    console.error(failContext(label, result, "stdout is not valid JSON"));
    return false;
  }

  const err = validator(data);
  if (err) {
    console.error(failContext(label, result, err));
    return false;
  }

  console.log(`${PASS} ${label}`);
  return true;
}

const results = await Promise.all([
  smoke("cpb setup --json", ["setup", "--json"], validateSetup),
  smoke("cpb demo --json", ["demo", "--json"], validateDemo),
]);

if (!results.every(Boolean)) {
  console.error(`\n${FAIL} Some smoke tests failed.`);
  process.exitCode = 1;
} else {
  console.log(`\n${PASS} All smoke tests passed.`);
}
