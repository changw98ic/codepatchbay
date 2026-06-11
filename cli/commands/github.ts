#!/usr/bin/env node
import { assertNoSecretInput } from "../../server/services/secret-policy.js";

type LooseRecord = Record<string, any>;

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

function parseArgs(args: string[] = []) {
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

function parseConnectArgs(args: string[] = []) {
  assertNoSecretInput(args);
  const json = args.includes("--json");
  const getFlag = (name: string): string | null => {
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

function formatBindHuman(project: LooseRecord) {
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

async function runConnect(args: string[], { cpbRoot }: LooseRecord = {}) {
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

  const { resolveHubRoot } = await import("../../server/services/hub-registry.js");
  const { saveGithubAppConfig: save } = await import("../../server/services/github-app.js");
  const hubRoot = resolveHubRoot(cpbRoot);

  const raw: LooseRecord = {
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
    const message = (error as Error).message;
    if (parsed.json) console.log(JSON.stringify({ connected: false, error: message }, null, 2));
    else console.error(`Error: ${message}`);
    return 1;
  }
}

function buildTransportSummary(transport: LooseRecord | null) {
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

async function runDoctor(args: string[], { cpbRoot }: LooseRecord = {}) {
  const json = args.includes("--json");
  const { resolveHubRoot } = await import("../../server/services/hub-registry.js");
  const { loadGithubAppConfig, resolveGithubWebhookSecret } = await import("../../server/services/github-app.js");
  const { resolveGithubTransport } = await import("../../server/services/github-api.js");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const hubRoot = resolveHubRoot(cpbRoot);

  const layers: LooseRecord[] = [];
  let transportResult: LooseRecord | null = null;

  // Layer 1: App config
  let config: LooseRecord | null = null;
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
    layers.push({ id: "github-transport", status: "error", message: `Transport: check failed (${(error as Error).message})`, mode: "unknown" });
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

export async function run(args: string[] = [], { cpbRoot }: LooseRecord = {}) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return 0;
  }

  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    console.error((error as Error).message);
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
    console.error((error as Error).message);
    return 1;
  }
}
