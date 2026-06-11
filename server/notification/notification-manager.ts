// @ts-nocheck
import { FailureKind } from "../../core/contracts/failure.js";

export class NotificationManager {
  constructor(hubRoot) {
    this.hubRoot = hubRoot;
  }

  formatJobResult(entry, jobResult, assignment) {
    const failure = jobResult.failure;
    if (!failure) {
      return this.formatSuccess(entry, jobResult, assignment);
    }
    return this.formatFailure(entry, jobResult, assignment);
  }

  formatSuccess(entry, result, assignment) {
    const lines = [
      `**CodePatchbay completed this run.**`,
      "",
      `- **Queue entry**: ${entry.id}`,
      `- **Assignment**: ${assignment?.assignmentId || "N/A"}`,
      `- **Job**: ${result.jobId || "N/A"}`,
      `- **Phases**: ${result.phaseResults?.map(r => `${r.phase}: ${r.status}`).join(", ") || "N/A"}`,
    ];
    return lines.join("\n");
  }

  formatFailure(entry, result, assignment) {
    const f = result.failure;
    const lines = [
      `**CodePatchbay failed this run.**`,
      "",
      `- **Queue entry**: ${entry.id}`,
      `- **Assignment**: ${assignment?.assignmentId || "N/A"}`,
      `- **Job**: ${result.jobId || "N/A"}`,
      `- **Phase**: ${f.phase || "N/A"}`,
      `- **Failure kind**: ${f.kind}`,
      `- **Reason**: ${(f.reason || "").slice(0, 300)}`,
      `- **Retryable**: ${f.retryable ? "yes" : "no"}`,
    ];

    if (f.exitCode) lines.push(`- **Exit code**: ${f.exitCode}`);
    if (f.signal) lines.push(`- **Signal**: ${f.signal}`);

    return lines.join("\n");
  }

  formatSupervisorDecision(entry, decision) {
    const lines = [
      `**Supervisor Agent decision:**`,
      "",
      `- **Action**: ${decision.action}`,
      `- **Reason**: ${(decision.reason || "").slice(0, 300)}`,
      `- **Confidence**: ${decision.confidence || "N/A"}`,
    ];
    if (decision.params && Object.keys(decision.params).length > 0) {
      lines.push(`- **Params**: ${JSON.stringify(decision.params)}`);
    }
    return lines.join("\n");
  }
}
