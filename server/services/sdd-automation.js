import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultSddTrace, sddDir, sddQueueMetadata, sddTracePath } from "../../core/sdd/trace.js";

async function writeAtomic(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, filePath);
}

async function writeIfMissing(filePath, content) {
  try {
    await readFile(filePath, "utf8");
    return { path: filePath, created: false };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeAtomic(filePath, content);
  return { path: filePath, created: true };
}

function clean(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function issueRef(event = {}) {
  return event.issueNumber ? `#${event.issueNumber}` : "unlinked issue";
}

function issueHash(event = {}) {
  const payload = {
    repo: event.repo || null,
    issueNumber: event.issueNumber ?? null,
    title: event.title || null,
    body: event.body || null,
    url: event.url || null,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

function sddGenerationEventsPath(cpbRoot, project) {
  return path.join(sddDir(cpbRoot, project), "generation-events.jsonl");
}

function stripJsonFence(raw) {
  return String(raw || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function specFromIssue(project, event) {
  const title = clean(event.title, `SDD spec for ${project}`);
  const body = clean(event.body, "No issue body provided.");
  return [
    `# Spec: ${title}`,
    "",
    `Source: GitHub issue ${issueRef(event)}`,
    event.url ? `URL: ${event.url}` : null,
    "",
    "## Problem",
    "",
    body,
    "",
    "## Acceptance",
    "",
    "- Preserve the issue acceptance criteria during design and task breakdown.",
    "- Keep trace links from Spec to Design to Task to PR.",
    "",
  ].filter((line) => line !== null).join("\n");
}

function designFromIssue(project, event) {
  const title = clean(event.title, `SDD design for ${project}`);
  return [
    `# Design: ${title}`,
    "",
    `Source: GitHub issue ${issueRef(event)}`,
    "",
    "## Approach",
    "",
    "- Derive the implementation design from the generated Spec before execution.",
    "- Capture affected components and data boundaries before queueing implementation work.",
    "",
    "## Trace",
    "",
    "- Spec: spec.md",
    "- Tasks: tasks.md",
    "",
  ].join("\n");
}

function taskFromIssue(project, event) {
  const title = clean(event.title, `SDD task for ${project}`);
  return [
    `# Tasks: ${title}`,
    "",
    `Source: GitHub issue ${issueRef(event)}`,
    "",
    "- [ ] Generate parent implementation plan",
    "  - Workflow: sdd-standard",
    "  - Plan mode: parent",
    "  - Trace: spec.md -> design.md -> tasks.md",
    "",
  ].join("\n");
}

function buildSddDrafterPrompt(project, event = {}) {
  return [
    "You are the CodePatchBay SDD drafter.",
    "Return only JSON. Do not execute code or modify files.",
    "",
    "Draft auditable SDD skeleton files from this issue.",
    "Output schema: { spec: markdown, design: markdown, tasks: markdown, requiresApproval: boolean }.",
    "",
    JSON.stringify({
      project,
      issue: {
        number: event.issueNumber ?? null,
        title: event.title || "",
        body: event.body || "",
        url: event.url || null,
        repo: event.repo || null,
      },
    }, null, 2),
  ].join("\n");
}

function parseSddDrafterResponse(raw) {
  const text = stripJsonFence(raw);
  if (!text) return { parsed: null, error: "empty ACP SDD response" };
  try {
    const parsed = JSON.parse(text);
    return {
      parsed: {
        spec: clean(parsed.spec),
        design: clean(parsed.design),
        tasks: clean(parsed.tasks),
        requiresApproval: Boolean(parsed.requiresApproval),
      },
      error: null,
    };
  } catch (error) {
    return { parsed: null, error: `invalid ACP SDD JSON: ${error.message}` };
  }
}

async function draftSddFiles(cpbRoot, project, event, {
  sddDrafterMode = process.env.CPB_SDD_DRAFTER_MODE || "template",
  acpPool = null,
  hubRoot = null,
  cwd = process.cwd(),
  agent = "claude",
  timeoutMs = 60_000,
} = {}) {
  const template = {
    spec: specFromIssue(project, event),
    design: designFromIssue(project, event),
    tasks: taskFromIssue(project, event),
    requiresApproval: false,
  };
  if (sddDrafterMode !== "acp") {
    return { ...template, generator: "template", acp: null };
  }

  const prompt = buildSddDrafterPrompt(project, event);
  let raw = null;
  let error = null;
  try {
    const pool = acpPool || (await import("./acp-pool.js")).getManagedAcpPool({ cpbRoot, hubRoot });
    raw = await pool.execute(agent, prompt, cwd, timeoutMs);
  } catch (err) {
    error = err.message;
  }
  const parsed = raw ? parseSddDrafterResponse(raw) : { parsed: null, error };
  if (!parsed.parsed?.spec || !parsed.parsed?.design || !parsed.parsed?.tasks) {
    return {
      ...template,
      generator: "template",
      acp: { agent, prompt, raw, error: error || parsed.error || "ACP SDD response missing required files" },
    };
  }
  return {
    ...parsed.parsed,
    generator: "acp",
    acp: { agent, prompt, raw, error: null },
  };
}

export async function bootstrapSddFromIssue(cpbRoot, project, event = {}, options = {}) {
  const dir = sddDir(cpbRoot, project);
  const draft = await draftSddFiles(cpbRoot, project, event, options);
  const trace = {
    ...defaultSddTrace(project, { status: "queued" }),
    source: {
      kind: "github_issue",
      issueNumber: event.issueNumber ?? null,
      issueUrl: event.url || null,
      repo: event.repo || null,
    },
    issue: {
      number: event.issueNumber ?? null,
      title: event.title || null,
      url: event.url || null,
    },
  };

  const files = {
    spec: await writeIfMissing(path.join(dir, "spec.md"), draft.spec),
    design: await writeIfMissing(path.join(dir, "design.md"), draft.design),
    tasks: await writeIfMissing(path.join(dir, "tasks.md"), draft.tasks),
  };
  await writeAtomic(sddTracePath(cpbRoot, project), `${JSON.stringify(trace, null, 2)}\n`);

  const generationEventPath = sddGenerationEventsPath(cpbRoot, project);
  const generationEvent = {
    type: "sdd_generation_event",
    schemaVersion: 1,
    project,
    generator: draft.generator,
    source: "github_issue",
    sourceIssueHash: issueHash(event),
    issueNumber: event.issueNumber ?? null,
    issueUrl: event.url || null,
    repo: event.repo || null,
    generatedFiles: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, {
      path: file.path,
      created: file.created,
    }])),
    requiresApproval: Boolean(draft.requiresApproval),
    acp: draft.acp ? {
      agent: draft.acp.agent || null,
      error: draft.acp.error || null,
      used: draft.generator === "acp" && !draft.acp.error,
    } : null,
    ts: new Date().toISOString(),
  };
  await mkdir(path.dirname(generationEventPath), { recursive: true });
  await appendFile(generationEventPath, `${JSON.stringify(generationEvent)}\n`, "utf8");

  const tasks = [{
    id: `sdd-${project}-issue-${event.issueNumber || "unlinked"}-task-1`,
    title: clean(event.title, "SDD implementation task"),
    workflow: "sdd-standard",
    planMode: "parent",
    status: "queued",
    source: "github_issue",
    issueNumber: event.issueNumber ?? null,
  }];

  return {
    trace,
    files,
    tasks,
    queueMetadata: {
      ...sddQueueMetadata(trace),
      sddBootstrap: {
        source: "github_issue",
        issueNumber: event.issueNumber ?? null,
        issueUrl: event.url || null,
        repo: event.repo || null,
        generationEvent,
        generationEventPath,
        files: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, {
          path: file.path,
          created: file.created,
        }])),
      },
      sddTasks: tasks,
    },
  };
}
