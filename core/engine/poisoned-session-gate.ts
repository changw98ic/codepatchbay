import { readFile as defaultReadFile } from "node:fs/promises";
import { FailureKind, failure } from "../contracts/failure.js";
import { isPhasePassed, phaseFailed } from "../contracts/phase-result.js";
import { classifyPoisonedSession } from "./poisoned-session.js";
import type { PhaseResult } from "../../shared/types.js";

import type { LooseRecord } from "../contracts/types.js";

type EvaluatePoisonedSessionGateContext = {
  cpbRoot: string;
  project: string;
  jobId: string;
  phase: string;
  nodeId: string;
  attemptId?: string | null;
  result: PhaseResult;
  appendEvent: (cpbRoot: string, project: string, jobId: string, event: LooseRecord) => Promise<unknown> | unknown;
  readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  now?: () => string;
  writeStderr?: (message: string) => void;
};

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String(error.code || "")
    : "";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function evaluatePoisonedSessionGate({
  cpbRoot,
  project,
  jobId,
  phase,
  nodeId,
  attemptId = null,
  result,
  appendEvent,
  readFile = defaultReadFile,
  now = () => new Date().toISOString(),
  writeStderr = (message: string) => process.stderr.write(message),
}: EvaluatePoisonedSessionGateContext): Promise<PhaseResult> {
  if (!isPhasePassed(result) || !result.artifact?.path || typeof result.artifact.path !== "string") {
    return result;
  }

  try {
    const raw = await readFile(result.artifact.path, "utf8").catch(() => "");
    const head = raw.slice(0, 2000);
    const poisonCheck = classifyPoisonedSession(head, {
      stderr: String(result.stderr || result.stderrSnippet || ""),
    });
    if (!poisonCheck.poisoned) return result;

    await appendEvent(cpbRoot, project, jobId, {
      type: "phase_poisoned_session",
      jobId,
      project,
      phase,
      nodeId,
      attemptId,
      reasons: poisonCheck.reasons,
      classifier: poisonCheck.classifier,
      ts: now(),
    });

    return phaseFailed({
      phase,
      failure: failure({
        kind: FailureKind.POISONED_SESSION,
        phase,
        reason: `poisoned session: ${poisonCheck.reasons.join(", ")}`,
        retryable: false,
        cause: { reasons: poisonCheck.reasons, classifier: poisonCheck.classifier },
      }),
    });
  } catch (error) {
    const code = errorCode(error);
    if (code && code !== "ENOENT" && code !== "ENOTDIR") {
      writeStderr(`[run-job] poisoned session check error: ${errorMessage(error)}\n`);
    }
    return result;
  }
}
