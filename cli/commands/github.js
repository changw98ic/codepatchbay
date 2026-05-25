#!/usr/bin/env node
import { assertNoSecretInput } from "../../server/services/secret-policy.js";

function usage() {
  return [
    "Usage: cpb github <command>",
    "",
    "Commands:",
    "  bind <project> <owner/repo> [--json]  Bind a Hub project to a GitHub repository",
    "  connect [options]                   Configure GitHub App credentials",
    "  doctor [--json]                     Check GitHub integration health",
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

function parseConnectArgs(args = []) {
  assertNoSecretInput(args);
  const json = args.includes("--json");
  const getFlag = (name) => {
    const idx = args.indexOf(name);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
  };
  return {
    appId: getFlag("--app-id"),
    installationId: getFlag("--installation-id"),
    webhookSecretRef: getFlag("--webhook-secret-ref"),
    privateKeyRef: getFlag("--private-key-ref"),
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

async function runConnect(args, { cpbRoot } = {}) {
  const parsed = parseConnectArgs(args);

  if (!parsed.appId || !parsed.webhookSecretRef) {
    console.error("Usage: cpb github connect --app-id <id> --webhook-secret-ref <ref> [--installation-id <id>] [--private-key-ref <ref>] [--json]");
    console.error("");
    console.error("Required:");
    console.error("  --app-id <id>                GitHub App ID");
    console.error("  --webhook-secret-ref <ref>   Secret reference (e.g. env:CPB_GITHUB_WEBHOOK_SECRET)");
    console.error("");
    console.error("Optional:");
    console.error("  --installation-id <id>       GitHub App installation ID");
    console.error("  --private-key-ref <ref>      Private key reference (e.g. env:CPB_GITHUB_PRIVATE_KEY or file:/path/to/key.pem)");
    return 1;
  }

  const { saveGithubAppConfig, loadGithubAppConfig, resolveHubRoot } = await import("../../server/services/hub-registry.js");
  const { saveGithubAppConfig: save } = await import("../../server/services/github-app.js");
  const hubRoot = resolveHubRoot(cpbRoot);

  const raw = {
    appId: parsed.appId,
    webhookSecretRef: parsed.webhookSecretRef,
  };
  if (parsed.installationId) raw.installationId = parsed.installationId;
  if (parsed.privateKeyRef) raw.privateKeyRef = parsed.privateKeyRef;

  try {
    const config = await save(hubRoot, raw);
    if (parsed.json) {
      console.log(JSON.stringify({ connected: true, config }, null, 2));
    } else {
      console.log(`GitHub App ${config.appId} configured.`);
      console.log(`Config saved to ${hubRoot}/github/app.json`);
      if (config.installationId) console.log(`Installation ${config.installationId} registered.`);
      else console.log("No installation ID set — add with: cpb github connect --installation-id <id>");
    }
    return 0;
  } catch (error) {
    if (parsed.json) console.log(JSON.stringify({ connected: false, error: error.message }, null, 2));
    else console.error(`Error: ${error.message}`);
    return 1;
  }
}

async function runDoctor(args, { cpbRoot } = {}) {
  const json = args.includes("--json");
  const { resolveHubRoot } = await import("../../server/services/hub-registry.js");
  const { loadGithubAppConfig, resolveGithubWebhookSecret, buildGithubAppReadiness } = await import("../../server/services/github-app.js");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const hubRoot = resolveHubRoot(cpbRoot);

  const checks = [];

  // 1. App config exists
  let config = null;
  try {
    config = await loadGithubAppConfig(hubRoot);
    checks.push({ id: "app-config", status: "ok", message: `App ${config.appId} configured` });
  } catch {
    checks.push({ id: "app-config", status: "error", message: "App config missing or invalid", action: "Run: cpb github connect" });
  }

  // 2. Webhook secret env exists
  if (config?.webhookSecretRef) {
    try {
      resolveGithubWebhookSecret(config);
      checks.push({ id: "webhook-secret", status: "ok", message: `Webhook secret available (${config.webhookSecretRef})` });
    } catch {
      const envName = config.webhookSecretRef.replace("env:", "");
      checks.push({ id: "webhook-secret", status: "error", message: `Secret not found: ${config.webhookSecretRef}`, action: `Set: export ${envName}=<your-webhook-secret>` });
    }
  } else {
    checks.push({ id: "webhook-secret", status: "error", message: "No webhook secret ref configured", action: "Run: cpb github connect --webhook-secret-ref env:CPB_GITHUB_WEBHOOK_SECRET" });
  }

  // 3. Installation ID
  if (config?.installationId) {
    checks.push({ id: "installation-id", status: "ok", message: `Installation ${config.installationId}` });
  } else {
    checks.push({ id: "installation-id", status: "warn", message: "No installation ID", action: "Run: cpb github connect --installation-id <id>" });
  }

  // 3b. Private key (for REST API transport)
  if (config?.privateKeyRef) {
    try {
      const { resolvePrivateKey } = await import("../../server/services/github-api.js");
      resolvePrivateKey(config);
      checks.push({ id: "private-key", status: "ok", message: `Private key available (${config.privateKeyRef.split(":")[0]}:*)` });
    } catch {
      checks.push({ id: "private-key", status: "error", message: `Private key not found: ${config.privateKeyRef}`, action: "Set the private key secret and retry" });
    }
  } else {
    checks.push({ id: "private-key", status: "warn", message: "No private key — REST API transport unavailable", action: "Run: cpb github connect --private-key-ref env:CPB_GITHUB_PRIVATE_KEY" });
  }

  // 4. Repo binding exists (at least one project has github binding)
  try {
    const { listProjects } = await import("../../server/services/hub-registry.js");
    const projects = await listProjects(hubRoot);
    const bound = projects.filter((p) => p.github?.fullName);
    if (bound.length > 0) {
      checks.push({ id: "repo-binding", status: "ok", message: `${bound.length} repo(s) bound: ${bound.map((p) => p.github.fullName).join(", ")}` });
    } else {
      checks.push({ id: "repo-binding", status: "warn", message: "No repos bound", action: "Run: cpb github bind <project> <owner/repo>" });
    }
  } catch {
    checks.push({ id: "repo-binding", status: "warn", message: "Could not check repo bindings" });
  }

  // 5. gh auth status
  let ghOk = false;
  try {
    await execFileAsync("gh", ["auth", "status"], { timeout: 5000 });
    ghOk = true;
    checks.push({ id: "gh-auth", status: "ok", message: "gh CLI authenticated" });
  } catch {
    checks.push({ id: "gh-auth", status: "warn", message: "gh CLI not authenticated", action: "Run: gh auth login" });
  }

  const hasError = checks.some((c) => c.status === "error");
  if (json) {
    console.log(JSON.stringify({ healthy: !hasError, checks }, null, 2));
  } else {
    for (const c of checks) {
      const icon = c.status === "ok" ? "✓" : c.status === "warn" ? "!" : "✗";
      const color = c.status === "ok" ? "\x1b[0;32m" : c.status === "warn" ? "\x1b[1;33m" : "\x1b[0;31m";
      console.log(`  ${color}${icon}\x1b[0m ${c.message}`);
      if (c.action) console.log(`    → ${c.action}`);
    }
    console.log("");
    console.log(hasError ? "GitHub integration not ready — fix errors above." : "GitHub integration OK.");
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

  if (parsed.command === "connect") {
    return runConnect(args, { cpbRoot });
  }

  if (parsed.command === "doctor") {
    return runDoctor(args, { cpbRoot });
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
