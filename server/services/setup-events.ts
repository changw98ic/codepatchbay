import crypto from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { executeInstallPlan } from "../../core/setup/install-plan.js";
import { recordValue, type LooseRecord } from "../../shared/types.js";

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{8,}\b/g,
  /\b[A-Z0-9_]*(?:SECRET|TOKEN|KEY)[A-Z0-9_]*=[^\s]+/gi,
  /SECRET_[A-Z0-9_]+/g,
];

function setupEventsPath(cpbRoot: string) {
  return path.join(path.resolve(cpbRoot || process.env.CPB_ROOT || process.cwd()), "cpb-task", "setup-events.jsonl");
}

function redact(value: unknown): string {
  let text = String(value ?? "");
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, "[REDACTED]");
  }
  return text;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function commandHash(plan: LooseRecord) {
  const text = stringValue(plan.displayCommand) || [stringValue(plan.command), ...stringArray(plan.args)].join(" ");
  return crypto.createHash("sha256").update(text).digest("hex");
}

async function appendSetupEvent(cpbRoot: string, event: LooseRecord) {
  const file = setupEventsPath(cpbRoot);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(event)}\n`, "utf8");
}

function startedEvent(plan: LooseRecord, startedAt: string) {
  const agent = recordValue(plan.agent);
  return {
    type: "setup_install_started",
    schemaVersion: 1,
    agentId: agent.id || stringValue(plan.agent),
    method: plan.method,
    sourceUrl: plan.sourceUrl,
    commandHash: commandHash(plan),
    shell: Boolean(plan.shell),
    startedAt,
  };
}

function finishedEvent(plan: LooseRecord, startedAt: string, result: unknown, error: unknown) {
  const finishedAt = new Date().toISOString();
  const failed = Boolean(error);
  const agent = recordValue(plan.agent);
  const resultRecord = recordValue(result);
  const errorRecord = recordValue(error);
  return {
    type: "setup_install_finished",
    schemaVersion: 1,
    agentId: agent.id || stringValue(plan.agent),
    method: plan.method,
    sourceUrl: plan.sourceUrl,
    commandHash: commandHash(plan),
    result: failed ? "failed" : "succeeded",
    exitCode: failed ? (Number.isInteger(errorRecord.code) ? errorRecord.code : null) : resultRecord.code,
    error: failed ? { message: redact(errorRecord.message), code: Number.isInteger(errorRecord.code) ? errorRecord.code : null } : null,
    startedAt,
    finishedAt,
  };
}

export async function runInstallPlanWithEvents(plan: LooseRecord, { cpbRoot, stdio = "inherit" }: LooseRecord = {}) {
  const startedAt = new Date().toISOString();
  const cpbRootPath = stringValue(cpbRoot);
  await appendSetupEvent(cpbRootPath, startedEvent(plan, startedAt));
  try {
    const result = await executeInstallPlan(plan, { stdio });
    await appendSetupEvent(cpbRootPath, finishedEvent(plan, startedAt, result, null));
    return result;
  } catch (error) {
    await appendSetupEvent(cpbRootPath, finishedEvent(plan, startedAt, null, error));
    throw error;
  }
}

export async function readSetupEvents(cpbRoot: string) {
  let raw;
  try {
    raw = await readFile(setupEventsPath(cpbRoot), "utf8");
  } catch (error) {
    if (recordValue(error).code === "ENOENT") return [];
    throw error;
  }
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
