import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  categorizeVerdictEnvelope,
  extractExperienceFromVerdict,
  extractExperienceFromTerminalState,
  writeExperience,
  rebuildExperienceIndex,
} from "../server/services/experience-extractor.js";

let tmpDir;
let cpbRoot;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "exp-extractor-test-"));
  cpbRoot = tmpDir;
  // Create wiki/experience dirs
  await mkdir(path.join(cpbRoot, "wiki", "experience", "failures"), { recursive: true });
  await mkdir(path.join(cpbRoot, "wiki", "experience", "patterns"), { recursive: true });
  await mkdir(path.join(cpbRoot, "wiki", "experience", "gotchas"), { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("categorizeVerdictEnvelope", () => {
  it("categorizes fail as failure/high", () => {
    const result = categorizeVerdictEnvelope({ status: "fail", reason: "broken" });
    assert.deepEqual(result, { category: "failure", severity: "high" });
  });

  it("categorizes infra_error as gotcha/high", () => {
    const result = categorizeVerdictEnvelope({ status: "infra_error", reason: "timeout" });
    assert.deepEqual(result, { category: "gotcha", severity: "high" });
  });

  it("categorizes inconclusive with blocking as gotcha/medium", () => {
    const result = categorizeVerdictEnvelope({
      status: "inconclusive",
      reason: "missing input",
      blocking: ["some check"],
    });
    assert.deepEqual(result, { category: "gotcha", severity: "medium" });
  });

  it("categorizes inconclusive without blocking as gotcha/low", () => {
    const result = categorizeVerdictEnvelope({ status: "inconclusive", reason: "unclear" });
    assert.deepEqual(result, { category: "gotcha", severity: "low" });
  });

  it("categorizes pass with fix signal as pattern/low", () => {
    const result = categorizeVerdictEnvelope({
      status: "pass",
      reason: "Fixed the race condition in event store",
    });
    assert.deepEqual(result, { category: "pattern", severity: "low" });
  });

  it("returns null for pure pass without fix signal", () => {
    const result = categorizeVerdictEnvelope({
      status: "pass",
      reason: "All tests pass, feature complete",
    });
    assert.equal(result, null);
  });

  it("returns null for unknown status", () => {
    const result = categorizeVerdictEnvelope({ status: "weird", reason: "?" });
    assert.equal(result, null);
  });
});

describe("writeExperience", () => {
  const experience = {
    key: "proj-j1-verdict-failure",
    slug: "proj-j1-verdict-failure",
    category: "failure",
    severity: "high",
    project: "proj",
    jobId: "j1",
    source: "verdict-001",
    source_type: "verdict",
    source_artifact: "/path/to/verdict.md",
    confidence: 0.9,
    date: "2026-06-02",
    tags: ["event-store", "race"],
    title: "[FAIL] Race condition in event store",
    reason: "Event store has a race condition",
    details: "Blocking: 1 item(s)",
    fix: "待补充",
    prevention: "待补充",
  };

  it("writes experience file with frontmatter", async () => {
    const result = await writeExperience(cpbRoot, experience);
    assert.equal(result, true);

    const content = await readFile(
      path.join(cpbRoot, "wiki", "experience", "failures", "proj-j1-verdict-failure.md"),
      "utf8",
    );
    assert.ok(content.includes("source: verdict-001"));
    assert.ok(content.includes("project: proj"));
    assert.ok(content.includes("category: failure"));
    assert.ok(content.includes("[FAIL] Race condition in event store"));
    assert.ok(content.includes("## 修复"));
    assert.ok(content.includes("## 预防"));
  });

  it("skips if file already exists (idempotent)", async () => {
    const r1 = await writeExperience(cpbRoot, experience);
    assert.equal(r1, true);
    const r2 = await writeExperience(cpbRoot, experience);
    assert.equal(r2, false);
  });

  it("overwrites if force=true", async () => {
    await writeExperience(cpbRoot, experience);
    const updated = { ...experience, title: "[FAIL] Updated title" };
    const r2 = await writeExperience(cpbRoot, updated, { force: true });
    assert.equal(r2, true);
    const content = await readFile(
      path.join(cpbRoot, "wiki", "experience", "failures", "proj-j1-verdict-failure.md"),
      "utf8",
    );
    assert.ok(content.includes("Updated title"));
  });
});

describe("extractExperienceFromVerdict", () => {
  it("extracts failure experience from FAIL verdict file", async () => {
    const verdictContent = JSON.stringify({
      status: "fail",
      reason: "Tests failed",
      blocking: [{ criterion: "unit tests", file: "test.js" }],
    });
    const verdictPath = path.join(cpbRoot, "verdict-001.md");
    await writeFile(verdictPath, verdictContent);

    const result = await extractExperienceFromVerdict(cpbRoot, "proj", "j1", verdictPath);
    assert.equal(result, true);

    const expFile = path.join(cpbRoot, "wiki", "experience", "failures", "proj-j1-verdict-001-failure.md");
    const content = await readFile(expFile, "utf8");
    assert.ok(content.includes("category: failure"));
    assert.ok(content.includes("## 修复"));
    assert.ok(content.includes("unit tests"));
    assert.ok(content.includes("## 预防"));
  });

  it("returns null for pure PASS verdict", async () => {
    const verdictContent = JSON.stringify({
      status: "pass",
      reason: "All good",
    });
    const verdictPath = path.join(cpbRoot, "verdict-002.md");
    await writeFile(verdictPath, verdictContent);

    const result = await extractExperienceFromVerdict(cpbRoot, "proj", "j2", verdictPath);
    assert.equal(result, null);
  });

  it("returns null if artifact file doesn't exist", async () => {
    const result = await extractExperienceFromVerdict(
      cpbRoot, "proj", "j3", "/nonexistent/verdict.md",
    );
    assert.equal(result, null);
  });
});

describe("extractExperienceFromTerminalState", () => {
  it("extracts gotcha from pool_exhausted", async () => {
    const state = {
      status: "failed",
      failureCode: "pool_exhausted",
      failurePhase: "execute",
      blockedReason: "ACP pool exhausted",
    };
    const result = await extractExperienceFromTerminalState(
      cpbRoot, "proj", "j1", state, "pool_exhausted",
    );
    assert.equal(result, true);

    const expFile = path.join(cpbRoot, "wiki", "experience", "gotchas", "proj-j1-pool-exhausted-gotcha.md");
    const content = await readFile(expFile, "utf8");
    assert.ok(content.includes("category: gotcha"));
    assert.ok(content.includes("pool_exhausted"));
  });

  it("extracts gotcha from job_cancelled", async () => {
    const state = {
      status: "cancelled",
      blockedReason: "user requested",
    };
    const result = await extractExperienceFromTerminalState(
      cpbRoot, "proj", "j2", state, "job_cancelled",
    );
    assert.equal(result, true);
  });

  it("returns null for non-terminal event type", async () => {
    const result = await extractExperienceFromTerminalState(
      cpbRoot, "proj", "j3", {}, "phase_started",
    );
    assert.equal(result, null);
  });
});

describe("rebuildExperienceIndex", () => {
  it("rebuilds index from filesystem", async () => {
    // Write some experience files
    await writeExperience(cpbRoot, {
      key: "p-j1-v-failure", slug: "p-j1-v-failure", category: "failure",
      severity: "high", project: "p", jobId: "j1", source: "v-1",
      source_type: "verdict", source_artifact: null, confidence: null,
      date: "2026-06-01", tags: ["test"], title: "[FAIL] broken",
      reason: "broken", details: "", fix: "待补充", prevention: "待补充",
    });
    await writeExperience(cpbRoot, {
      key: "p-j2-v-pattern", slug: "p-j2-v-pattern", category: "pattern",
      severity: "low", project: "p", jobId: "j2", source: "v-2",
      source_type: "verdict", source_artifact: null, confidence: null,
      date: "2026-06-02", tags: ["fix"], title: "[FIX] fixed it",
      reason: "fixed", details: "", fix: "待补充", prevention: "待补充",
    });

    await rebuildExperienceIndex(cpbRoot);

    const index = await readFile(
      path.join(cpbRoot, "wiki", "experience", "index.md"),
      "utf8",
    );
    assert.ok(index.includes("## Failures"));
    assert.ok(index.includes("## Patterns"));
    assert.ok(index.includes("## Gotchas"));
    assert.ok(index.includes("[FAIL] broken"));
    assert.ok(index.includes("[FIX] fixed it"));
  });

  it("handles empty experience directory", async () => {
    await rebuildExperienceIndex(cpbRoot);
    const index = await readFile(
      path.join(cpbRoot, "wiki", "experience", "index.md"),
      "utf8",
    );
    assert.ok(index.includes("_(none)_"));
  });
});

describe("legacy Markdown verdict extraction", () => {
  it("extracts failure from legacy ## Status / ## Reason / ## Details / ## Confidence", async () => {
    const verdictContent = [
      "# Verdict",
      "",
      "## Status",
      "FAIL",
      "",
      "## Reason",
      "The event store has a race condition on concurrent writes",
      "",
      "## Details",
      "Two concurrent appendEvent calls can corrupt the JSONL file. The lock is not held for the full write.",
      "",
      "## Confidence",
      "0.85",
      "",
      "## Acceptance-Criteria",
      "- [x] race fixed",
    ].join("\n");

    const verdictPath = path.join(cpbRoot, "verdict-legacy.md");
    await writeFile(verdictPath, verdictContent);

    const result = await extractExperienceFromVerdict(cpbRoot, "proj", "j-legacy", verdictPath);
    assert.equal(result, true);

    const expFile = path.join(cpbRoot, "wiki", "experience", "failures", "proj-j-legacy-verdict-legacy-failure.md");
    const content = await readFile(expFile, "utf8");
    assert.ok(content.includes("category: failure"));
    assert.ok(content.includes("severity: high"));
    assert.ok(content.includes("confidence: 0.85"));
    assert.ok(content.includes("race condition"));
    assert.ok(content.includes("concurrent"));
  });

  it("extracts pattern from legacy PASS verdict with fix signal", async () => {
    const verdictContent = [
      "## Status",
      "PASS",
      "",
      "## Reason",
      "Fixed the deadlock in lease manager by reordering lock acquisition",
      "",
      "## Confidence",
      "0.9",
    ].join("\n");

    const verdictPath = path.join(cpbRoot, "verdict-legacy-pass.md");
    await writeFile(verdictPath, verdictContent);

    const result = await extractExperienceFromVerdict(cpbRoot, "proj", "j-pass", verdictPath);
    assert.equal(result, true);

    const expFile = path.join(cpbRoot, "wiki", "experience", "patterns", "proj-j-pass-verdict-legacy-pass-pattern.md");
    const content = await readFile(expFile, "utf8");
    assert.ok(content.includes("category: pattern"));
    assert.ok(content.includes("deadlock"));
  });
});

describe("job_failed terminal state → failure category", () => {
  it("generates failure (not gotcha) for job_failed without verdict", async () => {
    const state = {
      status: "failed",
      failureCode: "FATAL",
      failurePhase: "execute",
      blockedReason: "worker crashed",
    };
    const result = await extractExperienceFromTerminalState(
      cpbRoot, "proj", "j-fail", state, "job_failed",
    );
    assert.equal(result, true);

    const expFile = path.join(cpbRoot, "wiki", "experience", "failures", "proj-j-fail-job-failed-failure.md");
    const content = await readFile(expFile, "utf8");
    assert.ok(content.includes("category: failure"));
    assert.ok(content.includes("[FAIL]"));
    assert.ok(!content.includes("[GOTCHA]"));
  });

  it("generates gotcha for pool_exhausted (not failure)", async () => {
    const state = {
      status: "failed",
      failureCode: "pool_exhausted",
      blockedReason: "ACP pool exhausted",
    };
    const result = await extractExperienceFromTerminalState(
      cpbRoot, "proj", "j-pool", state, "pool_exhausted",
    );
    assert.equal(result, true);

    const expFile = path.join(cpbRoot, "wiki", "experience", "gotchas", "proj-j-pool-pool-exhausted-gotcha.md");
    const content = await readFile(expFile, "utf8");
    assert.ok(content.includes("category: gotcha"));
    assert.ok(content.includes("[GOTCHA]"));
  });
});

describe("index auto-rebuild on write", () => {
  it("rebuilds index.md after writing a new experience", async () => {
    await writeExperience(cpbRoot, {
      key: "auto-rebuild-test", slug: "auto-rebuild-test", category: "failure",
      severity: "high", project: "p", jobId: "j-auto", source: "v-auto",
      source_type: "verdict", source_artifact: null, confidence: null,
      date: "2026-06-02", tags: ["test"], title: "[FAIL] auto rebuild test",
      reason: "test", details: "", fix: "待补充", prevention: "待补充",
    });

    const index = await readFile(
      path.join(cpbRoot, "wiki", "experience", "index.md"),
      "utf8",
    );
    assert.ok(index.includes("auto rebuild test"));
  });
});

describe("idempotent write does not rebuild index", () => {
  it("skips index rebuild when file already exists", async () => {
    const exp = {
      key: "idem-test", slug: "idem-test", category: "gotcha",
      severity: "low", project: "p", jobId: "j-idem", source: "v",
      source_type: "verdict", source_artifact: null, confidence: null,
      date: "2026-06-02", tags: [], title: "[GOTCHA] idem",
      reason: "test", details: "", fix: "待补充", prevention: "待补充",
    };

    await writeExperience(cpbRoot, exp);

    // Get index content after first write
    const index1 = await readFile(
      path.join(cpbRoot, "wiki", "experience", "index.md"),
      "utf8",
    );

    // Second write should skip (returns false, no rebuild)
    const result = await writeExperience(cpbRoot, exp);
    assert.equal(result, false);

    // Index should be unchanged (no rebuild fired)
    const index2 = await readFile(
      path.join(cpbRoot, "wiki", "experience", "index.md"),
      "utf8",
    );
    assert.equal(index1, index2);
  });
});
