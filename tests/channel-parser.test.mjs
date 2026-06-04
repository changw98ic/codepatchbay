import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseChannelCommand,
  tokenizeChannelCommand,
  CHANNEL_COMMAND_HELP,
} from "../server/services/channel-commands.js";

// --- tokenizeChannelCommand ---

test("tokenizeChannelCommand handles basic tokens", () => {
  assert.deepEqual(tokenizeChannelCommand("hello world"), ["hello", "world"]);
});

test("tokenizeChannelCommand respects double quotes", () => {
  assert.deepEqual(tokenizeChannelCommand('run proj "add dark mode"'), [
    "run",
    "proj",
    "add dark mode",
  ]);
});

test("tokenizeChannelCommand respects single quotes", () => {
  assert.deepEqual(tokenizeChannelCommand("run proj 'fix the bug'"), [
    "run",
    "proj",
    "fix the bug",
  ]);
});

test("tokenizeChannelCommand handles escapes", () => {
  assert.deepEqual(tokenizeChannelCommand('run proj "say \\"hello\\""'), [
    "run",
    "proj",
    'say "hello"',
  ]);
});

test("tokenizeChannelCommand handles empty input", () => {
  assert.deepEqual(tokenizeChannelCommand(""), []);
  assert.deepEqual(tokenizeChannelCommand(null), []);
  assert.deepEqual(tokenizeChannelCommand(undefined), []);
});

test("tokenizeChannelCommand handles trailing backslash", () => {
  const tokens = tokenizeChannelCommand("hello\\");
  assert.deepEqual(tokens, ["hello\\"]);
});

test("tokenizeChannelCommand handles extra whitespace", () => {
  assert.deepEqual(tokenizeChannelCommand("  run   proj   task  "), [
    "run",
    "proj",
    "task",
  ]);
});

// --- parseChannelCommand: /cpb run ---

test("parseChannelCommand parses /cpb run with project and task", () => {
  const result = parseChannelCommand('/cpb run my-project "add dark mode"');
  assert.equal(result.ok, true);
  assert.equal(result.type, "run");
  assert.equal(result.command, "run");
  assert.equal(result.project, "my-project");
  assert.equal(result.task, "add dark mode");
  assert.equal(result.workflow, null);
  assert.equal(result.planMode, null);
  assert.equal(result.triage, null);
});

test("workflow is null when not explicitly supplied", () => {
  const result = parseChannelCommand('/cpb run proj "simple task"');
  assert.equal(result.ok, true);
  assert.equal(result.workflow, null);
  assert.equal(result.workflowRequested, false);
});

test("parseChannelCommand parses /cpb run with workflow option", () => {
  const result = parseChannelCommand(
    '/cpb run my-project "fix bug" --workflow full'
  );
  assert.equal(result.ok, true);
  assert.equal(result.workflow, "full");
  assert.equal(result.workflowRequested, true);
});

test("parseChannelCommand parses /cpb run with plan-mode option", () => {
  const result = parseChannelCommand(
    '/cpb run my-project "fix bug" --plan-mode light'
  );
  assert.equal(result.ok, true);
  assert.equal(result.planMode, "light");
  assert.equal(result.planModeRequested, true);
});

test("parseChannelCommand parses /cpb run with triage option", () => {
  const result = parseChannelCommand(
    '/cpb run my-project "fix bug" --triage rules'
  );
  assert.equal(result.ok, true);
  assert.equal(result.triage, "rules");
  assert.equal(result.triageRequested, true);
});

test("parseChannelCommand parses /cpb run with --triage (flag-only, defaults to auto)", () => {
  const result = parseChannelCommand(
    '/cpb run my-project "fix bug" --triage'
  );
  assert.equal(result.ok, true);
  assert.equal(result.triage, "auto");
});

test("parseChannelCommand parses /cpb run with --no-triage", () => {
  const result = parseChannelCommand(
    '/cpb run my-project "fix bug" --no-triage'
  );
  assert.equal(result.ok, true);
  assert.equal(result.triage, "none");
});

test("parseChannelCommand parses /cpb run with --workflow=short", () => {
  const result = parseChannelCommand(
    '/cpb run my-project "fix bug" --workflow=short'
  );
  assert.equal(result.ok, true);
  assert.equal(result.workflow, "short");
});

test("parseChannelCommand parses /cpb run with -w shorthand", () => {
  const result = parseChannelCommand(
    '/cpb run my-project "fix bug" -w full'
  );
  assert.equal(result.ok, true);
  assert.equal(result.workflow, "full");
});

test("parseChannelCommand rejects /cpb run without project", () => {
  const result = parseChannelCommand('/cpb run "just a task"');
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_COMMAND");
});

test("parseChannelCommand rejects /cpb run without task", () => {
  const result = parseChannelCommand("/cpb run my-project");
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_COMMAND");
});

test("parseChannelCommand rejects /cpb run with invalid project name", () => {
  const result = parseChannelCommand('/cpb run bad_name "task"');
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_COMMAND");
});

test("parseChannelCommand rejects /cpb run with missing --workflow value", () => {
  const result = parseChannelCommand(
    '/cpb run my-project "task" --workflow'
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_COMMAND");
});

// --- parseChannelCommand: /cpb issue ---

test("parseChannelCommand parses /cpb issue with project and number", () => {
  const result = parseChannelCommand("/cpb issue my-project 42");
  assert.equal(result.ok, true);
  assert.equal(result.type, "issue");
  assert.equal(result.command, "issue");
  assert.equal(result.project, "my-project");
  assert.equal(result.issue, 42);
  assert.equal(result.workflow, null);
});

test("parseChannelCommand parses /cpb issue with workflow", () => {
  const result = parseChannelCommand(
    "/cpb issue my-project 7 --workflow full"
  );
  assert.equal(result.ok, true);
  assert.equal(result.issue, 7);
  assert.equal(result.workflow, "full");
});

test("parseChannelCommand rejects /cpb issue with non-numeric issue", () => {
  const result = parseChannelCommand("/cpb issue my-project abc");
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_COMMAND");
});

test("parseChannelCommand rejects /cpb issue without project", () => {
  const result = parseChannelCommand("/cpb issue 42");
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_COMMAND");
});

test("parseChannelCommand rejects /cpb issue with zero issue number", () => {
  const result = parseChannelCommand("/cpb issue my-project 0");
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_COMMAND");
});

// --- parseChannelCommand: /cpb status / approve / cancel / retry / logs ---

test("parseChannelCommand parses /cpb status with job id", () => {
  const result = parseChannelCommand("/cpb status job-abc-123");
  assert.equal(result.ok, true);
  assert.equal(result.type, "status");
  assert.equal(result.command, "status");
  assert.equal(result.job, "job-abc-123");
});

test("parseChannelCommand parses /cpb approve with job id", () => {
  const result = parseChannelCommand("/cpb approve job-xyz-456");
  assert.equal(result.ok, true);
  assert.equal(result.type, "approve");
  assert.equal(result.job, "job-xyz-456");
});

test("parseChannelCommand parses /cpb cancel with job id", () => {
  const result = parseChannelCommand("/cpb cancel job-789");
  assert.equal(result.ok, true);
  assert.equal(result.type, "cancel");
  assert.equal(result.job, "job-789");
});

test("parseChannelCommand parses /cpb retry with job id", () => {
  const result = parseChannelCommand("/cpb retry job-retry-me");
  assert.equal(result.ok, true);
  assert.equal(result.type, "retry");
  assert.equal(result.job, "job-retry-me");
});

test("parseChannelCommand parses /cpb logs with job id", () => {
  const result = parseChannelCommand("/cpb logs job-log-me");
  assert.equal(result.ok, true);
  assert.equal(result.type, "logs");
  assert.equal(result.job, "job-log-me");
});

test("parseChannelCommand rejects status without job", () => {
  const result = parseChannelCommand("/cpb status");
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_COMMAND");
});

test("parseChannelCommand rejects approve without job", () => {
  const result = parseChannelCommand("/cpb approve");
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_COMMAND");
});

test("parseChannelCommand rejects cancel without job", () => {
  const result = parseChannelCommand("/cpb cancel");
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_COMMAND");
});

// --- parseChannelCommand: unknown and non-CPB commands ---

test("parseChannelCommand returns UNKNOWN_COMMAND for unknown commands", () => {
  const result = parseChannelCommand("/cpb explode everything");
  assert.equal(result.ok, false);
  assert.equal(result.code, "UNKNOWN_COMMAND");
  assert.ok(result.message.includes("explode"));
  assert.ok(result.help);
  assert.ok(result.help.includes("/cpb run"));
});

test("parseChannelCommand returns help text for unknown commands", () => {
  const result = parseChannelCommand("/cpb explode everything");
  assert.equal(result.help, CHANNEL_COMMAND_HELP);
});

test("parseChannelCommand returns NOT_CPB_COMMAND for non-CPB messages", () => {
  const result = parseChannelCommand("/slack help");
  assert.equal(result.ok, false);
  assert.equal(result.code, "NOT_CPB_COMMAND");
});

test("parseChannelCommand returns error for empty after strip", () => {
  const result = parseChannelCommand("/cpb");
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_COMMAND");
});

test("parseChannelCommand strips Slack mention prefix", () => {
  const result = parseChannelCommand("<@U12345> /cpb status job-1");
  assert.equal(result.ok, true);
  assert.equal(result.type, "status");
  assert.equal(result.job, "job-1");
});

test("parseChannelCommand strips @mention prefix", () => {
  const result = parseChannelCommand("@bot /cpb status job-2");
  assert.equal(result.ok, true);
  assert.equal(result.type, "status");
  assert.equal(result.job, "job-2");
});

test("parseChannelCommand handles cpb without slash", () => {
  const result = parseChannelCommand("cpb status job-3");
  assert.equal(result.ok, true);
  assert.equal(result.type, "status");
  assert.equal(result.job, "job-3");
});

// --- Secret input rejection (D10 dependency) ---

test("parseChannelCommand rejects input containing API key patterns", () => {
  const result = parseChannelCommand(
    "/cpb run proj set OPENAI_API_KEY=sk-1234567890abcdef"
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "SECRET_INPUT_REJECTED");
  assert.ok(result.guidance);
  assert.ok(result.detection);
  assert.equal(result.detection.matched, true);
});

test("parseChannelCommand rejects input with Bearer token", () => {
  const result = parseChannelCommand(
    '/cpb run proj "use token Bearer abc123def456ghi789jkl=="'
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "SECRET_INPUT_REJECTED");
});

test("parseChannelCommand rejects input with GitHub token", () => {
  const result = parseChannelCommand(
    "/cpb run proj use ghp_1234567890abcdefghij"
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "SECRET_INPUT_REJECTED");
});

test("parseChannelCommand rejects input with AWS access key", () => {
  const result = parseChannelCommand(
    "/cpb run proj use AKIAIOSFODNN7EXAMPLE"
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "SECRET_INPUT_REJECTED");
});

test("parseChannelCommand accepts normal task without secrets", () => {
  const result = parseChannelCommand(
    '/cpb run my-app "refactor the auth module"'
  );
  assert.equal(result.ok, true);
  assert.equal(result.type, "run");
  assert.equal(result.project, "my-app");
});

// --- Result shape verification ---

test("ok results have all base fields", () => {
  const result = parseChannelCommand('/cpb run proj "task"');
  assert.equal(result.ok, true);
  assert.equal("project" in result, true);
  assert.equal("job" in result, true);
  assert.equal("issue" in result, true);
  assert.equal("task" in result, true);
  assert.equal("workflow" in result, true);
  assert.equal("planMode" in result, true);
  assert.equal("triage" in result, true);
});

test("error results include help text", () => {
  const result = parseChannelCommand("/cpb bogus");
  assert.equal(result.ok, false);
  assert.equal(typeof result.help, "string");
  assert.ok(result.help.length > 0);
});

test("error results have all base fields", () => {
  const result = parseChannelCommand("/cpb bogus");
  assert.equal("project" in result, true);
  assert.equal("job" in result, true);
  assert.equal("issue" in result, true);
  assert.equal("task" in result, true);
  assert.equal("workflow" in result, true);
  assert.equal("planMode" in result, true);
  assert.equal("triage" in result, true);
});

// --- Combined routing options ---

test("parseChannelCommand handles all options together", () => {
  const result = parseChannelCommand(
    '/cpb run proj "complex task" --workflow full --plan-mode strict --triage rules'
  );
  assert.equal(result.ok, true);
  assert.equal(result.project, "proj");
  assert.equal(result.task, "complex task");
  assert.equal(result.workflow, "full");
  assert.equal(result.planMode, "strict");
  assert.equal(result.triage, "rules");
});

test("parseChannelCommand handles --plan-mode=light with equals", () => {
  const result = parseChannelCommand(
    '/cpb run proj "task" --plan-mode=light'
  );
  assert.equal(result.ok, true);
  assert.equal(result.planMode, "light");
});

test("parseChannelCommand handles --triage=auto with equals", () => {
  const result = parseChannelCommand(
    '/cpb run proj "task" --triage=auto'
  );
  assert.equal(result.ok, true);
  assert.equal(result.triage, "auto");
});

test("parseChannelCommand handles --triage followed by another flag", () => {
  const result = parseChannelCommand(
    '/cpb run proj "task" --triage --workflow full'
  );
  assert.equal(result.ok, true);
  assert.equal(result.triage, "auto");
  assert.equal(result.workflow, "full");
});
