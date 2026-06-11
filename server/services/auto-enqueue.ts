import { readGithubIssues } from "./github-issues.js";
import { loadQueue } from "./hub-queue.js";
import { getProject } from "./hub-registry.js";

export function matchAutomationRule(issue, rules) {
  if (!Array.isArray(rules) || rules.length === 0) return null;
  for (const rule of rules) {
    const m = rule.match || {};
    if (m.labels && Array.isArray(m.labels)) {
      const issueLabels = new Set(issue.labels || []);
      const hasAll = m.labels.every((l) => issueLabels.has(l));
      if (!hasAll) continue;
    }
    if (m.titlePattern) {
      try {
        if (!new RegExp(m.titlePattern, "i").test(issue.title || "")) continue;
      } catch {
        continue;
      }
    }
    return rule;
  }
  return null;
}

export function isExcluded(issue, exclude) {
  if (!exclude) return false;
  if (exclude.labels && Array.isArray(exclude.labels)) {
    const issueLabels = new Set(issue.labels || []);
    if (exclude.labels.some((l) => issueLabels.has(l))) return true;
  }
  return false;
}

export function issueToNormalizedEvent(issue, project) {
  return {
    status: "ok",
    type: "github_issue",
    event: "issues",
    action: "opened",
    delivery: `auto-enqueue-${Date.now()}-${issue.number}`,
    repo: project.github?.fullName || issue.repository || "",
    projectId: project.id,
    issueNumber: issue.number,
    actor: "auto-enqueue",
    labels: issue.labels || [],
    url: issue.url || "",
    title: issue.title || "",
    body: issue.body || "",
  };
}

function issueMatchesProject(issue, project) {
  if (issue.projectId === project.id) return true;
  if (issue.projectId && issue.projectId !== "flow") return false;
  const repo = project.github?.fullName;
  return Boolean(repo && (issue.repository || issue.repo || issue.repositoryFullName) === repo);
}

function issueQueueKey(repo, number) {
  return `${repo || ""}#${Number(number)}`;
}

export async function autoEnqueueSyncedIssues(hubRoot, cpbRoot, projectId, { createJobFn = null, dryRun = false } = {}) {
  const project = await getProject(hubRoot, projectId);
  if (!project) return { error: `Project '${projectId}' not found`, enqueued: 0, skipped: 0, duplicates: 0, total: 0 };

  const automation = project.github?.automation;
  if (!automation?.enabled) return { enqueued: 0, skipped: 0, duplicates: 0, total: 0, reason: "automation not enabled" };

  const issues = await readGithubIssues(hubRoot);
  const projectIssues = issues.filter((i) => i.state === "OPEN" && issueMatchesProject(i, project));

  const queue = await loadQueue(hubRoot);
  const queuedIssueKeys = new Set(
    queue.entries
      .filter((e) => e.projectId === project.id && e.metadata?.issueNumber && (e.type === "github_issue" || e.metadata?.source === "github"))
      .map((e) => issueQueueKey(e.metadata?.repo || e.metadata?.repository || project.github?.fullName, e.metadata.issueNumber)),
  );

  let enqueued = 0;
  let skipped = 0;
  let duplicates = 0;
  const matched = [];

  for (const issue of projectIssues) {
    const key = issueQueueKey(issue.repository || (issue as Record<string, any>).repo || project.github?.fullName, issue.number);
    if (queuedIssueKeys.has(key)) { duplicates++; continue; }
    if (isExcluded(issue, automation.exclude)) { skipped++; continue; }

    const rule = matchAutomationRule(issue, automation.rules);
    if (!rule) { skipped++; continue; }

    matched.push({ number: issue.number, title: issue.title, rule: rule.name, action: rule.action });

    if (dryRun) { enqueued++; continue; }

    try {
      const event = issueToNormalizedEvent(issue, project);
      const match = { matched: true, workflow: rule.action?.workflow || "standard", ...(rule.action || {}) };
      if (createJobFn) {
        await createJobFn(cpbRoot, event, match, { hubRoot, sourcePath: project.sourcePath });
      } else {
        const { createGithubIssueQueueJob } = await import("./event-source.js");
        await createGithubIssueQueueJob(cpbRoot, event, match, { hubRoot, sourcePath: project.sourcePath });
      }
      enqueued++;
    } catch (err) {
      if (err.message?.includes("duplicate")) { duplicates++; }
      else { skipped++; }
    }
  }

  return { enqueued, skipped, duplicates, total: projectIssues.length, matched: dryRun ? matched : undefined };
}
