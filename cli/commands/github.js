#!/usr/bin/env node
import { assertNoSecretInput } from "../../server/services/secret-policy.js";

function usage() {
  return [
    "Usage: cpb github <command>",
    "",
    "Commands:",
    "  bind <project> <owner/repo> [--json]  Bind a Hub project to a GitHub repository",
    "  connect                            Show GitHub App setup guidance",
  ].join("\n");
}

function parseArgs(args = []) {
  assertNoSecretInput(args);
  const json = args.includes("--json");
  const filtered = args.filter((arg) => arg !== "--json");
  return {
    command: filtered[0] || null,
    projectId: filtered[1] || null,
    repo: filtered[2] || null,
    json,
  };
}

function formatBindHuman(project) {
  return [
    `Bound ${project.id} to GitHub repo ${project.github.fullName}.`,
    "",
    "Default triggers:",
    ...project.github.triggers.map((trigger) => {
      const selector = trigger.label || trigger.command || trigger.assignee || "";
      return `- ${trigger.event}${selector ? `: ${selector}` : ""} -> ${trigger.workflow}`;
    }),
    "",
  ].join("\n");
}

function githubConnectGuidance() {
  return {
    connected: false,
    guidance: "GitHub App setup is not configured yet. Use cpb github bind <project> <owner/repo> to record repo binding locally.",
  };
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

  if (parsed.command === "connect") {
    const guidance = githubConnectGuidance();
    if (parsed.json) console.log(JSON.stringify(guidance, null, 2));
    else console.log(`${guidance.guidance}\n`);
    return 0;
  }

  if (parsed.command !== "bind") {
    console.error(usage());
    return 1;
  }

  if (!parsed.projectId || !parsed.repo) {
    console.error("Usage: cpb github bind <project> <owner/repo> [--json]");
    return 1;
  }

  try {
    const { bindProjectGithub, resolveHubRoot } = await import("../../server/services/hub-registry.js");
    const hubRoot = resolveHubRoot(cpbRoot);
    const project = await bindProjectGithub(hubRoot, parsed.projectId, parsed.repo);
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
