import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { runVerify } from "../core/phases/verify.js";
import { recordValue } from "../shared/types.js";
import { tempRoot } from "./helpers.js";

const execFileAsync = promisify(execFile);

async function sourceFixture({ withFocusedTest }: { withFocusedTest: boolean }) {
  const sourcePath = await tempRoot("cpb-deterministic-light-source");
  await mkdir(path.join(sourcePath, "src"), { recursive: true });
  await writeFile(path.join(sourcePath, "src", "feature.js"), "export const value = 1;\n", "utf8");
  await writeFile(path.join(sourcePath, "package.json"), JSON.stringify({ type: "module" }), "utf8");
  if (withFocusedTest) {
    await mkdir(path.join(sourcePath, "test"), { recursive: true });
    await writeFile(
      path.join(sourcePath, "test", "feature.test.js"),
      "import assert from 'node:assert/strict'; import test from 'node:test'; import { value } from '../src/feature.js'; test('value', () => assert.equal(value, 2));\n",
      "utf8",
    );
  }
  await execFileAsync("git", ["init", "-q"], { cwd: sourcePath });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: sourcePath });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: sourcePath });
  await execFileAsync("git", ["add", "-A"], { cwd: sourcePath });
  await execFileAsync("git", ["commit", "-q", "-m", "initial fixture"], { cwd: sourcePath });
  await writeFile(path.join(sourcePath, "src", "feature.js"), "export const value = 2;\n", "utf8");
  return sourcePath;
}

async function fullTestFixture() {
  const sourcePath = await tempRoot("cpb-verify-full-env-source");
  await writeFile(path.join(sourcePath, "package.json"), JSON.stringify({
    type: "module",
    scripts: {
      test: "node -e \"if (process.env.CPB_VERIFY_FULL) process.exit(11); if (process.env.CPB_AMBIENT_SECRET) process.exit(12); process.exit(process.env.CPB_CODEGRAPH_ENABLED === 'job-env' ? 7 : 0)\"",
    },
  }), "utf8");
  await writeFile(path.join(sourcePath, "feature.js"), "export const value = 1;\n", "utf8");
  await execFileAsync("git", ["init", "-q"], { cwd: sourcePath });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: sourcePath });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: sourcePath });
  await execFileAsync("git", ["add", "-A"], { cwd: sourcePath });
  await execFileAsync("git", ["commit", "-q", "-m", "initial fixture"], { cwd: sourcePath });
  await writeFile(path.join(sourcePath, "feature.js"), "export const value = 2;\n", "utf8");
  return sourcePath;
}

function checklist() {
  return {
    schemaVersion: 1,
    jobId: "job-light",
    project: "flow",
    status: "frozen",
    source: { task: "change value", issue: null, documents: [] },
    items: [{
      id: "AC-001",
      requirement: "Feature value is updated",
      source: "task_text",
      sourceRefs: [{ kind: "task_text", locator: "task:0", sha256: null }],
      predicateId: "feature-value",
      required: true,
      area: "core",
      risk: "medium",
      verificationMethod: "static",
      expectedEvidence: "src/feature.js changed",
      dependsOn: [],
      allowedFiles: ["src/feature.js"],
    }],
    assumptions: [],
  };
}

test("verify hard gates use ctx.env for full-test decisions and child env over ambient env", async () => {
  const cpbRoot = await tempRoot("cpb-verify-full-env");
  const sourcePath = await fullTestFixture();
  const result = await runVerify({
    cpbRoot,
    dataRoot: path.join(cpbRoot, "runtime"),
    project: "flow",
    jobId: "job-full-env",
    task: "Verify full-test env isolation",
    sourcePath,
    workflow: "standard",
    planMode: "light",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      CPB_VERIFY_FULL: "1",
      CPB_CODEGRAPH_ENABLED: "job-env",
    },
    pool: {
      async execute() {
        throw new Error("full-test hard gate must fail before verifier agent execution");
      },
    },
    previousResults: [],
  });

  assert.equal(result.status, "failed");
  assert.match(String(result.failure?.reason), /npm test failed/);
  const diagnostics = recordValue(result.diagnostics);
  const hardGate = recordValue(diagnostics.hardGate);
  const npmGate = (Array.isArray(hardGate.checks) ? hardGate.checks : [])
    .map(recordValue)
    .find((entry) => entry.gate === "npm test");
  assert.equal(npmGate?.ok, false);
  assert.equal(npmGate?.exitCode, "7");
});

test("light verification uses deterministic evidence when a focused test actually ran", async () => {
  const cpbRoot = await tempRoot("cpb-deterministic-light");
  const dataRoot = path.join(cpbRoot, "runtime");
  const sourcePath = await sourceFixture({ withFocusedTest: true });
  let verifierCalls = 0;
  const result = await runVerify({
    cpbRoot,
    dataRoot,
    project: "flow",
    jobId: "job-light",
    task: "Change feature value to 2",
    sourcePath,
    workflow: "standard",
    planMode: "light",
    sourceContext: {
      riskMap: { riskLevel: "medium", adversarialRequired: false },
      acceptanceChecklist: checklist(),
      acceptanceChecklistArtifact: { name: "acceptance-checklist-light" },
    },
    pool: {
      async execute() {
        verifierCalls += 1;
        throw new Error("deterministic light verification must not call a verifier agent");
      },
    },
    previousResults: [],
  });

  assert.equal(result.status, "passed", String(result.failure?.reason || ""));
  assert.equal(verifierCalls, 0);
  const diagnostics = recordValue(result.diagnostics);
  assert.equal(diagnostics.verificationMode, "deterministic_light");
  const evidenceEntry = recordValue(diagnostics.evidenceLedgerArtifact);
  const verdictEntry = recordValue(diagnostics.checklistVerdictArtifact);
  assert.ok(evidenceEntry?.path);
  assert.ok(verdictEntry?.path);
  const evidence = JSON.parse(await readFile(evidenceEntry.path, "utf8"));
  const verdict = JSON.parse(await readFile(verdictEntry.path, "utf8"));
  assert.equal(evidence.evidence[0].result, "pass");
  assert.equal(verdict.status, "pass");
});

test("light verification keeps the verifier agent when no focused test ran", async () => {
  const cpbRoot = await tempRoot("cpb-light-no-focused-test");
  const sourcePath = await sourceFixture({ withFocusedTest: false });
  let verifierCalls = 0;
  let verifierPrompt = "";
  const result = await runVerify({
    cpbRoot,
    dataRoot: path.join(cpbRoot, "runtime"),
    project: "flow",
    jobId: "job-light",
    task: "Change feature value to 2",
    sourcePath,
    workflow: "standard",
    planMode: "light",
    agents: { verifier: "claude-glm" },
    sourceContext: {
      riskMap: { riskLevel: "medium", adversarialRequired: false },
      acceptanceChecklist: checklist(),
      acceptanceChecklistArtifact: { name: "acceptance-checklist-light" },
    },
    pool: {
      async execute(_agent: unknown, prompt: unknown) {
        verifierCalls += 1;
        verifierPrompt = String(prompt || "");
        return {
          output: "```json\n{\"status\":\"ok\",\"verdict\":\"pass\",\"reason\":\"manual semantic review\",\"details\":\"checked\",\"confidence\":0.9}\n```",
          providerKey: "fake",
          variant: null,
        };
      },
    },
    previousResults: [],
  });

  assert.equal(verifierCalls, 1);
  assert.doesNotMatch(verifierPrompt, /VERIFIER_JSON_OUTPUT_FILE=/);
  assert.equal(result.status, "passed", String(result.failure?.reason || ""));
  const diagnostics = recordValue(result.diagnostics);
  assert.notEqual(diagnostics.verificationMode, "deterministic_light");
});
