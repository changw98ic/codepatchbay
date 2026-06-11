#!/usr/bin/env node
// Records ui_lane_requested escalation events via the durable event log.

import { detectUiEscalation } from "../core/acp/policy.js";
import { appendEvent } from "../bridges/runtime-services.js";

export async function recordUiEscalations(stdout: string, cpbRoot: string, project: string, jobId: string, phase: string, agent: string, acpProfile?: string) {
  const escalations = detectUiEscalation(stdout || "");
  if (escalations.length === 0) return;
  for (const esc of escalations) {
    await appendEvent(cpbRoot, project, jobId || "", {
      type: "ui_lane_requested",
      jobId: jobId || "",
      phase,
      agent,
      marker: esc.marker,
      reason: esc.reason,
      acpProfile: acpProfile || "headless",
      requestedProfile: "ui",
      ts: new Date().toISOString(),
    });
  }
}
