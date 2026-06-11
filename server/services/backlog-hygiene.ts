import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listJobs } from "./job-store.js";
import { listQueue } from "./hub-queue.js";
import { readGithubIssues, closeGithubIssueWithGh } from "./github-issues.js";
import { resolveHubRoot } from "./hub-registry.js";

const execFileAsync = promisify(execFile);
const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const TERMINAL_STATUSES = new Set(["completed", "failed", "blocked", "cancelled", "superseded"]);

function isTerminalJob(job) {
  return TERMINAL_STATUSES.has(job.status);
}

function issueKey(repo, number) {
  return `${repo}#${number}`;
}

function isStale(timestamp) {
  if (!timestamp) return false;
  return Date.now() - new Date(timestamp).getTime() > STALE_THRESHOLD_MS;
}

async function runGh(args, { runCommand = execFileAsync } = {}) {
  const result = await runCommand("gh", args, {
    maxBuffer: 10 * 1024 * 1024,
    encoding: "utf8",
  });
  return typeof result === "string" ? result : result.stdout;
}

async function listIssueComments({ repo, issueNumber }, { runCommand = execFileAsync } = {}) {
  const stdout = await runGh([
    "issue", "view", String(issueNumber),
    "--repo", repo,
    "--json", "comments",
    "--jq", ".comments[] | {id: .id, author: .author.login, body: .body, createdAt: .createdAt}",
  ], { runCommand });
  try {
    return JSON.parse(`[${stdout.trim().split("\n").filter(Boolean).join(",")}]`);
  } catch {
    return [];
  }
}

export function isCpbComment(body) {
  if (!body) return false;
  return body.includes("CodePatchBay queued this issue.")
    || body.includes("CodePatchBay failed this run.")
    || body.includes("CodePatchBay blocked this run.")
    || body.includes("CodePatchBay updated this run.")
    || body.includes("Verified patch ready.")
    || body.includes("Draft PR opened.")
    || body.includes("SDD Draft Requires Approval")
    || body.includes("SDD Draft Approved")
    || body.includes("<!-- cpb-stale-marker -->");
}

export function parseCpbCommentMeta(body) {
  const meta = { kind: null, jobId: null, status: null };
  if (!body) return meta;

  const jobMatch = body.match(/- Job:\s*(\S+)/);
  if (jobMatch) meta.jobId = jobMatch[1];

  if (body.includes("CodePatchBay queued this issue.")) {
    meta.kind = "queued";
  } else if (body.includes("CodePatchBay failed this run.")) {
    meta.kind = "terminal";
    meta.status = "failed";
  } else if (body.includes("CodePatchBay blocked this run.")) {
    meta.kind = "terminal";
    meta.status = "blocked";
  } else if (body.includes("Verified patch ready.")) {
    meta.kind = "terminal";
    meta.status = "passed";
  } else if (body.includes("Draft PR opened.")) {
    meta.kind = "terminal";
    meta.status = "pr-opened";
  } else if (body.includes("SDD Draft Requires Approval")) {
    meta.kind = "sdd-approval";
  } else if (body.includes("SDD Draft Approved")) {
    meta.kind = "sdd-approved";
  } else if (body.includes("CodePatchBay updated this run.")) {
    meta.kind = "update";
  } else if (body.includes("<!-- cpb-stale-marker -->")) {
    meta.kind = "already-marked";
  }

  return meta;
}

export function buildStaleMarkerComment({ jobId, supersededBy, reason }) {
  const lines = [
    "<!-- cpb-stale-marker -->",
    "> **CPB run superseded**",
    "",
  ];
  if (jobId) lines.push(`> Original job: \`${jobId}\``);
  if (supersededBy) lines.push(`> Superseded by: \`${supersededBy}\``);
  if (reason) lines.push(`> Reason: ${reason}`);
  lines.push("", "This run's outcome is no longer current. See the latest CPB comment on this issue for the active run.");
  return lines.join("\n");
}

export function buildSupersededIssueCloseComment({ queueEntryId, supersededByQueueEntryId, reason }) {
  return [
    "### Issue superseded by newer CPB run",
    "",
    `This issue has been superseded. ${reason || "A newer run has replaced the original task."}`,
    "",
    supersededByQueueEntryId ? `- Replacement queue entry: \`${supersededByQueueEntryId}\`` : null,
    queueEntryId ? `- Original queue entry: \`${queueEntryId}\`` : null,
    "",
    "Closing to reduce backlog noise. If this was closed in error, re-open with a new `/cpb run` command.",
    "",
  ].filter((line) => line !== null).join("\n");
}

export async function scanStaleComments(cpbRoot, hubRoot, { dryRun = false, repo = null, runCommand = execFileAsync } = {}) {
  const jobs = await listJobs(cpbRoot);
  const queueEntries = await listQueue(hubRoot);
  const githubIssues = await readGithubIssues(hubRoot);

  // Build a map: issueKey -> [jobs] for all terminal jobs
  const jobsByIssue = new Map();
  for (const job of jobs) {
    if (!isTerminalJob(job)) continue;
    const source = job.sourceContext || {};
    if (source.type !== "github_issue" && source.issueNumber === undefined) continue;
    const r = source.repo || source.repository;
    const n = source.issueNumber;
    if (!r || n === undefined || n === null) continue;
    const key = issueKey(r, n);
    const list = jobsByIssue.get(key) || [];
    list.push(job);
    jobsByIssue.set(key, list);
  }

  // Build queue entry lookup
  const queueByJobId = new Map();
  const supersededEntries = [];
  for (const entry of queueEntries) {
    const m = entry.metadata || {};
    if (m.jobId) queueByJobId.set(m.jobId, entry);
    if (m.originJobId) queueByJobId.set(m.originJobId, entry);
    if (m.finalDisposition?.startsWith("superseded") || m.finalDisposition?.startsWith("rejected")) {
      supersededEntries.push(entry);
    }
  }

  const report = {
    issuesScanned: 0,
    staleComments: [],
    supersededIssues: [],
    errors: [],
  };

  const targetIssues = repo
    ? githubIssues.filter((i) => (i.repository || (i as Record<string, any>).repo) === repo && i.state !== "CLOSED")
    : githubIssues.filter((i) => i.state !== "CLOSED");

  for (const issue of targetIssues) {
    const r = issue.repository || (issue as Record<string, any>).repo;
    const n = issue.number;
    if (!r || !n) continue;

    report.issuesScanned++;
    const key = issueKey(r, n);
    const issueJobs = jobsByIssue.get(key) || [];

    // Skip issues with no CPB runs or with an active run
    if (issueJobs.length === 0) continue;
    const hasActiveRun = issueJobs.some((j) => !isTerminalJob(j));
    if (hasActiveRun) continue;

    // Fetch comments from GitHub
    let comments;
    try {
      comments = await listIssueComments({ repo: r, issueNumber: n }, { runCommand });
    } catch (err) {
      report.errors.push({ repo: r, issueNumber: n, phase: "fetch_comments", message: err.message });
      continue;
    }

    const cpbComments = comments
      .map((c) => ({ ...c, meta: parseCpbCommentMeta(c.body) }))
      .filter((c) => isCpbComment(c.body) || c.meta.kind === "already-marked");

    if (cpbComments.length === 0) continue;

    // Determine the latest terminal comment
    const terminalComments = cpbComments.filter((c) => c.meta.kind === "terminal");
    const latestTerminal = terminalComments.length > 0
      ? terminalComments[terminalComments.length - 1]
      : null;

    // Find stale queued/older terminal comments that should be marked
    const alreadyMarkedIds = new Set(
      cpbComments.filter((c) => c.meta.kind === "already-marked").map((c) => c.id),
    );

    const staleCandidates = cpbComments.filter((c) => {
      if (c.meta.kind === "already-marked") return false;
      if (alreadyMarkedIds.has(c.id)) return false;
      // Mark queued comments as stale if there's a terminal comment
      if (c.meta.kind === "queued" && terminalComments.length > 0) return true;
      // Mark older terminal comments as stale if there are multiple
      if (c.meta.kind === "terminal" && latestTerminal && c.id !== latestTerminal.id) return true;
      return false;
    });

    for (const stale of staleCandidates) {
      const supersededBy = latestTerminal?.meta?.jobId || null;
      const reason = latestTerminal
        ? `Superseded by ${latestTerminal.meta.status} run`
        : "Run no longer active";

      report.staleComments.push({
        repo: r,
        issueNumber: n,
        commentId: stale.id,
        commentKind: stale.meta.kind,
        jobId: stale.meta.jobId,
        supersededByJobId: supersededBy,
        reason,
      });

      if (!dryRun) {
        try {
          const body = buildStaleMarkerComment({
            jobId: stale.meta.jobId,
            supersededBy,
            reason,
          });
          await runGh([
            "issue", "comment", String(n),
            "--repo", r,
            "--body", body,
          ], { runCommand });
        } catch (err) {
          report.errors.push({
            repo: r,
            issueNumber: n,
            phase: "mark_stale_comment",
            commentId: stale.id,
            message: err.message,
          });
        }
      }
    }

    // Check for superseded queue entries pointing at this issue
    const matchingSuperseded = supersededEntries.filter((entry) => {
      const m = entry.metadata || {};
      return m.repo === r && Number(m.issueNumber) === n;
    });

    for (const entry of matchingSuperseded) {
      const m = entry.metadata || {};
      const supersededByQueueId = m.supersededByQueueEntryId || m.supersededByJobId || null;
      const reason = m.finalDisposition || "superseded";

      // Only close if stale (>7d) and superseded
      if (!isStale(entry.updatedAt || entry.createdAt)) continue;

      report.supersededIssues.push({
        repo: r,
        issueNumber: n,
        queueEntryId: entry.id,
        supersededByQueueEntryId: supersededByQueueId,
        reason,
      });

      if (!dryRun) {
        try {
          const body = buildSupersededIssueCloseComment({
            queueEntryId: entry.id,
            supersededByQueueEntryId: supersededByQueueId,
            reason,
          });
          await closeGithubIssueWithGh({ repo: r, number: n, body }, { runCommand });
        } catch (err) {
          report.errors.push({
            repo: r,
            issueNumber: n,
            phase: "close_superseded_issue",
            message: err.message,
          });
        }
      }
    }
  }

  return report;
}

export async function runBacklogHygiene(cpbRoot, { dryRun = false, repo = null, runCommand = execFileAsync } = {}) {
  const hubRoot = resolveHubRoot(cpbRoot);
  return scanStaleComments(cpbRoot, hubRoot, { dryRun, repo, runCommand });
}
