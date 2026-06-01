import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { readGithubIssues, syncConfiguredGithubIssuesFromGh } from "../server/services/github-issues.js";
import { bindProjectGithub, registerProject, updateProject } from "../server/services/hub-registry.js";

const execFileAsync = promisify(execFileCb);
const repoRoot = path.resolve(import.meta.dirname, "..");

describe("configured GitHub issue sync", () => {
  it("syncs enabled Hub projects from their configured repos and source paths", async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-github-sync-"));
    const hubRoot = path.join(tmpRoot, "hub");
    const sourceOne = await mkdtemp(path.join(tmpRoot, "source-one-"));
    const sourceTwo = await mkdtemp(path.join(tmpRoot, "source-two-"));
    const sourceDisabled = await mkdtemp(path.join(tmpRoot, "source-disabled-"));
    const calls = [];

    try {
      const alpha = await registerProject(hubRoot, { id: "alpha", sourcePath: sourceOne });
      const beta = await registerProject(hubRoot, { id: "beta", sourcePath: sourceTwo });
      await registerProject(hubRoot, { id: "disabled", sourcePath: sourceDisabled, enabled: false });
      await bindProjectGithub(hubRoot, "alpha", "octo/alpha");
      await bindProjectGithub(hubRoot, "beta", "octo/beta");
      await bindProjectGithub(hubRoot, "disabled", "octo/disabled");
      await updateProject(hubRoot, "disabled", { enabled: false });

      const execFile = async (_cmd, args, options) => {
        calls.push({ args, cwd: options.cwd });
        const repo = args[args.indexOf("--repo") + 1];
        const issueNumber = repo === "octo/alpha" ? 11 : 22;
        return {
          stdout: JSON.stringify([
            {
              number: issueNumber,
              title: `Issue for ${repo}`,
              state: "OPEN",
              url: `https://github.com/${repo}/issues/${issueNumber}`,
              labels: [{ name: "cpb" }],
            },
          ]),
        };
      };

      const result = await syncConfiguredGithubIssuesFromGh(hubRoot, { execFile });

      assert.equal(result.count, 2);
      assert.deepEqual(
        result.projects.map((project) => ({
          projectId: project.projectId,
          repo: project.repo,
          cwd: project.cwd,
          count: project.count,
        })),
        [
          { projectId: "alpha", repo: "octo/alpha", cwd: alpha.sourcePath, count: 1 },
          { projectId: "beta", repo: "octo/beta", cwd: beta.sourcePath, count: 1 },
        ],
      );
      assert.equal(calls.length, 2);
      assert.ok(calls.every((call) => call.args[0] === "issue" && call.args[1] === "list"));
      assert.deepEqual(calls.map((call) => call.cwd).sort(), [alpha.sourcePath, beta.sourcePath].sort());

      const cached = await readGithubIssues(hubRoot);
      assert.deepEqual(
        cached.map((issue) => `${issue.projectId}:${issue.repository}#${issue.number}`).sort(),
        ["alpha:octo/alpha#11", "beta:octo/beta#22"],
      );
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("CLI sync uses Hub registry bindings without relying on CPB_ROOT as a git repo", async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-github-sync-cli-"));
    const hubRoot = path.join(tmpRoot, "hub");
    const sourcePath = await mkdtemp(path.join(tmpRoot, "source-"));
    const fakeBin = path.join(tmpRoot, "bin");
    const ghCallsPath = path.join(tmpRoot, "gh-calls.jsonl");

    try {
      const project = await registerProject(hubRoot, { id: "alpha", sourcePath });
      await bindProjectGithub(hubRoot, "alpha", "octo/alpha");

      await mkdir(fakeBin, { recursive: true });
      const fakeGh = path.join(fakeBin, "gh");
      await writeFile(
        fakeGh,
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_CALLS_PATH, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
if (args[0] === "issue" && args[1] === "list") {
  const repo = args[args.indexOf("--repo") + 1];
  console.log(JSON.stringify([{ number: 7, title: "CLI sync", state: "OPEN", url: "https://github.com/" + repo + "/issues/7", labels: [] }]));
  process.exit(0);
}
console.error("unexpected gh call: " + args.join(" "));
process.exit(2);
`,
        "utf8",
      );
      await chmod(fakeGh, 0o755);

      const { stdout } = await execFileAsync(process.execPath, [path.join(repoRoot, "cli", "cpb.mjs"), "hub", "github-sync", "--json"], {
        cwd: tmpRoot,
        env: {
          ...process.env,
          CPB_HUB_ROOT: hubRoot,
          CPB_ROOT: path.join(tmpRoot, "not-a-git-repo"),
          CPB_EXECUTOR_ROOT: repoRoot,
          GH_CALLS_PATH: ghCallsPath,
          PATH: `${fakeBin}:${process.env.PATH}`,
        },
      });

      const result = JSON.parse(stdout);
      assert.equal(result.count, 1);
      assert.deepEqual(result.projects.map((entry) => ({
        projectId: entry.projectId,
        repo: entry.repo,
        cwd: entry.cwd,
      })), [
        { projectId: "alpha", repo: "octo/alpha", cwd: project.sourcePath },
      ]);

      const calls = (await readFile(ghCallsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(calls, [
        {
          args: ["issue", "list", "--repo", "octo/alpha", "--state", "open", "--limit", "1000", "--json", "number,title,body,url,state,labels,createdAt,updatedAt,closedAt"],
          cwd: project.sourcePath,
        },
      ]);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("CLI sync auto-enqueues matching synced issues by default", async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-github-sync-enqueue-cli-"));
    const hubRoot = path.join(tmpRoot, "hub");
    const cpbRoot = path.join(tmpRoot, "cpb");
    const sourcePath = await mkdtemp(path.join(tmpRoot, "source-"));
    const fakeBin = path.join(tmpRoot, "bin");

    try {
      await registerProject(hubRoot, { id: "alpha", sourcePath });
      await bindProjectGithub(hubRoot, "alpha", "octo/alpha");
      await updateProject(hubRoot, "alpha", {
        github: {
          fullName: "octo/alpha",
          automation: {
            enabled: true,
            rules: [{ name: "cpb", match: { labels: ["cpb"] }, action: { workflow: "standard" } }],
          },
        },
      });

      await mkdir(fakeBin, { recursive: true });
      const fakeGh = path.join(fakeBin, "gh");
      await writeFile(
        fakeGh,
        `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "issue" && args[1] === "list") {
  const repo = args[args.indexOf("--repo") + 1];
  console.log(JSON.stringify([{ number: 9, title: "Auto me", state: "OPEN", url: "https://github.com/" + repo + "/issues/9", labels: [{ name: "cpb" }] }]));
  process.exit(0);
}
console.error("unexpected gh call: " + args.join(" "));
process.exit(2);
`,
        "utf8",
      );
      await chmod(fakeGh, 0o755);

      const { stdout } = await execFileAsync(process.execPath, [path.join(repoRoot, "cli", "cpb.mjs"), "hub", "github-sync", "--json"], {
        cwd: tmpRoot,
        env: {
          ...process.env,
          CPB_HUB_ROOT: hubRoot,
          CPB_ROOT: cpbRoot,
          CPB_EXECUTOR_ROOT: repoRoot,
          PATH: `${fakeBin}:${process.env.PATH}`,
        },
      });

      const result = JSON.parse(stdout);
      assert.equal(result.count, 1);
      assert.deepEqual(result.autoEnqueue.map((entry) => ({
        projectId: entry.projectId,
        enqueued: entry.enqueued,
        skipped: entry.skipped,
        duplicates: entry.duplicates,
        total: entry.total,
      })), [
        { projectId: "alpha", enqueued: 1, skipped: 0, duplicates: 0, total: 1 },
      ]);

      const queue = JSON.parse(await readFile(path.join(hubRoot, "queue", "queue.json"), "utf8"));
      assert.equal(queue.entries.length, 1);
      assert.equal(queue.entries[0].projectId, "alpha");
      assert.equal(queue.entries[0].metadata.issueNumber, 9);
      assert.equal(queue.entries[0].metadata.repo, "octo/alpha");
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
