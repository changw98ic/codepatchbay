/**
 * evidence-command-validator: validateCommandObservation spec-compliance.
 *
 * Spec (docs/superpowers/specs/2026-06-12-checklist-first-task-verification-design.md
 * line 280): command / test requires "command identity, cwd/repo root, integer
 * exit code, stdout/stderr or parsed-output digest, worktree identity, and
 * attempt id."
 *
 * The single validator validateCommandObservation serves BOTH the command and
 * test verification methods (dispatched together in validateEvidenceObservation).
 *
 * Rules:
 *   valid      = command text + integer exitCode + output digest + (cwd or repoRoot)
 *   satisfied  = valid + exitCode === 0 + worktreeHead
 *
 * exitCode === 0 is the objective positive signal (clean exit); worktreeHead
 * ties the result to the declared worktree so a stale/forged run cannot
 * satisfy. cwd/repoRoot is required for valid (the record must say where it
 * ran) but is not a pass/fail signal on its own.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateEvidenceObservation } from "../core/workflow/evidence-probes.js";
const commandItem = {
    id: "AC-CMD",
    predicateId: "PRED-CMD",
    verificationMethod: "command",
};
const opts = {
    attemptId: "attempt-cmd",
    finalWorktree: { head: "aaa111", diffHash: "sha256:diff" },
};
test("command validator: exitCode 0 + digest + cwd + worktreeHead -> valid + satisfied", () => {
    const entry = {
        command: "npm test",
        exitCode: 0,
        stdoutSha256: "sha256:out",
        cwd: "/repo/flow",
        worktreeHead: "aaa111",
        attemptId: "attempt-cmd",
    };
    const r = validateEvidenceObservation(entry, commandItem, opts);
    assert.strictEqual(r.valid, true, "must be recordable");
    assert.strictEqual(r.satisfied, true, "clean exit + worktreeHead must satisfy");
});
test("command validator: exitCode 0 but NO worktreeHead -> valid but NOT satisfied (honest, recorded)", () => {
    const entry = {
        command: "npm test",
        exitCode: 0,
        stdoutSha256: "sha256:out",
        cwd: "/repo/flow",
        attemptId: "attempt-cmd",
        // worktreeHead missing — cannot tie result to declared worktree
    };
    const r = validateEvidenceObservation(entry, commandItem, opts);
    assert.strictEqual(r.valid, true, "structurally complete command record is recordable");
    assert.strictEqual(r.satisfied, false, "without worktreeHead it must NOT satisfy (anti-forgery)");
});
test("command validator: exitCode 1 -> valid but NOT satisfied", () => {
    const entry = {
        command: "npm test",
        exitCode: 1,
        stdoutSha256: "sha256:out",
        cwd: "/repo/flow",
        worktreeHead: "aaa111",
        attemptId: "attempt-cmd",
    };
    const r = validateEvidenceObservation(entry, commandItem, opts);
    assert.strictEqual(r.valid, true, "a failing command is still a recordable observation");
    assert.strictEqual(r.satisfied, false, "non-zero exit must not satisfy");
});
test("command validator: missing cwd/repoRoot -> NOT valid (record incomplete)", () => {
    const entry = {
        command: "npm test",
        exitCode: 0,
        stdoutSha256: "sha256:out",
        worktreeHead: "aaa111",
        attemptId: "attempt-cmd",
        // cwd/repoRoot missing — record does not say WHERE it ran
    };
    const r = validateEvidenceObservation(entry, commandItem, opts);
    assert.strictEqual(r.valid, false, "record without a location is incomplete");
    assert.strictEqual(r.satisfied, false, "invalid implies not satisfied");
});
test("command validator: repoRoot satisfies the location requirement (cwd absent)", () => {
    const entry = {
        command: "npm test",
        exitCode: 0,
        stdoutSha256: "sha256:out",
        repoRoot: "/repo/flow",
        worktreeHead: "aaa111",
        attemptId: "attempt-cmd",
    };
    const r = validateEvidenceObservation(entry, commandItem, opts);
    assert.strictEqual(r.valid, true, "repoRoot satisfies the location requirement");
    assert.strictEqual(r.satisfied, true, "clean exit + worktreeHead satisfies");
});
test("command validator: stderrSha256 satisfies the digest requirement (stdout absent)", () => {
    const entry = {
        command: "npm test",
        exitCode: 0,
        stderrSha256: "sha256:err",
        cwd: "/repo/flow",
        worktreeHead: "aaa111",
        attemptId: "attempt-cmd",
    };
    const r = validateEvidenceObservation(entry, commandItem, opts);
    assert.strictEqual(r.valid, true, "stderr digest satisfies the digest requirement");
    assert.strictEqual(r.satisfied, true, "clean exit + worktreeHead satisfies");
});
test("command validator: test verificationMethod uses the SAME validator (dispatched together)", () => {
    const testItem = { ...commandItem, verificationMethod: "test" };
    const entry = {
        command: "npm run test:integration",
        exitCode: 0,
        stdoutSha256: "sha256:integ",
        cwd: "/repo/flow",
        worktreeHead: "aaa111",
        attemptId: "attempt-cmd",
    };
    const r = validateEvidenceObservation(entry, testItem, opts);
    assert.strictEqual(r.valid, true, "test method shares the command validator");
    assert.strictEqual(r.satisfied, true, "test method satisfies identically to command");
});
