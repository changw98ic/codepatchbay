#!/usr/bin/env node

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { bridgeForPhase } from "../../server/services/supervisor.js";
import { collectVerifierEvidence } from "../../server/services/review/review-dispatch.js";
import { createJob, startPhase, completePhase } from "../../server/services/job/job-store.js";
import { wikiProjectDir, outputsDir, contextPath } from "../../server/services/phase-locator.js";
import { parseVerdict } from "../../bridges/run-pipeline.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(".");

async function setupFixture(prefix = "cpb-verify-indep-") {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const cpbRoot = path.join(root, "cpb");
  const project = "testproj";
  const wikiDir = path.join(cpbRoot, "wiki", "projects", project);

  await mkdir(path.join(wikiDir, "inbox"), { recursive: true });
  await mkdir(path.join(wikiDir, "outputs"), { recursive: true });
  await mkdir(path.join(cpbRoot, "wiki", "system"), { recursive: true });
  await writeFile(path.join(cpbRoot, "wiki", "system", "dashboard.md"), "# Dashboard\n## 活跃项目\n", "utf8");
  await writeFile(path.join(wikiDir, "project.json"), JSON.stringify({ sourcePath: null }, null, 2), "utf8");
  await writeFile(path.join(wikiDir, "context.md"), "# Test Context\n", "utf8");
  await writeFile(path.join(wikiDir, "decisions.md"), "# Test Decisions\n", "utf8");

  return { root, cpbRoot, project, wikiDir };
}

describe("verifier independence from deliverable artifacts", () => {
  it("bridgeForPhase falls back to --job-id when execute has no artifact", () => {
    const result = bridgeForPhase("verify", "myapp", {
      jobId: "job-20260520-000000-abc123",
      artifacts: {},
    });
    assert.deepEqual(result, {
      script: path.join("bridges", "verifier.sh"),
      args: ["myapp", "--job-id", "job-20260520-000000-abc123"],
    });
  });

  it("bridgeForPhase uses deliverable when execute artifact exists", () => {
    const result = bridgeForPhase("verify", "myapp", {
      jobId: "job-20260520-000000-abc123",
      artifacts: { execute: "deliverable-001" },
    });
    assert.deepEqual(result, {
      script: path.join("bridges", "verifier.sh"),
      args: ["myapp", "001"],
    });
  });

  it("verifier.sh --job-id routes to rtk_verifier_job prompt", async () => {
    const fixture = await setupFixture();
    try {
      const { stdout } = await execFileAsync(
        "bash",
        [
          "-c",
          [
            "source bridges/common.sh",
            "rtk_verifier_job testproj job-20260520-120000-feedbe /tmp/verdict.md",
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

      assert.match(stdout, /Job ID: job-20260520-120000-feedbe/);
      assert.match(stdout, /executor deliverables are optional audit context/i);
      assert.match(stdout, /If data is missing, return a diagnostic verdict/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("verifier.sh --job-id produces verdict path based on jobId, not deliverable", async () => {
    const fixture = await setupFixture();
    const jobId = "job-20260520-120000-feedbe";
    const expectedVerdict = path.join(fixture.wikiDir, "outputs", `verdict-${jobId}.md`);
    const stub = path.join(fixture.root, "acp-stub.sh");

    try {
      // Stub ACP client that writes a verdict file
      await writeFile(
        stub,
        [
          "#!/usr/bin/env bash",
          "cat >/dev/null",
          `echo "VERDICT: PASS" > "${expectedVerdict}"`,
          "exit 0",
        ].join("\n"),
        "utf8",
      );
      await chmod(stub, 0o755);

      const { stdout } = await execFileAsync(
        "bash",
        ["bridges/verifier.sh", "testproj", "--job-id", jobId],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            CPB_ROOT: fixture.cpbRoot,
            CPB_EXECUTOR_ROOT: repoRoot,
            CPB_ACP_CLIENT: stub,
          },
        },
      );

      assert.match(stdout, new RegExp(`verdict-${jobId}.md`));
      assert.ok(
        !stdout.includes("deliverable-"),
        "output should not reference deliverable id"
      );

      const verdict = await readFile(expectedVerdict, "utf8");
      assert.match(verdict, /^VERDICT:\s*PASS/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("verifier.sh --job-id does not require deliverable file to exist", async () => {
    const fixture = await setupFixture();
    const jobId = "job-20260520-120000-feedbe";
    const expectedVerdict = path.join(fixture.wikiDir, "outputs", `verdict-${jobId}.md`);
    const stub = path.join(fixture.root, "acp-stub.sh");

    try {
      // No deliverable file created — verifier should still run
      await writeFile(
        stub,
        [
          "#!/usr/bin/env bash",
          "cat >/dev/null",
          `echo "VERDICT: PARTIAL" > "${expectedVerdict}"`,
          "exit 0",
        ].join("\n"),
        "utf8",
      );
      await chmod(stub, 0o755);

      const { stdout } = await execFileAsync(
        "bash",
        ["bridges/verifier.sh", "testproj", "--job-id", jobId],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            CPB_ROOT: fixture.cpbRoot,
            CPB_EXECUTOR_ROOT: repoRoot,
            CPB_ACP_CLIENT: stub,
          },
        },
      );

      assert.match(stdout, /Verifying.*job-20260520-120000-feedbe/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("collectVerifierEvidence produces diagnostics, not crash, when deliverable is absent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cpb-verify-nodeliver-"));
    const project = "evidence-test";
    const wikiDir = wikiProjectDir(root, project);

    try {
      await mkdir(path.join(wikiDir, "inbox"), { recursive: true });
      await mkdir(path.join(wikiDir, "outputs"), { recursive: true });
      await writeFile(
        path.join(wikiDir, "project.json"),
        JSON.stringify({ name: project, sourcePath: null }, null, 2),
        "utf8",
      );
      await writeFile(contextPath(root, project), "# Context\n", "utf8");

      const job = await createJob(root, {
        project,
        task: "Test without deliverable",
        ts: "2026-05-20T00:00:00.000Z",
      });

      await startPhase(root, project, job.jobId, { phase: "execute", attempt: 1, ts: "2026-05-20T00:01:00.000Z" });
      await completePhase(root, project, job.jobId, { phase: "execute", artifact: "", ts: "2026-05-20T00:05:00.000Z" });

      const evidence = await collectVerifierEvidence(root, project, job.jobId);

      assert.ok(evidence.jobState, "job state should be available");
      assert.equal(evidence.jobState.jobId, job.jobId);
      assert.equal(evidence.deliverable?.available, false, "deliverable should be unavailable");
      assert.ok(evidence.eventLog?.available, "event log should be available");
      assert.ok(evidence.projectContext?.available, "project context should be available");

      const missingDeliverableDiag = evidence.diagnostics.find(
        (d) => d.message.includes("deliverable not available"),
      );
      assert.ok(missingDeliverableDiag, "should diagnose missing deliverable");
      assert.equal(missingDeliverableDiag.level, "info", "missing deliverable is info-level diagnostic");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("verdict path is deterministic from jobId alone", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cpb-verdict-path-"));
    try {
      const jobId = "job-20260520-123456-cafe00";
      const verdictContent = "VERDICT: FAIL\nNo deliverable, inspected current diff and test output.\n";
      const verdictPath = path.join(root, `verdict-${jobId}.md`);
      await writeFile(verdictPath, verdictContent, "utf8");

      const parsed = await parseVerdict(verdictPath);
      assert.equal(parsed, "FAIL");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("run-pipeline verifies by job id when execute produces no deliverable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cpb-pipeline-job-verify-"));
    const cpbRoot = path.join(root, "cpb");
    const sourcePath = path.join(root, "source");
    const stub = path.join(root, "acp-stub.sh");
    const project = "pipeline-job-verify";

    try {
      await mkdir(sourcePath, { recursive: true });
      await mkdir(path.join(cpbRoot, "wiki", "system"), { recursive: true });
      await writeFile(path.join(cpbRoot, "wiki", "system", "dashboard.md"), "# Dashboard\n", "utf8");
      await writeFile(
        stub,
        `#!/usr/bin/env bash
set -euo pipefail
agent=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --agent) agent="$2"; shift 2 ;;
    --cwd) shift 2 ;;
    *) shift ;;
  esac
done
prompt="$(cat)"
output_file="$(printf '%s\\n' "$prompt" | sed -n -E 's/^([0-9]+\\. )?Write the (plan|deliverable|verdict) to: (.*)$/\\3/p' | tail -1)"
mkdir -p "$(dirname "$output_file")"
case "$agent" in
  codex)
    if printf '%s\\n' "$prompt" | grep -q "Job ID:"; then
      printf 'VERDICT: PASS\\nVerified current job state without executor deliverable.\\n' > "$output_file"
    else
      printf '# Plan: verifier independence regression\\n\\nTask: verifier independence regression\\n\\nAcceptance-Criteria:\\n- verifier runs by job id when execute has no deliverable\\n' > "$output_file"
    fi
    ;;
  claude)
    # Intentionally produce no deliverable: this is the regression path.
    rm -f "$output_file"
    ;;
  *)
    echo "unexpected agent: $agent" >&2
    exit 1
    ;;
esac
`,
        "utf8",
      );
      await chmod(stub, 0o755);

      await execFileAsync(process.execPath, [
        "bridges/run-pipeline.js",
        "--project", project,
        "--task", "verifier independence regression",
        "--source-path", sourcePath,
        "--max-retries", "1",
      ], {
        cwd: repoRoot,
        env: {
          ...process.env,
          CPB_ROOT: cpbRoot,
          CPB_ACP_CLIENT: stub,
          CPB_WORKER_DISPATCH_ENABLED: "0",
        },
      });

      const outputs = await readdir(path.join(cpbRoot, "wiki", "projects", project, "outputs"));
      assert.equal(outputs.some((name) => name.startsWith("deliverable-")), false);
      const verdictFile = outputs.find((name) => /^verdict-job-/.test(name));
      assert.ok(verdictFile, "pipeline should write verdict keyed by job id");

      const [eventFileName] = await readdir(path.join(cpbRoot, "cpb-task", "events", project));
      const events = (await readFile(path.join(cpbRoot, "cpb-task", "events", project, eventFileName), "utf8"))
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line));
      assert.ok(events.some((event) => event.type === "phase_completed" && event.phase === "execute" && event.artifact === ""));
      assert.ok(events.some((event) => event.type === "phase_completed" && event.phase === "verify" && event.artifact?.startsWith("verdict-job-")));
      assert.ok(events.some((event) => event.type === "job_completed"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
