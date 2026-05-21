import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { loadProfile } from "../server/services/profile-loader.js";

const cpbRoot = path.resolve(import.meta.dirname, "..");

describe("profile-loader ACP defaults", () => {
  const roles = ["planner", "executor", "verifier", "reviewer", "repairer"];

  for (const role of roles) {
    it(`loads ${role} profile with acp.profile === "headless"`, async () => {
      const profile = await loadProfile(cpbRoot, role);
      assert.equal(profile.acp.profile, "headless", `${role} should default to headless`);
    });
  }

  for (const role of roles) {
    it(`loads ${role} profile with acp.uiLane === false`, async () => {
      const profile = await loadProfile(cpbRoot, role);
      assert.equal(profile.acp.uiLane, false, `${role} uiLane should be false`);
    });

    it(`loads ${role} profile with acp.uiLaneReason === ""`, async () => {
      const profile = await loadProfile(cpbRoot, role);
      assert.equal(profile.acp.uiLaneReason, "", `${role} uiLaneReason should be empty`);
    });
  }
});
