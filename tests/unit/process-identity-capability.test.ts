import assert from "node:assert/strict";
import { test } from "node:test";

import {
  inspectProcessIdentityCapability,
  resolveProcessIdentityMode,
} from "../../shared/primitives/process-identity-capability.js";

const exactIdentity = {
  pid: 1234,
  birthId: "linux-proc-starttime:42",
  incarnation: "1234:linux-proc-starttime:42",
  capturedAt: "2026-08-02T00:00:00.000Z",
  birthIdPrecision: "exact" as const,
};

test("process identity mode defaults to required and accepts fenced explicitly", () => {
  assert.equal(resolveProcessIdentityMode({}), "required");
  assert.equal(resolveProcessIdentityMode({ CPB_PROCESS_IDENTITY_MODE: "required" }), "required");
  assert.equal(resolveProcessIdentityMode({ CPB_PROCESS_IDENTITY_MODE: "fenced" }), "fenced");
});

test("invalid process identity mode fails before runtime work starts", () => {
  assert.throws(
    () => resolveProcessIdentityMode({ CPB_PROCESS_IDENTITY_MODE: "best-effort" }),
    (error: unknown) => (
      (error as NodeJS.ErrnoException).code === "PROCESS_IDENTITY_MODE_INVALID"
    ),
  );
});

test("fenced preflight permits acquisition but disables stale-owner recovery", () => {
  const result = inspectProcessIdentityCapability({
    mode: "fenced",
    pid: 1234,
    captureIdentity: () => null,
  });

  assert.deepEqual(result, {
    ok: true,
    mode: "fenced",
    identityAvailable: false,
    staleOwnerRecovery: false,
    reason: "exact process identity unavailable; stale lock recovery disabled",
  });
});

test("required preflight rejects an unavailable identity", () => {
  const result = inspectProcessIdentityCapability({
    mode: "required",
    pid: 1234,
    captureIdentity: () => null,
  });

  assert.equal(result.ok, false);
  assert.equal(result.mode, "required");
  assert.equal(result.identityAvailable, false);
  assert.equal(result.staleOwnerRecovery, false);
  assert.equal(result.reason, "exact process identity unavailable");
});

test("available exact identity keeps stale-owner recovery enabled", () => {
  const result = inspectProcessIdentityCapability({
    mode: "required",
    pid: exactIdentity.pid,
    captureIdentity: () => exactIdentity,
  });

  assert.deepEqual(result, {
    ok: true,
    mode: "required",
    identityAvailable: true,
    staleOwnerRecovery: true,
    reason: null,
  });
});
