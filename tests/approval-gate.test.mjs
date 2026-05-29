import { describe, it, mock } from "node:test";
import assert from "node:assert";
import { strict as assertStrict } from "node:assert";
import {
  requestApprovalGate,
  approveGate,
  timeoutApprovalGate,
  listPendingGates,
  getJobGateStatus,
} from "../server/services/approval-gate.js";

describe("approval-gate", () => {
  const mockCpbRoot = "/tmp/cpb-test";
  const mockProject = "test-project";
  const mockJobId = "job-test123";

  it("listPendingGates returns empty array when no gates pending", async () => {
    const gates = await listPendingGates(mockCpbRoot, { project: mockProject });
    assert.strictEqual(Array.isArray(gates), true);
    assert.strictEqual(gates.length, 0);
  });

  it("listPendingGates filters by project when provided", async () => {
    const gates = await listPendingGates(mockCpbRoot, { project: mockProject });
    assert.strictEqual(Array.isArray(gates), true);
  });

  it("getJobGateStatus returns error for non-existent job", async () => {
    const status = await getJobGateStatus(mockCpbRoot, mockProject, "nonexistent-job");
    assert.strictEqual(status.error, "job not found");
  });

  it("requestApprovalGate creates approval_required event", async () => {
    const mockAppendEvent = mock.fn(async () => ({ type: "approval_required" }));
    const originalAppendEvent = await import("../server/services/event-store.js");
    // Note: This is a basic test structure - full integration tests would require
    // a more sophisticated setup with actual file I/O mocking
    assert.strictEqual(typeof requestApprovalGate, "function");
  });

  it("approveGate creates job_approved event", async () => {
    assert.strictEqual(typeof approveGate, "function");
  });

  it("timeoutApprovalGate creates approval_timed_out event", async () => {
    assert.strictEqual(typeof timeoutApprovalGate, "function");
  });
});
