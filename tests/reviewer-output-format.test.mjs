import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildReviewerReviewPrompt } from "../server/services/prompt-builder.js";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function tempDir(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

test("buildReviewerReviewPrompt includes structured review contract", async () => {
  const tmpRoot = await tempDir("cpb-reviewer-prompt-");
  const project = "test-proj";
  const deliverableId = "001";
  const wikiDir = path.join(tmpRoot, "wiki", "projects", project);
  const inboxDir = path.join(wikiDir, "inbox");
  const outputsDir = path.join(wikiDir, "outputs");

  try {
    await mkdir(inboxDir, { recursive: true });
    await mkdir(outputsDir, { recursive: true });
    await writeFile(
      path.join(inboxDir, `plan-${deliverableId}.md`),
      "# Plan\n\nTest plan.\n",
      "utf8",
    );
    await writeFile(
      path.join(outputsDir, `deliverable-${deliverableId}.md`),
      "# Deliverable\n\nTest deliverable.\n",
      "utf8",
    );

    const prompt = await buildReviewerReviewPrompt(repoRoot, tmpRoot, project, deliverableId);

    assert.ok(prompt.includes("## Blocking Findings"), "prompt must include Blocking Findings section");
    assert.ok(prompt.includes("## Non-Blocking Findings"), "prompt must include Non-Blocking Findings section");
    assert.ok(prompt.includes("## Verdict"), "prompt must include Verdict section at the top");
    assert.ok(prompt.includes("REVIEW: <PASS|FAIL>"), "prompt must include machine-parseable verdict line");
    assert.ok(
      prompt.includes("Blocking findings are must-fix issues"),
      "prompt must define what blocking means",
    );
    assert.ok(
      prompt.includes("Non-blocking findings are minor readability"),
      "prompt must define what non-blocking means",
    );
    assert.ok(
      prompt.includes("If any blocking finding exists, REVIEW: FAIL is required"),
      "prompt must require FAIL when blocking findings exist",
    );
    assert.ok(
      prompt.includes('If Blocking Findings is empty (write "None."), REVIEW: PASS is required'),
      "prompt must require PASS only when blocking is None",
    );
    assert.ok(
      prompt.includes("- **Evidence**: what proves this is a problem"),
      "prompt must include evidence field in per-finding template",
    );
    assert.ok(
      prompt.includes("Critical and Major issues normally belong in Blocking Findings"),
      "prompt must map severity to blocking",
    );
    assert.ok(
      prompt.includes("Minor and Suggestion issues belong in Non-Blocking Findings"),
      "prompt must map severity to non-blocking",
    );
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("local-smoke fake ACP review artifact uses structured format", async () => {
  const smokeSource = await readFile(path.join(repoRoot, "bridges", "local-smoke.mjs"), "utf8");

  assert.ok(smokeSource.includes("## Verdict"), "fake review must include Verdict section");
  assert.ok(smokeSource.includes("REVIEW: PASS"), "fake review must include REVIEW: PASS");
  assert.ok(
    smokeSource.includes("## Blocking Findings"),
    "fake review must include Blocking Findings section",
  );
  assert.ok(
    smokeSource.includes("## Non-Blocking Findings"),
    "fake review must include Non-Blocking Findings section",
  );
  assert.ok(
    smokeSource.includes("## Summary"),
    "fake review must include Summary section",
  );
});
