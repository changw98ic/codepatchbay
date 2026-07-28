import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

// Guard test for profile-config consistency (A5 plan Task 2 Step 1).
// Locks the invariant that loadProfile's consumed fields — the `permissions`
// block (write_paths / deny_tools / deny_commands) — are present on every role
// config.json. The repo-root `profiles/` dir is plain data (not compiled into
// dist-tests/), so resolve two levels up from the compiled test module.
const PROFILES_ROOT = path.resolve(import.meta.dirname, "..", "..", "profiles");
const ROLES = ["planner", "executor", "verifier", "reviewer", "remediator"] as const;

test("every role config.json has the consumed permissions block", async () => {
  for (const role of ROLES) {
    const raw = JSON.parse(await readFile(path.join(PROFILES_ROOT, role, "config.json"), "utf8"));
    assert.ok(raw.permissions, `${role} missing permissions`);
    assert.ok(Array.isArray(raw.permissions.write_paths), `${role} write_paths must be array`);
    assert.ok(Array.isArray(raw.permissions.deny_tools), `${role} deny_tools must be array`);
  }
});

// Guard test for read-only role deny_tools alignment (A5 plan Task 4 Step 2).
// Read-only roles (planner, verifier, reviewer) must deny the mutating-tool
// vocabulary so they cannot edit code; executor/remediator must keep write
// capability (deny_tools stays empty). The vocabulary mirrors verifier's
// audited set — the canonical mutating-tool names consumed by
// permission-matrix mergeProfilePolicy (declarative policy field).
const READ_ONLY_ROLES = ["planner", "verifier", "reviewer"] as const;
const WRITE_ROLES = ["executor", "remediator"] as const;

test("read-only roles deny mutating tools; executor/remediator keep write capability", async () => {
  for (const role of READ_ONLY_ROLES) {
    const raw = JSON.parse(await readFile(path.join(PROFILES_ROOT, role, "config.json"), "utf8"));
    assert.ok(
      Array.isArray(raw.permissions.deny_tools) && raw.permissions.deny_tools.length > 0,
      `${role} should deny mutating tools`,
    );
  }
  for (const role of WRITE_ROLES) {
    const raw = JSON.parse(await readFile(path.join(PROFILES_ROOT, role, "config.json"), "utf8"));
    assert.equal(
      Array.isArray(raw.permissions.deny_tools) ? raw.permissions.deny_tools.length : -1,
      0,
      `${role} must keep write capability (deny_tools empty)`,
    );
  }
});

// Schema shape guard (A5 plan Task 6 Step 2). Mirrors
// `schemas/agent-profile.schema.json` (permissions required,
// additionalProperties:false at the root) so the vestigial top-level
// `agent` / `acp` blocks removed in Task 2 can never return on any role.
test("every role config.json conforms to the profile schema shape", async () => {
  for (const role of ROLES) {
    const cfg = JSON.parse(await readFile(path.join(PROFILES_ROOT, role, "config.json"), "utf8"));
    assert.ok(cfg.permissions && Array.isArray(cfg.permissions.write_paths), `${role} permissions.write_paths`);
    assert.ok(Array.isArray(cfg.permissions.deny_tools), `${role} permissions.deny_tools`);
    assert.equal(typeof cfg.permissions.deny_commands, "boolean", `${role} deny_commands boolean`);
    // additionalProperties:false equivalent: reject vestigial agent/acp blocks.
    for (const banned of ["agent", "acp"]) {
      assert.equal(cfg[banned], undefined, `${role} still carries vestigial '${banned}'`);
    }
  }
});
