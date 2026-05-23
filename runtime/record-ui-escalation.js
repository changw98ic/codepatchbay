#!/usr/bin/env node
// Extracted from run-phase.mjs for testability (issue #62).
// Records ui_lane_requested escalation events via the durable event log.

import { detectUiEscalation } from "../core/acp/policy.js";
import { appendEvent } from "../server/services/event-store.js";

export async function recordUiEscalations(stdout, cpbRoot, project, jobId, phase, agent, acpProfile) {
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
