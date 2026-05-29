export async function run(args, { cpbRoot }) {
  const sub = args[0] || "";
  const isJson = args.includes("--json");

  if (sub === "list") {
    const project = args[1];
    if (!project) {
      console.error("Usage: cpb gates list <project>");
      return 1;
    }

    const { listPendingGates } = await import("../../server/services/approval-gate.js");
    const gates = await listPendingGates(cpbRoot, { project });

    if (isJson) {
      console.log(JSON.stringify(gates, null, 2));
    } else {
      if (gates.length === 0) {
        console.log("No pending approval gates.");
        return 0;
      }

      console.log(`\nPending Approval Gates (${gates.length}):\n`);
      for (const gate of gates) {
        console.log(`  ${gate.jobId}`);
        console.log(`    Project: ${gate.project}`);
        console.log(`    Phase: ${gate.phase || "N/A"}`);
        console.log(`    Operation: ${gate.operation || "N/A"}`);
        console.log(`    Reason: ${gate.reason || "approval required"}`);
        console.log(`    Requested: ${gate.requestedAt ? new Date(gate.requestedAt).toLocaleString() : "N/A"}`);
        if (gate.timeoutAt) {
          const timeout = new Date(gate.timeoutAt);
          console.log(`    Timeout: ${timeout.toLocaleString()} ${timeout < new Date() ? "(EXPIRED)" : ""}`);
        }
        console.log(`    Task: ${gate.task || "N/A"}`);
        console.log("");
      }
    }

    return 0;
  }

  if (sub === "approve" || sub === "reject") {
    const project = args[1];
    const jobId = args[2];
    const action = sub === "approve" ? "approve" : "reject";

    if (!project || !jobId) {
      console.error(`Usage: cpb gates ${action} <project> <jobId>`);
      return 1;
    }

    const { approveGate } = await import("../../server/services/approval-gate.js");
    const { getJobGateStatus } = await import("../../server/services/approval-gate.js");

    const currentStatus = await getJobGateStatus(cpbRoot, project, jobId);

    if (currentStatus.status === "none") {
      console.error(`No approval gate found for job ${jobId}`);
      return 1;
    }

    if (currentStatus.status === "approved") {
      console.error(`Job ${jobId} is already approved`);
      return 1;
    }

    if (currentStatus.status === "timed_out") {
      console.error(`Job ${jobId} approval has timed out`);
      return 1;
    }

    const actor = process.env.USER || "cli";
    const job = await approveGate(cpbRoot, project, jobId, { actor, action });

    if (isJson) {
      console.log(JSON.stringify({ jobId, project, action, actor, job }, null, 2));
    } else {
      console.log(`Job ${jobId} ${action}d by ${actor}`);
    }

    return 0;
  }

  if (sub === "explain" || sub === "status") {
    const project = args[1];
    const jobId = args[2];

    if (!project || !jobId) {
      console.error(`Usage: cpb gates explain <project> <jobId>`);
      return 1;
    }

    const { getJobGateStatus } = await import("../../server/services/approval-gate.js");
    const status = await getJobGateStatus(cpbRoot, project, jobId);

    if (isJson) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(`\nGate Status for ${jobId}:\n`);
      console.log(`  Status: ${status.status}`);
      if (status.error) {
        console.log(`  Error: ${status.error}`);
      } else if (status.status === "pending") {
        console.log(`  Phase: ${status.phase || "N/A"}`);
        console.log(`  Operation: ${status.operation || "N/A"}`);
        console.log(`  Reason: ${status.reason || "approval required"}`);
        console.log(`  Requested: ${status.requestedAt ? new Date(status.requestedAt).toLocaleString() : "N/A"}`);
        if (status.timeoutAt) {
          const timeout = new Date(status.timeoutAt);
          console.log(`  Timeout: ${timeout.toLocaleString()} ${timeout < new Date() ? "(EXPIRED)" : ""}`);
        }
        if (status.channels && status.channels.length > 0) {
          console.log(`  Channels: ${status.channels.join(", ")}`);
        }
      } else if (status.status === "approved") {
        console.log(`  Approved At: ${status.approvedAt ? new Date(status.approvedAt).toLocaleString() : "N/A"}`);
        console.log(`  Actor: ${status.actor || "N/A"}`);
        console.log(`  Action: ${status.action || "N/A"}`);
      } else if (status.status === "timed_out") {
        console.log(`  Timed Out At: ${status.timedOutAt ? new Date(status.timedOutAt).toLocaleString() : "N/A"}`);
        console.log(`  Reason: ${status.reason || "N/A"}`);
      }
      console.log("");
    }

    return 0;
  }

  console.error("Usage: cpb gates <list|approve|reject|explain> [args...]");
  console.error("");
  console.error("Commands:");
  console.error("  cpb gates list <project>           List pending approval gates");
  console.error("  cpb gates approve <project> <id>   Approve a pending gate");
  console.error("  cpb gates reject <project> <id>    Reject a pending gate");
  console.error("  cpb gates explain <project> <id>   Explain gate status for a job");
  return 1;
}
