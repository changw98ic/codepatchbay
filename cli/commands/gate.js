import { listJobs, getJob } from "../../server/services/job-store.js";
import { approveGate } from "../../server/services/approval-gate.js";
import { requestCancelJob } from "../../server/services/job-store.js";

const CYAN = "\x1b[0;36m";
const GREEN = "\x1b[0;32m";
const YELLOW = "\x1b[1;33m";
const RED = "\x1b[0;31m";
const BOLD = "\x1b[1m";
const NC = "\x1b[0m";

function optionValue(args, name) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}

function usage() {
  return [
    "Usage: cpb gate <list|approve|deny|status> [options]",
    "",
    "Commands:",
    "  cpb gate list [--project <name>] [--json]       List pending approval gates",
    "  cpb gate status <jobId> [--project <name>]      Show gate status for a job",
    "  cpb gate approve <jobId> [--project <name>]     Approve a pending gate",
    "  cpb gate deny <jobId> [--project <name>] [reason]  Deny (cancel) a pending gate",
  ].join("\n");
}

function isApprovalPending(job) {
  return job.status === "blocked" || job.phase === "approval_required"
    || (job.events && job.events.some(e => e.type === "approval_required"))
    || job.blockedReason?.includes("approval");
}

async function findApprovalGates(cpbRoot, project) {
  const opts = {};
  const jobs = await listJobs(cpbRoot, { project, ...opts });
  return jobs.filter(isApprovalPending);
}

async function resolveJob(cpbRoot, jobId, project) {
  if (project) {
    return getJob(cpbRoot, project, jobId);
  }
  const allJobs = await listJobs(cpbRoot);
  return allJobs.find(j => j.jobId === jobId) || null;
}

async function gateList(args, { cpbRoot }) {
  const project = optionValue(args, "--project");
  const gates = await findApprovalGates(cpbRoot, project);

  if (args.includes("--json")) {
    console.log(JSON.stringify(gates, null, 2));
    return 0;
  }

  if (gates.length === 0) {
    console.log(`${GREEN}No pending approval gates.${NC}`);
    return 0;
  }

  console.log(`${BOLD}Pending Approval Gates (${gates.length}):${NC}`);
  for (const g of gates) {
    const reason = g.blockedReason || "approval required";
    console.log(`  ${CYAN}${g.jobId}${NC}  project=${g.project}  phase=${g.phase || "?"}  reason=${reason}`);
  }
  return 0;
}

async function gateStatus(args, { cpbRoot }) {
  const jobId = args.find(a => !a.startsWith("-"));
  if (!jobId) {
    console.error("Usage: cpb gate status <jobId> [--project <name>]");
    return 1;
  }

  const project = optionValue(args, "--project");
  const job = await resolveJob(cpbRoot, jobId, project);
  if (!job?.jobId) {
    console.error(`${RED}Job not found: ${jobId}${NC}`);
    return 1;
  }

  const output = {
    jobId: job.jobId,
    project: job.project,
    status: job.status,
    phase: job.phase,
    blockedReason: job.blockedReason || null,
    approvalPending: isApprovalPending(job),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };

  if (args.includes("--json")) {
    console.log(JSON.stringify(output, null, 2));
    return 0;
  }

  console.log(`${BOLD}Job:${NC}       ${output.jobId}`);
  console.log(`${BOLD}Project:${NC}   ${output.project}`);
  console.log(`${BOLD}Status:${NC}    ${output.status}`);
  console.log(`${BOLD}Phase:${NC}     ${output.phase || "(none)"}`);
  console.log(`${BOLD}Blocked:${NC}   ${output.blockedReason || "(no)"}`);
  console.log(`${BOLD}Approval:${NC}  ${output.approvalPending ? `${YELLOW}PENDING${NC}` : `${GREEN}none${NC}`}`);
  return 0;
}

async function gateApprove(args, { cpbRoot }) {
  const jobId = args.find(a => !a.startsWith("-"));
  if (!jobId) {
    console.error("Usage: cpb gate approve <jobId> [--project <name>]");
    return 1;
  }

  const project = optionValue(args, "--project");
  const job = await resolveJob(cpbRoot, jobId, project);
  if (!job?.jobId) {
    console.error(`${RED}Job not found: ${jobId}${NC}`);
    return 1;
  }
  if (!isApprovalPending(job)) {
    console.error(`${YELLOW}Job ${jobId} is not pending approval (status: ${job.status})${NC}`);
    return 1;
  }

  const updated = await approveGate(cpbRoot, job.project, jobId, {
    actor: "cli",
    action: "approved",
  });
  console.log(`${GREEN}Approved gate for job ${jobId}.${NC}`);
  if (args.includes("--json")) {
    console.log(JSON.stringify(updated, null, 2));
  }
  return 0;
}

async function gateDeny(args, { cpbRoot }) {
  const jobId = args.find(a => !a.startsWith("-"));
  if (!jobId) {
    console.error("Usage: cpb gate deny <jobId> [--project <name>] [reason]");
    return 1;
  }

  const project = optionValue(args, "--project");
  const reasonIdx = args.findIndex(a => !a.startsWith("-") && a !== jobId);
  const reason = reasonIdx >= 0 ? args.slice(reasonIdx).join(" ") : "denied via CLI";

  const job = await resolveJob(cpbRoot, jobId, project);
  if (!job?.jobId) {
    console.error(`${RED}Job not found: ${jobId}${NC}`);
    return 1;
  }
  if (!isApprovalPending(job)) {
    console.error(`${YELLOW}Job ${jobId} is not pending approval (status: ${job.status})${NC}`);
    return 1;
  }

  const updated = await requestCancelJob(cpbRoot, job.project, jobId, { reason });
  console.log(`${RED}Denied gate for job ${jobId}: ${reason}${NC}`);
  if (args.includes("--json")) {
    console.log(JSON.stringify(updated, null, 2));
  }
  return 0;
}

export async function run(args, { cpbRoot } = {}) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return 0;
  }

  if (!cpbRoot) cpbRoot = process.env.CPB_ROOT || process.cwd();

  const subcommand = args[0];
  switch (subcommand) {
    case "list":
      return gateList(args.slice(1), { cpbRoot });
    case "status":
      return gateStatus(args.slice(1), { cpbRoot });
    case "approve":
      return gateApprove(args.slice(1), { cpbRoot });
    case "deny":
      return gateDeny(args.slice(1), { cpbRoot });
    default:
      console.error(usage());
      return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2))
    .then((code) => {
      if (Number.isInteger(code)) process.exitCode = code;
    })
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    });
}
