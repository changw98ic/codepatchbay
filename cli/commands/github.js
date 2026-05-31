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
    "  label <owner/repo> <issue> --add <label> [--remove <label>]",
    "                                      Add or remove labels on an issue",
    "  comment <owner/repo> <issue> --body <text>",
    "                                      Post a comment on an issue or PR",
    "  pr-body <owner/repo> <pr-number> --body <text|@file>",
    "                                      Update a PR body",
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

function buildTransportSummary(transport) {
  if (!transport) {
    return { mode: "unknown", healthy: false, errors: ["Transport not checked"] };
  }
  if (transport.mode === "api") {
    return {
      mode: "api",
      healthy: true,
      comment: "ok",
      pullRequest: "ok",
      branchPush: "ok",
    };
  }
  if (transport.mode === "gh") {
    const reason = transport.diagnostics?.find((d) => d.level === "info")?.message || "fallback active";
    return {
      mode: "gh",
      healthy: true,
      reason,
    };
  }
  return {
    mode: "unavailable",
    healthy: false,
    errors: transport.diagnostics?.map((d) => d.message) || ["Transport unavailable"],
  };
}

async function runDoctor(args, { cpbRoot } = {}) {
  const json = args.includes("--json");
  const { resolveHubRoot } = await import("../../server/services/hub-registry.js");
  const { loadGithubAppConfig, resolveGithubWebhookSecret } = await import("../../server/services/github-app.js");
  const { resolveGithubTransport } = await import("../../server/services/github-api.js");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const hubRoot = resolveHubRoot(cpbRoot);

  const layers = [];
  let transportResult = null;

  // Layer 1: App config
  let config = null;
  try {
    config = await loadGithubAppConfig(hubRoot);
    layers.push({ id: "github-app-config", status: "ok", message: `App config: app ${config.appId} configured` });
  } catch {
    layers.push({ id: "github-app-config", status: "error", message: "App config missing or invalid", action: "Run: cpb github connect" });
  }

  // Layer 2: Webhook secret
  if (config?.webhookSecretRef) {
    try {
      resolveGithubWebhookSecret(config);
      layers.push({ id: "github-webhook-secret", status: "ok", message: `Webhook secret: ${config.webhookSecretRef} available` });
    } catch {
      const envName = config.webhookSecretRef.replace("env:", "");
      layers.push({ id: "github-webhook-secret", status: "error", message: `Webhook secret: ${config.webhookSecretRef} not found`, action: `Set: export ${envName}=<your-webhook-secret>` });
    }
  } else {
    layers.push({ id: "github-webhook-secret", status: "error", message: "Webhook secret: not configured", action: "Run: cpb github connect --webhook-secret-ref env:CPB_GITHUB_WEBHOOK_SECRET" });
  }

  // Layer 3: Installation
  if (config?.installationId) {
    layers.push({ id: "github-app-installation", status: "ok", message: `Installation: ${config.installationId} configured` });
  } else {
    layers.push({ id: "github-app-installation", status: "warn", message: "Installation: not configured", action: "Run: cpb github connect --installation-id <id>" });
  }

  // Layer 4: Private key
  if (config?.privateKeyRef) {
    try {
      const { resolvePrivateKey } = await import("../../server/services/github-api.js");
      resolvePrivateKey(config);
      layers.push({ id: "github-app-private-key", status: "ok", message: `Private key: ${config.privateKeyRef.split(":")[0]}:* available` });
    } catch {
      layers.push({ id: "github-app-private-key", status: "error", message: `Private key: ${config.privateKeyRef} not found`, action: "Set the private key secret and retry" });
    }
  } else {
    layers.push({ id: "github-app-private-key", status: "warn", message: "Private key: not configured", action: "Run: cpb github connect --private-key-ref env:CPB_GITHUB_PRIVATE_KEY" });
  }

  // Layer 5: Transport
  try {
    const transport = await resolveGithubTransport(hubRoot);
    transportResult = transport;
    if (transport.mode === "api") {
      layers.push({ id: "github-transport", status: "ok", message: "Transport: api", mode: "api" });
    } else if (transport.mode === "gh") {
      const reason = transport.diagnostics?.find((d) => d.level === "warn" || d.level === "info")?.message || "gh CLI fallback";
      layers.push({ id: "github-transport", status: "ok", message: `Transport: gh (${reason})`, mode: "gh" });
    } else {
      layers.push({ id: "github-transport", status: "error", message: "Transport: unavailable", mode: "unavailable" });
    }
  } catch (error) {
    layers.push({ id: "github-transport", status: "error", message: `Transport: check failed (${error.message})`, mode: "unknown" });
  }

  // Layer 6: Repo bindings
  try {
    const { listProjects } = await import("../../server/services/hub-registry.js");
    const projects = await listProjects(hubRoot);
    const bound = projects.filter((p) => p.github?.fullName);
    if (bound.length > 0) {
      layers.push({ id: "github-repo-bindings", status: "ok", message: `Repo bindings: ${bound.map((p) => `${p.github.fullName} → project ${p.id}`).join(", ")}` });
    } else {
      layers.push({ id: "github-repo-bindings", status: "warn", message: "Repo bindings: none", action: "Run: cpb github bind <project> <owner/repo>" });
    }
  } catch {
    layers.push({ id: "github-repo-bindings", status: "warn", message: "Repo bindings: could not check" });
  }

  // Layer 7: Branch push readiness
  if (transportResult?.mode === "api" && transportResult?.getToken) {
    layers.push({ id: "github-branch-push", status: "ok", message: "Branch push: api token available" });
  } else if (transportResult?.mode === "gh") {
    layers.push({ id: "github-branch-push", status: "warn", message: "Branch push: will use local git credentials / gh auth" });
  } else {
    layers.push({ id: "github-branch-push", status: "warn", message: "Branch push: transport unavailable" });
  }

  // Layer 8: PR creation
  if (transportResult?.mode === "api" && transportResult?.createPullRequest) {
    layers.push({ id: "github-pr-creation", status: "ok", message: "PR creation: api transport available" });
  } else if (transportResult?.mode === "gh" && transportResult?.createPullRequest) {
    layers.push({ id: "github-pr-creation", status: "ok", message: "PR creation: gh transport available" });
  } else {
    layers.push({ id: "github-pr-creation", status: "warn", message: "PR creation: transport unavailable" });
  }

  // Layer 9: gh auth (for fallback)
  try {
    await execFileAsync("gh", ["auth", "status"], { timeout: 5000 });
    layers.push({ id: "github-gh-auth", status: "ok", message: "gh CLI: authenticated" });
  } catch {
    layers.push({ id: "github-gh-auth", status: "warn", message: "gh CLI: not authenticated", action: "Run: gh auth login" });
  }

  const hasError = layers.some((c) => c.status === "error");
  const transportSummary = buildTransportSummary(transportResult);

  if (json) {
    console.log(JSON.stringify({
      healthy: !hasError,
      transport: transportSummary,
      checks: layers,
    }, null, 2));
  } else {
    console.log("GitHub integration");
    console.log("");
    for (const layer of layers) {
      const icon = layer.status === "ok" ? "✓" : layer.status === "warn" ? "!" : "✗";
      const color = layer.status === "ok" ? "\x1b[0;32m" : layer.status === "warn" ? "\x1b[1;33m" : "\x1b[0;31m";
      console.log(`  ${color}${icon}\x1b[0m ${layer.message}`);
      if (layer.action) console.log(`    → ${layer.action}`);
    }
    console.log("");
    console.log("Webhook URL:");
    console.log("  http://127.0.0.1:3456/api/github/webhook");
    console.log("");
    console.log(hasError ? "GitHub integration not ready — fix errors above." : "GitHub integration OK.");
  }
  return hasError ? 1 : 0;
}

async function runLabel(args, { cpbRoot } = {}) {
  const json = args.includes("--json");
  const filtered = args.filter((a) => a !== "--json");
  const repo = filtered[0];
  const issueNumber = Number(filtered[1]);

  if (!repo || !Number.isFinite(issueNumber)) {
    console.error("Usage: cpb github label <owner/repo> <issue-number> --add <label> [--remove <label>] [--json]");
    return 1;
  }

  const addLabels = [];
  const removeLabels = [];
  for (let i = 2; i < filtered.length; i++) {
    if (filtered[i] === "--add" && filtered[i + 1]) addLabels.push(filtered[++i]);
    else if (filtered[i] === "--remove" && filtered[i + 1]) removeLabels.push(filtered[++i]);
  }

  if (addLabels.length === 0 && removeLabels.length === 0) {
    console.error("Provide at least one --add or --remove label.");
    return 1;
  }

  const { resolveHubRoot } = await import("../../server/services/hub-registry.js");
  const { resolveGithubTransport } = await import("../../server/services/github-api.js");
  const hubRoot = resolveHubRoot(cpbRoot);
  const transport = await resolveGithubTransport(hubRoot);

  if (!transport?.healthy) {
    console.error("GitHub transport unavailable. Run: cpb github doctor");
    return 1;
  }

  const results = {};

  if (addLabels.length > 0 && transport.addLabels) {
    try {
      results.added = await transport.addLabels({ repo, issueNumber, labels: addLabels });
    } catch (err) {
      results.addError = err.message;
    }
  }

  for (const label of removeLabels) {
    if (!transport.removeLabel) continue;
    try {
      await transport.removeLabel({ repo, issueNumber, label });
      results.removed = results.removed || [];
      results.removed.push(label);
    } catch (err) {
      results.removeError = err.message;
    }
  }

  if (json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    if (results.added) console.log(`Added labels: ${addLabels.join(", ")}`);
    if (results.removed) console.log(`Removed labels: ${removeLabels.join(", ")}`);
    if (results.addError) console.error(`Add error: ${results.addError}`);
    if (results.removeError) console.error(`Remove error: ${results.removeError}`);
  }
  return results.addError || results.removeError ? 1 : 0;
}

async function runComment(args, { cpbRoot } = {}) {
  const json = args.includes("--json");
  const filtered = args.filter((a) => a !== "--json");
  const repo = filtered[0];
  const issueNumber = Number(filtered[1]);

  if (!repo || !Number.isFinite(issueNumber)) {
    console.error("Usage: cpb github comment <owner/repo> <issue-number> --body <text> [--json]");
    return 1;
  }

  let body = null;
  for (let i = 2; i < filtered.length; i++) {
    if (filtered[i] === "--body" && filtered[i + 1]) body = filtered[++i];
  }

  if (!body) {
    console.error("--body is required");
    return 1;
  }

  const { resolveHubRoot } = await import("../../server/services/hub-registry.js");
  const { resolveGithubTransport } = await import("../../server/services/github-api.js");
  const hubRoot = resolveHubRoot(cpbRoot);
  const transport = await resolveGithubTransport(hubRoot);

  if (!transport?.postComment) {
    console.error("GitHub comment transport unavailable. Run: cpb github doctor");
    return 1;
  }

  try {
    const result = await transport.postComment({ repo, issueNumber, body });
    if (json) console.log(JSON.stringify({ posted: true, result }, null, 2));
    else console.log(`Comment posted on ${repo}#${issueNumber}`);
    return 0;
  } catch (err) {
    if (json) console.log(JSON.stringify({ posted: false, error: err.message }, null, 2));
    else console.error(`Failed: ${err.message}`);
    return 1;
  }
}

async function runPrBody(args, { cpbRoot } = {}) {
  const json = args.includes("--json");
  const filtered = args.filter((a) => a !== "--json");
  const repo = filtered[0];
  const pullNumber = Number(filtered[1]);

  if (!repo || !Number.isFinite(pullNumber)) {
    console.error("Usage: cpb github pr-body <owner/repo> <pr-number> --body <text|@file> [--json]");
    return 1;
  }

  let body = null;
  let title = null;
  for (let i = 2; i < filtered.length; i++) {
    if (filtered[i] === "--body" && filtered[i + 1]) {
      body = filtered[++i];
      if (body.startsWith("@")) {
        const { readFileSync } = await import("node:fs");
        body = readFileSync(body.slice(1), "utf8");
      }
    }
    if (filtered[i] === "--title" && filtered[i + 1]) title = filtered[++i];
  }

  if (!body && !title) {
    console.error("--body and/or --title is required");
    return 1;
  }

  const { resolveHubRoot } = await import("../../server/services/hub-registry.js");
  const { resolveGithubTransport } = await import("../../server/services/github-api.js");
  const hubRoot = resolveHubRoot(cpbRoot);
  const transport = await resolveGithubTransport(hubRoot);

  if (!transport?.updatePrBody) {
    console.error("GitHub PR body update unavailable. Run: cpb github doctor");
    return 1;
  }

  try {
    const result = await transport.updatePrBody({ repo, pullNumber, body, title });
    if (json) console.log(JSON.stringify({ updated: true, result }, null, 2));
    else console.log(`PR #${pullNumber} updated on ${repo}`);
    return 0;
  } catch (err) {
    if (json) console.log(JSON.stringify({ updated: false, error: err.message }, null, 2));
    else console.error(`Failed: ${err.message}`);
    return 1;
  }
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

  if (parsed.command === "label") {
    return runLabel(args, { cpbRoot });
  }

  if (parsed.command === "comment") {
    return runComment(args, { cpbRoot });
  }

  if (parsed.command === "pr-body") {
    return runPrBody(args, { cpbRoot });
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
