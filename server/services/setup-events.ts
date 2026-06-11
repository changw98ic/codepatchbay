import crypto from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { executeInstallPlan } from "../../core/setup/install-plan.js";

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{8,}\b/g,
  /\b[A-Z0-9_]*(?:SECRET|TOKEN|KEY)[A-Z0-9_]*=[^\s]+/gi,
  /SECRET_[A-Z0-9_]+/g,
];

function setupEventsPath(cpbRoot) {
  return path.join(path.resolve(cpbRoot || process.env.CPB_ROOT || process.cwd()), "cpb-task", "setup-events.jsonl");
}

function redact(value) {
  let text = String(value ?? "");
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, "[REDACTED]");
  }
  return text;
}

function commandHash(plan) {
  const text = plan.displayCommand || [plan.command, ...(plan.args || [])].join(" ");
  return crypto.createHash("sha256").update(text).digest("hex");
}

async function appendSetupEvent(cpbRoot, event) {
  const file = setupEventsPath(cpbRoot);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(event)}\n`, "utf8");
}

function startedEvent(plan, startedAt) {
  return {
    type: "setup_install_started",
    schemaVersion: 1,
    agentId: plan.agent.id,
    method: plan.method,
    sourceUrl: plan.sourceUrl,
    commandHash: commandHash(plan),
    shell: Boolean(plan.shell),
    startedAt,
  };
}

function finishedEvent(plan, startedAt, result, error) {
  const finishedAt = new Date().toISOString();
  const failed = Boolean(error);
  return {
    type: "setup_install_finished",
    schemaVersion: 1,
    agentId: plan.agent.id,
    method: plan.method,
    sourceUrl: plan.sourceUrl,
    commandHash: commandHash(plan),
    result: failed ? "failed" : "succeeded",
    exitCode: failed ? (Number.isInteger(error.code) ? error.code : null) : result.code,
    error: failed ? { message: redact(error.message), code: Number.isInteger(error.code) ? error.code : null } : null,
    startedAt,
    finishedAt,
  };
}

export async function runInstallPlanWithEvents(plan, { cpbRoot, stdio = "inherit" }: Record<string, any> = {}) {
  const startedAt = new Date().toISOString();
  await appendSetupEvent(cpbRoot, startedEvent(plan, startedAt));
  try {
    const result = await executeInstallPlan(plan, { stdio });
    await appendSetupEvent(cpbRoot, finishedEvent(plan, startedAt, result, null));
    return result;
  } catch (error) {
    await appendSetupEvent(cpbRoot, finishedEvent(plan, startedAt, null, error));
    throw error;
  }
}

export async function readSetupEvents(cpbRoot) {
  let raw;
  try {
    raw = await readFile(setupEventsPath(cpbRoot), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
