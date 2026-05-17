import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";

import { gatherDiagnostics, redactSecrets } from "../server/services/diagnostics-bundle.js";

let tmpDir;
let cpbRoot;
let hubRoot;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join("/tmp", "cpb-diag-test-"));
  cpbRoot = path.join(tmpDir, "cpb");
  hubRoot = path.join(tmpDir, "hub");
  await fs.mkdir(cpbRoot, { recursive: true });
  await fs.mkdir(hubRoot, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("gatherDiagnostics returns structured snapshot with no secrets", async () => {
  await fs.mkdir(path.join(hubRoot, "providers"), { recursive: true });
  await fs.writeFile(
    path.join(hubRoot, "providers", "rate-limits.json"),
    JSON.stringify({
      codex: {
        agent: "codex",
        untilTs: "2026-05-17T10:00:00.000Z",
        reason: "api_key=sk-secret123 Bearer tok_abc",
      },
    }),
    "utf8",
  );

  const diag = await gatherDiagnostics({ cpbRoot, hubRoot });

  assert.ok(diag.gatheredAt);
  assert.equal(diag.cpbRoot, path.resolve(cpbRoot));
  assert.equal(typeof diag.hub.projectCount, "number");
  assert.equal(typeof diag.queue.total, "number");
  assert.ok(Array.isArray(diag.projectIds));
  assert.ok(diag.knowledgePolicy);
  assert.ok(Array.isArray(diag.recentJobs));

  // Secrets must be redacted in rate limit reason
  const reason = diag.acp?.rateLimits?.codex?.reason || "";
  assert.ok(!reason.includes("sk-secret123"), "api key must be redacted");
  assert.ok(!reason.includes("tok_abc"), "bearer token must be redacted");
  assert.ok(reason.includes("[REDACTED]"));
});

test("gatherDiagnostics gracefully handles missing data", async () => {
  const diag = await gatherDiagnostics({ cpbRoot, hubRoot });
  assert.equal(diag.hub.projectCount, 0);
  assert.equal(diag.queue.total, 0);
  assert.ok(Array.isArray(diag.recentJobs));
});

test("redactSecrets strips tokens from nested objects", () => {
  const input = {
    message: "Bearer abc123 and api_token=xyz789",
    nested: [{ reason: "rejected: secret=s3cret and password=p4ss" }],
    safe: "normal text",
  };
  const result = redactSecrets(input);
  assert.ok(!JSON.stringify(result).includes("abc123"));
  assert.ok(!JSON.stringify(result).includes("xyz789"));
  assert.ok(!JSON.stringify(result).includes("s3cret"));
  assert.ok(!JSON.stringify(result).includes("p4ss"));
  assert.equal(result.safe, "normal text");
});

test("redactSecrets preserves sourcePath", () => {
  const input = { sourcePath: "/repos/my-project" };
  const result = redactSecrets(input);
  assert.equal(result.sourcePath, "/repos/my-project");
});

test("gatherDiagnostics includes knowledge policy summary", async () => {
  const diag = await gatherDiagnostics({ cpbRoot, hubRoot });
  assert.ok(diag.knowledgePolicy.promptCompositionOrder);
  assert.ok(diag.knowledgePolicy.forbiddenMarkdownState.includes("queue"));
  assert.ok(diag.knowledgePolicy.automaticWrites.includes("session-memory"));
});
