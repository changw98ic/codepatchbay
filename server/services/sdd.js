import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  SDD_TRACE_SCHEMA_VERSION,
  sddDir,
  sddTracePath,
} from "../../core/sdd/trace.js";

const ARTIFACTS = {
  spec: "spec.md",
  design: "design.md",
  tasks: "tasks.md",
};

async function writeAtomic(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, filePath);
}

async function readText(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function artifactStatus(cpbRoot, project, name) {
  return {
    path: path.join(sddDir(cpbRoot, project), ARTIFACTS[name]),
    exists: false,
    bytes: 0,
  };
}

function validateTrace(trace, project) {
  const errors = [];
  if (!trace || typeof trace !== "object" || Array.isArray(trace)) {
    return { valid: false, errors: ["trace is not an object"] };
  }
  if (trace.schemaVersion !== SDD_TRACE_SCHEMA_VERSION) errors.push(`unsupported schemaVersion ${trace.schemaVersion}`);
  if (trace.project !== project) errors.push(`trace project ${trace.project || "(missing)"} does not match ${project}`);
  if (trace.workflow !== "sdd-standard") errors.push("trace workflow must be sdd-standard");
  if (trace.planMode !== "parent") errors.push("trace planMode must be parent");
  for (const [name, file] of Object.entries(ARTIFACTS)) {
    if (trace.artifacts?.[name] !== file) errors.push(`trace artifact ${name} must be ${file}`);
  }
  return { valid: errors.length === 0, errors };
}

export async function verifySddProject(cpbRoot, project) {
  const dir = sddDir(cpbRoot, project);
  const artifacts = {};
  const errors = [];
  const warnings = [];

  for (const name of Object.keys(ARTIFACTS)) {
    const status = artifactStatus(cpbRoot, project, name);
    const text = await readText(status.path);
    if (text === null) {
      errors.push(`missing ${name}: ${status.path}`);
    } else {
      status.exists = true;
      status.bytes = Buffer.byteLength(text, "utf8");
      if (/TODO|TBD/.test(text)) warnings.push(`${name} contains placeholder markers`);
    }
    artifacts[name] = status;
  }

  const tracePath = sddTracePath(cpbRoot, project);
  let traceRaw = await readText(tracePath);
  let trace = null;
  let traceValidation = { valid: false, errors: ["trace missing"] };
  if (traceRaw === null) {
    errors.push(`missing trace: ${tracePath}`);
  } else {
    try {
      trace = JSON.parse(traceRaw);
      traceValidation = validateTrace(trace, project);
      errors.push(...traceValidation.errors);
    } catch (error) {
      traceValidation = { valid: false, errors: [`trace is invalid JSON: ${error.message}`] };
      errors.push(...traceValidation.errors);
    }
  }

  return {
    status: errors.length === 0 ? "pass" : "fail",
    project,
    dir,
    artifacts,
    trace: {
      path: tracePath,
      exists: traceRaw !== null,
      valid: traceValidation.valid,
      errors: traceValidation.errors,
      data: trace,
    },
    warnings,
    errors,
  };
}

export async function analyzeSddDrift({ cpbRoot, projectRecord, task = "" }) {
  const project = projectRecord.id;
  const verification = await verifySddProject(cpbRoot, project);

  const findings = [];
  if (verification.status !== "pass") {
    findings.push({
      severity: "error",
      kind: "sdd_verification_failed",
      message: "SDD artifacts or trace are incomplete.",
    });
  }

  const status = findings.some((finding) => finding.severity === "error")
    ? "fail"
    : findings.length > 0
      ? "needs_review"
      : "pass";
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(sddDir(cpbRoot, project), `sdd-drift-${ts}.json`);
  const report = {
    status,
    project,
    task,
    reportPath,
    sdd: verification,
    findings,
    checkedAt: new Date().toISOString(),
  };
  await writeAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
