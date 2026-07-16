import type { PhaseResult } from "../../shared/types.js";

import { recordValue, type LooseRecord } from "../contracts/types.js";

type EmitAdversarialVerdictEventInput = {
  cpbRoot: string;
  project: string;
  jobId: string;
  phase: string;
  phaseResult: PhaseResult;
  appendEvent: (cpbRoot: string, project: string, jobId: string, event: LooseRecord) => Promise<unknown> | unknown;
  now?: () => string;
};

export async function emitAdversarialVerdictEvent({
  cpbRoot,
  project,
  jobId,
  phase,
  phaseResult,
  appendEvent,
  now = () => new Date().toISOString(),
}: EmitAdversarialVerdictEventInput): Promise<boolean> {
  if (phase !== "adversarial_verify") return false;

  const diagnostics = recordValue(phaseResult.diagnostics);
  const verdict = recordValue(diagnostics.verdict);
  if (!diagnostics.verdict) return false;

  await appendEvent(cpbRoot, project, jobId, {
    type: "adversarial_verdict",
    jobId,
    project,
    phase,
    verdict: diagnostics.verdict,
    artifact: phaseResult.artifact?.name || null,
    status: verdict.status || null,
    reason: verdict.reason || null,
    ts: now(),
  });
  return true;
}
