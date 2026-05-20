#!/usr/bin/env node

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { parseVerdict } from "../bridges/run-pipeline.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(".");

async function setupVerifyFixture(prefix = "cpb-verify-locator-") {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const cpbRoot = path.join(root, "cpb");
  const project = "testproj";
  const wikiDir = path.join(cpbRoot, "wiki", "projects", project);
  const sourcePath = path.join(root, "source");

  await mkdir(path.join(wikiDir, "inbox"), { recursive: true });
  await mkdir(path.join(wikiDir, "outputs"), { recursive: true });
  await mkdir(path.join(cpbRoot, "wiki", "system"), { recursive: true });
  await mkdir(sourcePath, { recursive: true });

  await writeFile(path.join(wikiDir, "project.json"), JSON.stringify({ sourcePath }, null, 2), "utf8");
  await writeFile(path.join(wikiDir, "context.md"), "UNIQUE_CONTEXT_BODY_SHOULD_NOT_BE_EMBEDDED\n", "utf8");
  await writeFile(path.join(wikiDir, "decisions.md"), "UNIQUE_DECISIONS_BODY_SHOULD_NOT_BE_EMBEDDED\n", "utf8");
  await writeFile(path.join(wikiDir, "inbox", "plan-001.md"), "UNIQUE_PLAN_BODY_SHOULD_NOT_BE_EMBEDDED\n", "utf8");
  await writeFile(
    path.join(wikiDir, "outputs", "deliverable-001.md"),
    "plan-ref: 001\nUNIQUE_DELIVERABLE_BODY_SHOULD_NOT_BE_EMBEDDED\n",
    "utf8",
  );

  return { root, cpbRoot, project, wikiDir };
}

describe("prompt locator contract and verdict parsing", () => {
  it("rtk_verifier passes deliverable and project locators without embedding upstream bodies", async () => {
    const fixture = await setupVerifyFixture();
    try {
      const { stdout } = await execFileAsync(
        "bash",
        [
          "-c",
          [
            "source bridges/common.sh",
            "rtk_verifier testproj 001 /tmp/verdict.md",
          ].join(" && "),
        ],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            CPB_ROOT: fixture.cpbRoot,
            CPB_EXECUTOR_ROOT: repoRoot,
            CPB_DANGEROUS: "1",
          },
        },
      );

      assert.match(stdout, new RegExp(`Deliverable file: ${path.join(fixture.wikiDir, "outputs", "deliverable-001.md")}`));
      assert.match(stdout, new RegExp(`Plans directory: ${path.join(fixture.wikiDir, "inbox")}`));
      assert.doesNotMatch(stdout, /UNIQUE_CONTEXT_BODY_SHOULD_NOT_BE_EMBEDDED/);
      assert.doesNotMatch(stdout, /UNIQUE_DECISIONS_BODY_SHOULD_NOT_BE_EMBEDDED/);
      assert.doesNotMatch(stdout, /UNIQUE_PLAN_BODY_SHOULD_NOT_BE_EMBEDDED/);
      assert.doesNotMatch(stdout, /UNIQUE_DELIVERABLE_BODY_SHOULD_NOT_BE_EMBEDDED/);
      assert.doesNotMatch(stdout, /Diff Artifact|Verification Snapshot|artifact_stale/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rtk_verifier rejects legacy diff and manifest arguments instead of ignoring them", async () => {
    const fixture = await setupVerifyFixture();
    try {
      await assert.rejects(
        execFileAsync(
          "bash",
          [
            "-c",
            [
              "source bridges/common.sh",
              "rtk_verifier testproj 001 /tmp/verdict.md /tmp/diff.patch /tmp/manifest.json",
            ].join(" && "),
          ],
          {
            cwd: repoRoot,
            env: {
              ...process.env,
              CPB_ROOT: fixture.cpbRoot,
              CPB_EXECUTOR_ROOT: repoRoot,
              CPB_DANGEROUS: "1",
            },
          },
        ),
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rtk_verifier_job uses job/event locators without requiring deliverable content", async () => {
    const fixture = await setupVerifyFixture();
    try {
      const { stdout } = await execFileAsync(
        "bash",
        [
          "-c",
          [
            "source bridges/common.sh",
            "rtk_verifier_job testproj job-20260520-000000-deadbe /tmp/verdict.md",
          ].join(" && "),
        ],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            CPB_ROOT: fixture.cpbRoot,
            CPB_EXECUTOR_ROOT: repoRoot,
            CPB_DANGEROUS: "1",
          },
        },
      );

      assert.match(stdout, new RegExp(`Event log: ${path.join(fixture.cpbRoot, "cpb-task", "events", "testproj", "job-20260520-000000-deadbe.jsonl")}`));
      assert.match(stdout, /executor deliverables are optional audit context/i);
      assert.doesNotMatch(stdout, /UNIQUE_DELIVERABLE_BODY_SHOULD_NOT_BE_EMBEDDED/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("verifier.sh rejects legacy diff and manifest arguments at the CLI boundary", async () => {
    const fixture = await setupVerifyFixture();
    const stub = path.join(fixture.root, "acp-stub.sh");
    try {
      await writeFile(stub, "#!/usr/bin/env bash\ncat >/dev/null\nexit 0\n", "utf8");
      await chmod(stub, 0o755);

      await assert.rejects(
        execFileAsync(
          "bash",
          ["bridges/verifier.sh", "testproj", "001", "/tmp/diff.patch", "/tmp/manifest.json"],
          {
            cwd: repoRoot,
            env: {
              ...process.env,
              CPB_ROOT: fixture.cpbRoot,
              CPB_EXECUTOR_ROOT: repoRoot,
              CPB_ACP_CLIENT: stub,
            },
          },
        ),
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("parseVerdict treats artifact_stale text as an ordinary verifier failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cpb-artifact-stale-verdict-"));
    try {
      const verdictPath = path.join(root, "verdict-001.md");
      await writeFile(verdictPath, "VERDICT: FAIL\nReason: artifact_stale was reported.\n", "utf8");
      assert.equal(await parseVerdict(verdictPath), "FAIL");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
