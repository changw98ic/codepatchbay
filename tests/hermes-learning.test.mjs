import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("performance-tracker", () => {
  let tmpDir;
  let cpbRoot;

  before(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-perf-test-"));
    cpbRoot = tmpDir;
  });

  after(async () => {
    try { await rm(tmpDir, { recursive: true }); } catch {}
  });

  it("recordPerformance writes to agent jsonl", async () => {
    const { recordPerformance } = await import("../server/services/performance-tracker.js");
    await recordPerformance(cpbRoot, "test-project", "job-001", {
      agent: "codex",
      role: "planner",
      phase: "plan",
      status: "completed",
      durationMs: 5000,
      ts: "2026-01-01T00:00:00Z",
    });

    const { readFile: rf } = await import("node:fs/promises");
    const data = await rf(path.join(tmpDir, "cpb-task", "performance", "codex.jsonl"), "utf8");
    const entry = JSON.parse(data.trim());
    assert.equal(entry.agent, undefined); // agent not in line, only in filename
    assert.equal(entry.project, "test-project");
    assert.equal(entry.phase, "plan");
    assert.equal(entry.status, "completed");
    assert.equal(entry.durationMs, 5000);
  });

  it("recordPerformance skips entry without agent or phase", async () => {
    const { recordPerformance } = await import("../server/services/performance-tracker.js");
    await recordPerformance(cpbRoot, "p", "j2", { agent: "", phase: "", status: "ok" });
    const { readdir: rd } = await import("node:fs/promises");
    const dir = path.join(tmpDir, "cpb-task", "performance");
    let entries;
    try { entries = await rd(dir); } catch { entries = []; }
    const codexFile = entries.find((e) => e === ".jsonl");
    assert.equal(codexFile, undefined);
  });

  it("getAgentPerformance returns aggregated metrics", async () => {
    const { recordPerformance, getAgentPerformance } = await import("../server/services/performance-tracker.js");

    const agentDir = path.join(tmpDir, "cpb-task", "performance");
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(agentDir, "test-agent.jsonl"), [
      JSON.stringify({ ts: "2026-01-01T00:00:00Z", project: "p", jobId: "j1", role: "executor", phase: "execute", status: "completed", durationMs: 3000 }),
      JSON.stringify({ ts: "2026-01-01T00:01:00Z", project: "p", jobId: "j2", role: "executor", phase: "execute", status: "failed", durationMs: 2000 }),
      JSON.stringify({ ts: "2026-01-01T00:02:00Z", project: "p", jobId: "j3", role: "executor", phase: "execute", status: "completed", durationMs: 4000 }),
    ].join("\n") + "\n", "utf8");

    const perf = await getAgentPerformance(cpbRoot, "test-agent");
    assert.equal(perf.agent, "test-agent");
    assert.equal(perf.totalRequests, 3);
    assert.equal(perf.totalErrors, 1);
    assert.equal(perf.avgDurationMs, 3000);
    assert.equal(perf.phases.execute.count, 3);
    assert.equal(perf.phases.execute.failures, 1);
  });

  it("getAgentPerformance returns empty for unknown agent", async () => {
    const { getAgentPerformance } = await import("../server/services/performance-tracker.js");
    const perf = await getAgentPerformance(cpbRoot, "nonexistent");
    assert.equal(perf.entries, 0);
    assert.equal(perf.avgDurationMs, null);
  });

  it("recordQualityScore writes quality event", async () => {
    const { recordQualityScore, getAgentQuality } = await import("../server/services/performance-tracker.js");
    await recordQualityScore(cpbRoot, "p", "j1", {
      agent: "claude",
      phase: "execute",
      verdict: "PASS",
      ts: "2026-01-01T00:00:00Z",
    });
    await recordQualityScore(cpbRoot, "p", "j2", {
      agent: "claude",
      phase: "execute",
      verdict: "FAIL",
      ts: "2026-01-01T00:01:00Z",
    });
    await recordQualityScore(cpbRoot, "p", "j3", {
      agent: "claude",
      phase: "execute",
      verdict: "PASS",
      ts: "2026-01-01T00:02:00Z",
    });

    const quality = await getAgentQuality(cpbRoot, "claude");
    assert.equal(quality.agent, "claude");
    assert.equal(quality.total, 3);
    assert.equal(quality.pass, 2);
    assert.equal(quality.fail, 1);
    assert.equal(quality.passRate, 67);
  });

  it("getAgentQuality returns empty for unknown agent", async () => {
    const { getAgentQuality } = await import("../server/services/performance-tracker.js");
    const q = await getAgentQuality(cpbRoot, "nobody");
    assert.equal(q.total, 0);
    assert.equal(q.passRate, null);
  });
});

describe("skill-extractor", () => {
  let tmpDir;
  let cpbRoot;

  before(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-skill-test-"));
    cpbRoot = tmpDir;
  });

  after(async () => {
    try { await rm(tmpDir, { recursive: true }); } catch {}
  });

  it("extractSkillFromJob creates DRAFT for PASS job", async () => {
    const { extractSkillFromJob } = await import("../server/services/skill-extractor.js");
    const result = await extractSkillFromJob(cpbRoot, "test-proj", "job-001", {
      status: "completed",
      verdict: "PASS",
      task: "Add dark mode toggle",
      completedPhases: ["plan", "execute", "verify"],
      artifacts: { plan: "plan-001.md", execute: "deliverable-001.md" },
    });

    assert.ok(result);
    assert.equal(result.status, "draft");
    assert.equal(result.isPositive, true);
    assert.equal(result.role, "executor");

    const content = await readFile(path.join(tmpDir, "profiles", "executor", "skills", `extracted-${result.fileName.split("/").pop() || result.fileName}`), "utf8").catch(() => null);
    // File should exist at skillsDir
    const { listExtractedSkills } = await import("../server/services/skill-extractor.js");
    const skills = await listExtractedSkills(cpbRoot, "executor");
    const target = skills.find((s) => s.jobId === "job-001");
    assert.ok(target);
    assert.equal(target.status, "draft");
    assert.equal(target.verdict, "PASS");
  });

  it("extractSkillFromJob creates anti-pattern for FAIL job", async () => {
    const { extractSkillFromJob, listExtractedSkills } = await import("../server/services/skill-extractor.js");
    const result = await extractSkillFromJob(cpbRoot, "p", "job-002", {
      status: "failed",
      verdict: "FAIL",
      task: "Fix auth bug",
      completedPhases: ["plan"],
      error: "timeout",
    });

    assert.ok(result);
    assert.equal(result.isAntiPattern, true);
    assert.equal(result.role, "planner");
  });

  it("extractSkillFromJob skips job without relevant verdict", async () => {
    const { extractSkillFromJob } = await import("../server/services/skill-extractor.js");
    const result = await extractSkillFromJob(cpbRoot, "p", "j3", {
      status: "running",
      completedPhases: ["plan"],
    });
    assert.equal(result, null);
  });

  it("reviewSkill promotes draft to active", async () => {
    const { extractSkillFromJob, reviewSkill, listExtractedSkills } = await import("../server/services/skill-extractor.js");

    await extractSkillFromJob(cpbRoot, "p", "j-review", {
      status: "completed",
      verdict: "PASS",
      task: "Refactor utils",
      completedPhases: ["plan", "execute", "verify"],
    });

    const skills = await listExtractedSkills(cpbRoot, "executor");
    const target = skills.find((s) => s.jobId === "j-review");
    assert.ok(target);

    const reviewed = await reviewSkill(cpbRoot, "executor", target.fileName, {
      approve: true,
      reviewer: "human",
    });

    assert.ok(reviewed);
    assert.equal(reviewed.status, "active");

    const updated = await listExtractedSkills(cpbRoot, "executor");
    const updatedTarget = updated.find((s) => s.fileName === target.fileName);
    assert.equal(updatedTarget.status, "active");
  });

  it("reviewSkill rejects draft", async () => {
    const { extractSkillFromJob, reviewSkill, listExtractedSkills } = await import("../server/services/skill-extractor.js");

    await extractSkillFromJob(cpbRoot, "p", "j-reject", {
      status: "completed",
      verdict: "PASS",
      task: "Bad pattern example",
      completedPhases: ["plan", "execute", "verify"],
    });

    const skills = await listExtractedSkills(cpbRoot, "executor");
    const target = skills.find((s) => s.jobId === "j-reject");
    assert.ok(target);

    const reviewed = await reviewSkill(cpbRoot, "executor", target.fileName, {
      approve: false,
      reviewer: "human",
    });

    assert.equal(reviewed.status, "rejected");
  });

  it("loadActiveExtractedSkills returns only active skills", async () => {
    const { loadActiveExtractedSkills, extractSkillFromJob, reviewSkill, listExtractedSkills } = await import("../server/services/skill-extractor.js");

    const active = await loadActiveExtractedSkills(cpbRoot, "executor");
    for (const s of active) {
      assert.equal(s.status, "active");
    }
  });

  it("listExtractedSkills returns empty for unknown role", async () => {
    const { listExtractedSkills } = await import("../server/services/skill-extractor.js");
    const skills = await listExtractedSkills(cpbRoot, "nonexistent");
    assert.deepEqual(skills, []);
  });

  it("reviewSkill returns null for missing file", async () => {
    const { reviewSkill } = await import("../server/services/skill-extractor.js");
    const result = await reviewSkill(cpbRoot, "executor", "no-such-file.md", { approve: true });
    assert.equal(result, null);
  });
});
