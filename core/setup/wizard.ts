import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { listSetupAgents } from "./agent-catalog.js";
import { detectSetupEnvironment } from "./detect.js";
import { createInstallPlan, executeInstallPlan } from "./install-plan.js";
import { checkSetupAgentHealth } from "./health-check.js";
import { getAuthConnectInstructions } from "../auth/connect.js";
import { cpbHome } from "../paths.js";

const SCHEMA_VERSION = 1;

export function setupProfilePath(cpbRoot) {
  const hubRoot = process.env.CPB_HUB_ROOT || cpbHome();
  return path.join(path.resolve(hubRoot), "setup", "profile.json");
}

async function writeAtomicJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

export async function readSetupProfile(cpbRoot) {
  try {
    return JSON.parse(await readFile(setupProfilePath(cpbRoot), "utf8"));
  } catch (error) {
    if ((error as Record<string, any>).code === "ENOENT") return null;
    throw error;
  }
}

function byAgentId(catalog) {
  return new Map(catalog.map((agent) => [agent.id, agent]));
}

function missing(snapshot, agent) {
  return snapshot.agents?.[agent.id]?.installed !== true;
}

function selectRecommended(catalog, snapshot) {
  return catalog.filter((agent) => agent.recommended && missing(snapshot, agent));
}

function selectNamed(catalog, names = []) {
  const index = byAgentId(catalog);
  return names.map((name) => {
    const agent = index.get(name);
    if (!agent) throw new Error(`Unknown setup agent: ${name}`);
    return agent;
  });
}

function setupPromptLabel(agent) {
  if (agent.id === "codex") return "Codex";
  if (agent.id === "claude") return "Claude Code";
  if (agent.id === "opencode") return "OpenCode";
  return agent.displayName || agent.id;
}

function yes(answer) {
  return /^y(es)?$/i.test(String(answer || "").trim());
}

async function askQuestion(question, questionFn) {
  if (typeof questionFn === "function") return questionFn(question);
  if (!input.isTTY) return "";
  const rl = createInterface({ input, output });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function askForAgents(catalog, snapshot, { questionFn }: Record<string, any> = {}) {
  const recommended = selectRecommended(catalog, snapshot);
  if (!input.isTTY && typeof questionFn !== "function") return recommended;

  const installPromptIds = ["codex", "claude", "opencode"];
  const index = byAgentId(catalog);
  const selected = [];
  for (const id of installPromptIds) {
    const agent = index.get(id);
    if (!agent || !missing(snapshot, agent)) continue;
    const answer = await askQuestion(`Install ${setupPromptLabel(agent)}? y/N `, questionFn);
    if (yes(answer)) selected.push(agent);
  }
  return selected;
}

async function confirmPlan(plan) {
  if (!input.isTTY) return false;
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`Execute ${plan.agent.displayName} install plan: ${plan.displayCommand}? [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function askRunAuthCheck({ mode, questionFn }: Record<string, any> = {}) {
  if (mode !== "interactive") return true;
  if (!input.isTTY && typeof questionFn !== "function") return true;
  return yes(await askQuestion("Run auth check? y/N ", questionFn));
}

function installationRecord(plan, result, error = null) {
  return {
    agentId: plan.agent.id,
    method: plan.method,
    status: error ? "failed" : "succeeded",
    exitCode: error ? (Number.isInteger(error.code) ? error.code : null) : result?.code ?? 0,
    error: error ? { message: error.message, code: error.code || null } : null,
  };
}

function profileFromResult(result) {
  const agents = {};
  for (const agent of result.selectedAgents) {
    const install = result.installations[agent.id] || null;
    const health = result.health[agent.id] || null;
    const auth = result.auth[agent.id] || null;
    const authStatus = health?.status === "ok" ? "connected" : health?.status === "skipped" ? "skipped" : auth?.error ? "error" : auth?.providerNativeCommand || auth?.localSetupUrl ? "pending" : "unknown";
    agents[agent.id] = {
      displayName: agent.displayName,
      installed: install?.status === "succeeded" || result.detected.agents?.[agent.id]?.installed === true,
      installStatus: install?.status || (result.detected.agents?.[agent.id]?.installed ? "already-installed" : "skipped"),
      healthStatus: health?.status || null,
      authStatus,
      authCheckedAt: new Date().toISOString(),
      auth: auth ? {
        localSetupUrl: auth.localSetupUrl || null,
        providerNativeCommand: auth.providerNativeCommand || null,
      } : null,
    };
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    selectedAgents: result.selectedAgents.map((agent) => agent.id),
    mode: result.mode,
    agents,
  };
}

export async function runSetupWizard({
  cpbRoot = process.env.CPB_ROOT || process.cwd(),
  mode = "interactive",
  agents = [],
  detectFn = detectSetupEnvironment,
  catalog = listSetupAgents(),
  runInstallPlanFn = executeInstallPlan,
  healthCheckFn = checkSetupAgentHealth,
  authConnectFn = getAuthConnectInstructions,
  confirmFn = confirmPlan,
  questionFn = null,
  execute = true,
  stdio = "inherit",
} = {}) {
  const detected = await detectFn();
  let selectedAgents;
  if (agents.length > 0) selectedAgents = selectNamed(catalog, agents);
  else if (mode === "recommended" || mode === "non-interactive") selectedAgents = selectRecommended(catalog, detected);
  else selectedAgents = await askForAgents(catalog, detected, { questionFn });
  const runAuthCheck = await askRunAuthCheck({ mode, questionFn });

  const result = {
    schemaVersion: SCHEMA_VERSION,
    mode,
    detected,
    selectedAgents,
    plans: {},
    installations: {},
    health: {},
    auth: {},
    runAuthCheck,
    executed: false,
    profile: null,
  };

  for (const agent of selectedAgents) {
    if (!missing(detected, agent)) {
      result.installations[agent.id] = { agentId: agent.id, status: "already-installed" };
      continue;
    }

    const plan = createInstallPlan({ agentId: agent.id, detected });
    result.plans[agent.id] = plan;
    const approved = execute && (mode === "interactive" ? await confirmFn(plan) : true);
    if (!approved) {
      result.installations[agent.id] = {
        agentId: agent.id,
        method: plan.method,
        status: execute ? "skipped" : "planned",
      };
      continue;
    }
    try {
      const install = await runInstallPlanFn(plan, { cpbRoot, stdio } as Record<string, any>);
      result.installations[agent.id] = installationRecord(plan, install);
      result.executed = true;
    } catch (error) {
      result.installations[agent.id] = installationRecord(plan, null, error);
    }
  }

  for (const agent of selectedAgents) {
    if (!runAuthCheck) {
      result.health[agent.id] = {
        agent: { id: agent.id },
        status: "skipped",
        checks: {},
        reason: "auth check skipped by user",
      };
      result.auth[agent.id] = {
        provider: { id: agent.id },
        status: "skipped",
        reason: "auth check skipped by user",
      };
      continue;
    }
    try {
      result.health[agent.id] = await healthCheckFn(agent.id);
    } catch (error) {
      result.health[agent.id] = { agent: { id: agent.id }, status: "error", error: { message: error.message } };
    }
    try {
      result.auth[agent.id] = authConnectFn(agent.id);
    } catch (error) {
      result.auth[agent.id] = { provider: { id: agent.id }, error: error.message };
    }
  }

  // Auth retry loop: if health degraded, show provider command, ask to run, spawn it, then re-check
  if (runAuthCheck && mode === "interactive" && (input.isTTY || typeof questionFn === "function")) {
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const degraded = selectedAgents.filter((agent) => {
        const health = result.health[agent.id];
        return health && health.status !== "ok" && health.status !== "skipped";
      });
      if (degraded.length === 0) break;

      if (stdio === "inherit") {
        console.log(`\nHealth degraded for: ${degraded.map((a) => a.displayName || a.id).join(", ")}`);
      }
      for (const agent of degraded) {
        const auth = result.auth[agent.id];
        const command = auth?.providerNativeCommand || auth?.localSetupUrl;
        if (command && stdio === "inherit") {
          console.log(`  ${agent.displayName}: ${command}`);
        }
      }

      const retryAnswer = await askQuestion("Run provider auth command now? (y/N) ", questionFn);
      if (!yes(retryAnswer)) break;

      // Spawn each provider-native auth command with stdio inherit
      for (const agent of degraded) {
        const auth = result.auth[agent.id];
        const native = auth?.providerNative;
        if (native?.command) {
          const { command: cmd, args } = native;
          if (stdio === "inherit") {
            console.log(`\n[setup] Running: ${cmd} ${args.join(" ")}\n`);
          }
          await new Promise<void>((resolve) => {
            const child = spawn(cmd, args, { stdio: "inherit", shell: false });
            child.on("close", (code) => {
              if (stdio === "inherit") {
                console.log(`\n[setup] ${agent.displayName} auth command exited with code ${code}\n`);
              }
              resolve();
            });
            child.on("error", (err) => {
              if (stdio === "inherit") {
                console.error(`\n[setup] Failed to run ${agent.displayName} auth command: ${err.message}\n`);
              }
              resolve();
            });
          });
        }
      }

      // Re-check health and auth after commands complete
      for (const agent of degraded) {
        try {
          result.health[agent.id] = await healthCheckFn(agent.id);
        } catch (error) {
          result.health[agent.id] = { agent: { id: agent.id }, status: "error", error: { message: error.message } };
        }
        try {
          result.auth[agent.id] = authConnectFn(agent.id);
        } catch (error) {
          result.auth[agent.id] = { provider: { id: agent.id }, error: error.message };
        }
      }
    }
  }

  result.profile = profileFromResult(result);
  await writeAtomicJson(setupProfilePath(cpbRoot), result.profile);
  return result;
}
