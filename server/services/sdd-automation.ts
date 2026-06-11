import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultSddTrace, sddDir, sddQueueMetadata, sddTracePath } from "../../core/sdd/trace.js";

const SDD_WORKFLOWS = new Set(["direct", "standard", "complex", "sdd-standard", "blocked"]);
const SDD_PLAN_MODES = new Set(["none", "light", "full", "parent"]);

type LooseRecord = Record<string, any>;

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
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeAtomic(filePath, content);
  return { path: filePath, created: true };
}

function clean(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function issueRef(event: LooseRecord = {}) {
  return event.issueNumber ? `#${event.issueNumber}` : "unlinked issue";
}

function issueHash(event: LooseRecord = {}) {
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

function specFromIssue(project, event: LooseRecord) {
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

function designFromIssue(project, event: LooseRecord) {
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

function taskFromIssue(project, event: LooseRecord) {
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

function normalizeWorkflow(value, fallback = "sdd-standard") {
  const workflow = String(value || "").trim();
  return SDD_WORKFLOWS.has(workflow) ? workflow : fallback;
}

function normalizePlanMode(value, workflow = "sdd-standard") {
  const planMode = String(value || "").trim();
  if (SDD_PLAN_MODES.has(planMode)) return planMode;
  if (workflow === "direct" || workflow === "blocked") return "none";
  if (workflow === "complex") return "full";
  if (workflow === "sdd-standard") return "parent";
  return "light";
}

function parseJsonFrontmatter(markdown) {
  const text = String(markdown || "");
  const match = text.match(/^---(?:json)?\s*\n([\s\S]*?)\n---\s*(?:\n|$)/i);
  if (!match) return { frontmatter: null, body: text };
  try {
    return {
      frontmatter: JSON.parse(match[1].trim()),
      body: text.slice(match[0].length),
    };
  } catch {
    return { frontmatter: null, body: text.slice(match[0].length) };
  }
}

function metadataValue(line) {
  const match = String(line || "").match(/^\s*[-*]?\s*([^:]+):\s*(.+?)\s*$/);
  if (!match) return null;
  return {
    key: match[1].trim().toLowerCase().replace(/\s+/g, ""),
    value: match[2].trim(),
  };
}

function parseChecklistTasks(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const tasks: LooseRecord[] = [];
  let current = null;
  for (const line of lines) {
    const checklist = line.match(/^\s*[-*]\s+\[[ xX]\]\s+(.+?)\s*$/);
    if (checklist) {
      current = { title: checklist[1].trim() };
      tasks.push(current);
      continue;
    }
    if (!current) continue;
    const meta = metadataValue(line);
    if (!meta) continue;
    if (meta.key === "workflow") current.workflow = meta.value;
    else if (meta.key === "planmode") current.planMode = meta.value;
    else if (meta.key === "id") current.id = meta.value;
    else if (meta.key === "parentplan" || meta.key === "parentplanid") current.parentPlanId = meta.value;
    else if (meta.key === "plangroup" || meta.key === "plangroupid") current.planGroupId = meta.value;
    else if (meta.key === "cachekey" || meta.key === "plancachekey") current.planCacheKey = meta.value;
  }
  return tasks;
}

function normalizeTaskId(value, fallback) {
  return String(value || fallback || "")
    .replace(/[^a-zA-Z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || fallback;
}

function normalizeSddTask(task: LooseRecord, index, project, event: LooseRecord = {}, inherited: LooseRecord = {}) {
  const workflow = normalizeWorkflow(task.workflow, inherited.workflow || "sdd-standard");
  const planMode = normalizePlanMode(task.planMode, workflow);
  const title = clean(task.title || task.name || task.description, `SDD implementation task ${index + 1}`);
  return {
    id: normalizeTaskId(task.id, `sdd-${project}-issue-${event.issueNumber || "unlinked"}-task-${index + 1}`),
    title,
    workflow,
    planMode,
    status: clean(task.status, "queued"),
    source: clean(task.source, "github_issue"),
    issueNumber: event.issueNumber ?? null,
    planGroupId: task.planGroupId || inherited.planGroupId || null,
    parentPlanId: task.parentPlanId || inherited.parentPlanId || null,
    planCacheKey: task.planCacheKey || task.cacheKey || inherited.planCacheKey || inherited.cacheKey || null,
  };
}

function stableSddPlanGroupId(project, event: LooseRecord = {}) {
  const payload = JSON.stringify({
    project,
    repo: event.repo || null,
    issueNumber: event.issueNumber ?? null,
  });
  const digest = createHash("sha256").update(payload).digest("hex");
  return `sdd-plan-group-${digest.slice(0, 12)}`;
}

function parseTasksMarkdown(markdown, project, event: LooseRecord = {}) {
  const { frontmatter, body } = parseJsonFrontmatter(markdown);
  const inherited = {
    planGroupId: frontmatter?.planGroupId || stableSddPlanGroupId(project, event),
    parentPlanId: frontmatter?.parentPlanId || null,
    planCacheKey: frontmatter?.planCacheKey || frontmatter?.cacheKey || null,
  };
  const rawTasks = Array.isArray(frontmatter?.tasks) && frontmatter.tasks.length > 0
    ? frontmatter.tasks
    : parseChecklistTasks(body);
  const tasks = rawTasks
    .map((task, index) => normalizeSddTask(task, index, project, event, inherited))
    .filter((task) => task.title);
  if (tasks.length > 0) return tasks;
  return [normalizeSddTask({
    id: `sdd-${project}-issue-${event.issueNumber || "unlinked"}-task-1`,
    title: clean(event.title, "SDD implementation task"),
    workflow: "sdd-standard",
    planMode: "parent",
  }, 0, project, event, inherited)];
}

function buildSddDrafterPrompt(project, event: LooseRecord = {}) {
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
    const parsed: LooseRecord = JSON.parse(text);
    return {
      parsed: {
        spec: clean(parsed.spec),
        design: clean(parsed.design),
        tasks: clean(parsed.tasks),
        requiresApproval: Boolean(parsed.requiresApproval),
      },
      error: null,
    };
  } catch (error: any) {
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
}: LooseRecord = {}) {
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
    const _r = await pool.execute(agent, prompt, cwd, timeoutMs);
    raw = _r.output;
  } catch (err: any) {
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

export async function bootstrapSddFromIssue(cpbRoot, project, event: LooseRecord = {}, options: LooseRecord = {}) {
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

  const tasks = parseTasksMarkdown(draft.tasks, project, event);
  const requiresApproval = Boolean(draft.requiresApproval);

  return {
    trace,
    files,
    tasks,
    requiresApproval,
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
      sddApproval: {
        requiresApproval,
        status: requiresApproval ? "waiting_approval" : "not_required",
        source: draft.generator,
        reason: requiresApproval ? "SDD drafter requested approval before execution" : null,
      },
      sddTasks: tasks,
    },
  };
}
