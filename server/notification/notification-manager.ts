import { FailureKind } from "../../core/contracts/failure.js";

export class NotificationManager {
  hubRoot: string;

  constructor(hubRoot: string) {
    this.hubRoot = hubRoot;
  }

  formatJobResult(entry: Record<string, any>, jobResult: Record<string, any>, assignment?: Record<string, any> | null) {
    const failure = jobResult.failure;
    if (!failure) {
      return this.formatSuccess(entry, jobResult, assignment);
    }
    return this.formatFailure(entry, jobResult, assignment);
  }

  formatSuccess(entry: Record<string, any>, result: Record<string, any>, assignment?: Record<string, any> | null) {
    const lines = [
      `**CodePatchbay completed this run.**`,
      "",
      `- **Queue entry**: ${entry.id}`,
      `- **Assignment**: ${assignment?.assignmentId || "N/A"}`,
      `- **Job**: ${result.jobId || "N/A"}`,
      `- **Phases**: ${result.phaseResults?.map((r: Record<string, any>) => `${r.phase}: ${r.status}`).join(", ") || "N/A"}`,
    ];
    return lines.join("\n");
  }

  formatFailure(entry: Record<string, any>, result: Record<string, any>, assignment?: Record<string, any> | null) {
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

  formatSupervisorDecision(_entry: Record<string, any>, decision: Record<string, any>) {
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
