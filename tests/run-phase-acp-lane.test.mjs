#!/usr/bin/env node
/**
 * Issue #62 acceptance tests: ui_lane_requested escalation recording.
 * Tests the extracted recordUiEscalations helper directly.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { recordUiEscalations } from "../bridges/record-ui-escalation.mjs";
import { readEvents } from "../server/services/runtime-events.js";

const root = path.resolve(import.meta.dirname, "..");

// --- ui_lane_requested appended when stdout contains escalation marker ---
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "cpb-esc-"));
  const eventsDir = path.join(tempDir, "cpb-task", "events", "escproj");
  await mkdir(eventsDir, { recursive: true });

  const stdout = "Agent output with needs_ui_observation: inspect browser state for visual check\nmore output\n";

  await recordUiEscalations(
    stdout,
    tempDir,       // cpbRoot
    "escproj",     // project
    "job-esc-001", // jobId
    "execute",     // phase
    "claude",      // agent
    "headless",    // acpProfile
  );

  const events = await readEvents(tempDir, "escproj", "job-esc-001");
  const escalationEvents = events.filter((e) => e.type === "ui_lane_requested");

  assert.equal(escalationEvents.length, 1, "must append exactly one ui_lane_requested event");
  const ev = escalationEvents[0];
  assert.equal(ev.jobId, "job-esc-001", "event must carry jobId");
  assert.equal(ev.phase, "execute", "event must carry phase");
  assert.equal(ev.agent, "claude", "event must carry agent");
  assert.equal(ev.marker, "needs_ui_observation", "event must carry the detected marker");
  assert.ok(ev.reason.includes("inspect browser state"), "event reason must include context after marker");
  assert.equal(ev.acpProfile, "headless", "event must carry current acpProfile");
  assert.equal(ev.requestedProfile, "ui", "event must carry requestedProfile ui");
  assert.ok(ev.ts, "event must carry a timestamp");

  // No ui-tool-denied events should be present
  const denialEvents = events.filter((e) => e.action === "ui-tool-denied");
  assert.equal(denialEvents.length, 0, "escalation must not produce ui-tool-denied events");
}

// --- Multiple escalation markers in stdout produce multiple events ---
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "cpb-esc-multi-"));
  const eventsDir = path.join(tempDir, "cpb-task", "events", "escproj2");
  await mkdir(eventsDir, { recursive: true });

  const stdout = "first: needs_ui_observation check visual\nsecond: blocked_requires_ui_lane must use browser\n";

  await recordUiEscalations(
    stdout,
    tempDir,
    "escproj2",
    "job-esc-002",
    "verify",
    "codex",
    "headless",
  );

  const events = await readEvents(tempDir, "escproj2", "job-esc-002");
  const escalationEvents = events.filter((e) => e.type === "ui_lane_requested");

  assert.equal(escalationEvents.length, 2, "must append two ui_lane_requested events");
  const markers = escalationEvents.map((e) => e.marker).sort();
  assert.ok(markers.includes("needs_ui_observation"), "must include needs_ui_observation marker");
  assert.ok(markers.includes("blocked_requires_ui_lane"), "must include blocked_requires_ui_lane marker");
}

// --- No escalation markers produces no events ---
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "cpb-esc-none-"));
  const eventsDir = path.join(tempDir, "cpb-task", "events", "escproj3");
  await mkdir(eventsDir, { recursive: true });

  await recordUiEscalations(
    "Normal output with no escalation markers",
    tempDir,
    "escproj3",
    "job-esc-003",
    "plan",
    "codex",
    "headless",
  );

  const events = await readEvents(tempDir, "escproj3", "job-esc-003");
  const escalationEvents = events.filter((e) => e.type === "ui_lane_requested");
  assert.equal(escalationEvents.length, 0, "no markers must produce zero events");
}

// --- Only known markers are detected (not arbitrary text) ---
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "cpb-esc-strict-"));
  const eventsDir = path.join(tempDir, "cpb-task", "events", "escproj4");
  await mkdir(eventsDir, { recursive: true });

  const stdout = "needs_random_thing and wants_ui_access but not a real marker\n";

  await recordUiEscalations(
    stdout,
    tempDir,
    "escproj4",
    "job-esc-004",
    "execute",
    "claude",
    "headless",
  );

  const events = await readEvents(tempDir, "escproj4", "job-esc-004");
  const escalationEvents = events.filter((e) => e.type === "ui_lane_requested");
  assert.equal(escalationEvents.length, 0, "unknown markers must not produce events");
}
