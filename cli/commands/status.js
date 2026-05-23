import path from "node:path";

const CYAN = "\x1b[0;36m";
const BOLD = "\x1b[1m";
const NC = "\x1b[0m";

export async function run(args, { cpbRoot }) {
  const project = args[0];
  if (!project) {
    console.error("Usage: cpb status <project>");
    process.exit(1);
  }
  const { getProject, resolveHubRoot } = await import("../../server/services/hub-registry.js");
  const { readProjectCodeIndexStatus, formatProjectIndexLine } = await import("../../server/services/project-code-index.js");
  const { listJobs } = await import("../../server/services/job-store.js");
  const { readLease, isLeaseStale } = await import("../../server/services/lease-manager.js");
  const hubRoot = resolveHubRoot(cpbRoot);
  const wdir = path.join(cpbRoot, "wiki/projects", project);

  console.log(`${BOLD}Project: ${project}${NC}`);

  const registered = await getProject(hubRoot, project);
  if (registered?.sourcePath) console.log(`  ${CYAN}Source:${NC} ${registered.sourcePath}`);
  console.log("");

  // Latest plan
  try {
    const inboxDir = path.join(wdir, "inbox");
    const { readdir } = await import("node:fs/promises");
    const entries = (await readdir(inboxDir)).filter((f) => f.startsWith("plan-") && f.endsWith(".md")).sort();
    if (entries.length > 0) {
      const latest = entries[entries.length - 1];
      console.log(`${CYAN}Latest plan:${NC} ${latest}`);
    }
  } catch {}

  // Latest verdict
  try {
    const outputsDir = path.join(wdir, "outputs");
    const { readdir, readFile } = await import("node:fs/promises");
    const entries = (await readdir(outputsDir)).filter((f) => f.startsWith("verdict-") && f.endsWith(".md")).sort();
    if (entries.length > 0) {
      const latest = entries[entries.length - 1];
      const content = await readFile(path.join(outputsDir, latest), "utf8");
      const match = content.match(/^VERDICT:\s*(\w+)/m);
      console.log(`${CYAN}Latest verdict:${NC} ${latest} — ${match?.[1] || "unknown"}`);
    }
  } catch {}

  // Job state
  try {
    const jobs = await listJobs(cpbRoot);
    const projJobs = jobs.filter((j) => j.project === project);
    if (projJobs.length > 0) {
      const terminal = new Set(["completed", "failed", "blocked", "cancelled"]);
      const running = projJobs.filter((j) => !terminal.has(j.status));
      const latest = running[0] || projJobs[projJobs.length - 1];
      let leaseState = "-";
      if (latest.leaseId) {
        try {
          const l = await readLease(cpbRoot, latest.leaseId);
          leaseState = l === null ? "missing" : isLeaseStale(l) ? "stale" : "active";
        } catch {
          leaseState = "error";
        }
      }
      console.log(`${CYAN}Latest job:${NC} ${latest.status} ${latest.phase || "-"} lease:${leaseState} ${(latest.task || "").slice(0, 60)}`);
    }
  } catch {}

  // Index status
  try {
    const idx = await readProjectCodeIndexStatus(registered, { hubRoot });
    if (idx) console.log(`${CYAN}${formatProjectIndexLine(idx)}${NC}`);
  } catch {}
}
