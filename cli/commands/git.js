#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { assertNoSecretInput } from "../../server/services/secret-policy.js";

const execFileAsync = promisify(execFile);

function usage() {
  return [
    "Usage: cpb git <command>",
    "",
    "Commands:",
    "  bind <project> <git-url> [--json]  Bind a Hub project to a git remote",
    "  doctor [--json]                  Check git integration health",
  ].join("\n");
}

function parseArgs(args = []) {
  assertNoSecretInput(args);
  const json = args.includes("--json");
  const filtered = args.filter((arg) => arg !== "--json");
  return {
    command: filtered[0] || null,
    projectId: filtered[1] || null,
    url: filtered[2] || null,
    json,
  };
}

// Parse git remote URL to detect platform
function parseGitRemote(url) {
  const input = String(url || "").trim();

  // GitHub URLs: git@github.com:user/repo.git or https://github.com/user/repo.git
  const githubSsh = /^git@github\.com:(.+?)\/(.+?)(\.git)?$/;
  const githubHttps = /^https:\/\/github\.com\/(.+?)\/(.+?)(\.git)?$/;
  const githubMatch = input.match(githubSsh) || input.match(githubHttps);
  if (githubMatch) {
    return {
      platform: "github",
      owner: githubMatch[1],
      repo: githubMatch[2],
      fullName: `${githubMatch[1]}/${githubMatch[2]}`,
      url: input,
    };
  }

  // GitLab URLs: git@gitlab.com:user/repo.git or https://gitlab.com/user/repo.git
  const gitlabSsh = /^git@gitlab\.com:(.+?)\/(.+?)(\.git)?$/;
  const gitlabHttps = /^https:\/\/gitlab\.com\/(.+?)\/(.+?)(\.git)?$/;
  const gitlabMatch = input.match(gitlabSsh) || input.match(gitlabHttps);
  if (gitlabMatch) {
    return {
      platform: "gitlab",
      owner: gitlabMatch[1],
      repo: gitlabMatch[2],
      fullName: `${gitlabMatch[1]}/${gitlabMatch[2]}`,
      url: input,
    };
  }

  // Bitbucket URLs: git@bitbucket.org:user/repo.git or https://bitbucket.org/user/repo.git
  const bitbucketSsh = /^git@bitbucket\.org:(.+?)\/(.+?)(\.git)?$/;
  const bitbucketHttps = /^https:\/\/bitbucket\.org\/(.+?)\/(.+?)(\.git)?$/;
  const bitbucketMatch = input.match(bitbucketSsh) || input.match(bitbucketHttps);
  if (bitbucketMatch) {
    return {
      platform: "bitbucket",
      owner: bitbucketMatch[1],
      repo: bitbucketMatch[2],
      fullName: `${bitbucketMatch[1]}/${bitbucketMatch[2]}`,
      url: input,
    };
  }

  // Generic git URL (any valid git URL)
  try {
    const urlObj = new URL(input.startsWith("git@") ? `ssh://${input.replace(":", "/")}` : input);
    if (urlObj.protocol === "ssh:" || urlObj.protocol === "https:" || urlObj.protocol === "http:" || urlObj.protocol === "git:") {
      return {
        platform: "generic",
        url: input,
      };
    }
  } catch {}

  throw new Error(`invalid git remote URL: ${url}`);
}

function formatBindHuman(project) {
  const binding = project.git;
  if (!binding) {
    return `No git remote bound for project ${project.id}.`;
  }

  const parts = [`Bound ${project.id} to git remote ${binding.url}.`];
  if (binding.platform) {
    parts.push(`Platform: ${binding.platform}`);
  }
  if (binding.fullName) {
    parts.push(`Repository: ${binding.fullName}`);
  }
  parts.push(`Bound at: ${binding.boundAt}`);
  return parts.join("\n");
}

async function runDoctor(args, { cpbRoot } = {}) {
  const json = args.includes("--json");
  const { resolveHubRoot, listProjects } = await import("../../server/services/hub-registry.js");
  const hubRoot = resolveHubRoot(cpbRoot);

  const checks = [];

  // Check git availability
  try {
    const { stdout } = await execFileAsync("git", ["--version"], { timeout: 5000 });
    checks.push({ id: "git-available", status: "ok", message: `Git ${stdout.trim()}` });
  } catch {
    checks.push({ id: "git-available", status: "error", message: "Git not found", action: "Install Git." });
  }

  // Check git config
  try {
    const { stdout: name } = await execFileAsync("git", ["config", "user.name"], { timeout: 5000 });
    checks.push({ id: "git-config-name", status: "ok", message: `Git user.name: ${name.trim()}` });
  } catch {
    checks.push({ id: "git-config-name", status: "warn", message: "Git user.name not set", action: "Run: git config --global user.name 'Your Name'" });
  }

  try {
    const { stdout: email } = await execFileAsync("git", ["config", "user.email"], { timeout: 5000 });
    checks.push({ id: "git-config-email", status: "ok", message: `Git user.email: ${email.trim()}` });
  } catch {
    checks.push({ id: "git-config-email", status: "warn", message: "Git user.email not set", action: "Run: git config --global user.email 'you@example.com'" });
  }

  // Check SSH agent (for SSH remotes)
  try {
    await execFileAsync("ssh-add", ["-l"], { timeout: 5000 });
    checks.push({ id: "ssh-agent", status: "ok", message: "SSH agent running with keys" });
  } catch {
    checks.push({ id: "ssh-agent", status: "warn", message: "SSH agent not available or no keys", action: "Run: eval $(ssh-agent -s) && ssh-add" });
  }

  // Check bound git remotes
  try {
    const projects = await listProjects(hubRoot);
    const bound = projects.filter((p) => p.git?.url);
    if (bound.length > 0) {
      checks.push({ id: "git-bindings", status: "ok", message: `${bound.length} project(s) bound to git remotes` });

      // Test remote accessibility for each bound project
      for (const project of bound) {
        const remoteUrl = project.git.url;
        const checkId = `git-remote-${project.id}`;
        try {
          await execFileAsync("git", ["ls-remote", "--heads", remoteUrl], { timeout: 10000, stdio: "pipe" });
          checks.push({
            id: checkId,
            status: "ok",
            message: `${project.id}: remote accessible (${project.git.platform || "generic"})`,
            url: remoteUrl,
          });
        } catch (error) {
          checks.push({
            id: checkId,
            status: "error",
            message: `${project.id}: remote not accessible`,
            url: remoteUrl,
            action: "Check git remote URL and authentication",
          });
        }
      }
    } else {
      checks.push({ id: "git-bindings", status: "warn", message: "No projects bound to git remotes", action: "Run: cpb git bind <project> <git-url>" });
    }
  } catch (error) {
    checks.push({ id: "git-bindings", status: "warn", message: `Could not check git bindings: ${error.message}` });
  }

  const hasError = checks.some((c) => c.status === "error");

  if (json) {
    console.log(JSON.stringify({
      healthy: !hasError,
      checks,
    }, null, 2));
  } else {
    console.log("Git integration");
    console.log("");
    for (const check of checks) {
      const icon = check.status === "ok" ? "✓" : check.status === "warn" ? "!" : "✗";
      const color = check.status === "ok" ? "\x1b[0;32m" : check.status === "warn" ? "\x1b[1;33m" : "\x1b[0;31m";
      console.log(`  ${color}${icon}\x1b[0m ${check.message}`);
      if (check.action) console.log(`    → ${check.action}`);
    }
    console.log("");
    console.log(hasError ? "Git integration not ready — fix errors above." : "Git integration OK.");
  }
  return hasError ? 1 : 0;
}

export async function run(args = [], { cpbRoot } = {}) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return 0;
  }

  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  if (parsed.command === "doctor") {
    return runDoctor(args, { cpbRoot });
  }

  if (parsed.command !== "bind") {
    console.error(usage());
    return 1;
  }

  if (!parsed.projectId || !parsed.url) {
    console.error("Usage: cpb git bind <project> <git-url> [--json]");
    return 1;
  }

  try {
    const remoteInfo = parseGitRemote(parsed.url);
    const { bindProjectGit, resolveHubRoot } = await import("../../server/services/hub-registry.js");
    const hubRoot = resolveHubRoot(cpbRoot);
    const project = await bindProjectGit(hubRoot, parsed.projectId, remoteInfo);
    if (!project) {
      console.error(`project not found: ${parsed.projectId}`);
      return 1;
    }
    const payload = { bound: true, hubRoot, project };
    if (parsed.json) console.log(JSON.stringify(payload, null, 2));
    else console.log(formatBindHuman(project));
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}
