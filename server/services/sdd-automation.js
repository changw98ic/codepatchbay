import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

export async function bootstrapSddFromIssue(cpbRoot, project, event = {}) {
  const dir = sddDir(cpbRoot, project);
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
    spec: await writeIfMissing(path.join(dir, "spec.md"), specFromIssue(project, event)),
    design: await writeIfMissing(path.join(dir, "design.md"), designFromIssue(project, event)),
    tasks: await writeIfMissing(path.join(dir, "tasks.md"), taskFromIssue(project, event)),
  };
  await writeAtomic(sddTracePath(cpbRoot, project), `${JSON.stringify(trace, null, 2)}\n`);

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
        files: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, {
          path: file.path,
          created: file.created,
        }])),
      },
      sddTasks: tasks,
    },
  };
}
