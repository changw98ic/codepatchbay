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
import type { LooseRecord } from "../../shared/types.js";

const SCHEMA_VERSION = 1;

type JsonRecord = {
  [key: string]: unknown;
};

type QuestionFn = (question: string) => Promise<string>;

type SetupAgent = LooseRecord & {
  id: string;
  displayName: string;
  recommended?: boolean;
  vendor?: string;
  binary?: string;
};

type DetectedAgent = JsonRecord & {
  installed?: boolean;
};

type SetupSnapshot = JsonRecord & {
  agents?: Record<string, DetectedAgent>;
};

type InstallPlan = JsonRecord & {
  agent: SetupAgent;
  method: string;
  command: string;
  args: string[];
  displayCommand: string;
  requiresExplicitConfirmation?: boolean;
};

type InstallResult = JsonRecord & {
  code?: number;
};

type HealthResult = JsonRecord & {
  status?: string;
};

type NativeAuthCommand = {
  command: string;
  args: string[];
};

type AuthResult = JsonRecord & {
  error?: unknown;
  providerNativeCommand?: string | null;
  providerNative?: NativeAuthCommand | null;
};

type WizardResult = JsonRecord & {
  mode: string;
  detected: SetupSnapshot;
  selectedAgents: SetupAgent[];
  plans: Record<string, InstallPlan>;
  installations: Record<string, LooseRecord>;
  health: Record<string, HealthResult>;
  auth: Record<string, AuthResult>;
  runAuthCheck: boolean;
  executed: boolean;
  profile: LooseRecord | null;
};

type SetupWizardOptions = {
  cpbRoot?: string;
  mode?: string;
  agents?: string[];
  detectFn?: () => Promise<SetupSnapshot>;
  catalog?: SetupAgent[];
  runInstallPlanFn?: (plan: InstallPlan, options: { cpbRoot: string; stdio: string }) => Promise<InstallResult>;
  healthCheckFn?: (agentId: string) => Promise<HealthResult>;
  authConnectFn?: (agentId: string) => AuthResult;
  confirmFn?: (plan: InstallPlan) => Promise<boolean>;
  questionFn?: QuestionFn | null;
  execute?: boolean;
  stdio?: string;
};

export function setupProfilePath(cpbRoot: string): string {
  const hubRoot = process.env.CPB_HUB_ROOT || cpbHome();
  return path.join(path.resolve(hubRoot), "setup", "profile.json");
}

async function writeAtomicJson(file: string, data: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

export async function readSetupProfile(cpbRoot: string) {
  try {
    return JSON.parse(await readFile(setupProfilePath(cpbRoot), "utf8"));
  } catch (error) {
    if (isErrorRecord(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function isErrorRecord(value: unknown): value is LooseRecord {
  return value !== null && typeof value === "object";
}

function errorRecord(value: unknown): LooseRecord | null {
  return isErrorRecord(value) ? value : null;
}

function errorMessage(error: unknown): string {
  const record = errorRecord(error);
  return String(record?.message || error || "unknown error");
}

function setupSnapshot(value: unknown): SetupSnapshot {
  const record = isErrorRecord(value) ? value : {};
  const snapshot: SetupSnapshot = {};
  for (const [key, item] of Object.entries(record)) {
    if (key !== "agents") snapshot[key] = item;
  }
  const agentsRecord = isErrorRecord(record.agents) ? record.agents : null;
  const agents = agentsRecord
    ? Object.fromEntries(
      Object.entries(agentsRecord).map(([id, agent]) => [
        id,
        {
          ...(isErrorRecord(agent) ? agent : {}),
          installed: isErrorRecord(agent) && agent.installed === true,
        },
      ]),
    )
    : undefined;
  if (agents) snapshot.agents = agents;
  return snapshot;
}

function setupAgent(value: unknown): SetupAgent {
  const record = isErrorRecord(value) ? value : {};
  const id = String(record.id || "");
  return {
    ...record,
    id,
    displayName: String(record.displayName || id),
  };
}

function setupCatalog(): SetupAgent[] {
  return listSetupAgents().map(setupAgent);
}

async function defaultDetectFn(): Promise<SetupSnapshot> {
  return setupSnapshot(await detectSetupEnvironment());
}

function installResult(value: unknown): InstallResult {
  const record = isErrorRecord(value) ? value : {};
  const result: InstallResult = {};
  for (const [key, item] of Object.entries(record)) {
    if (key !== "code") result[key] = item;
  }
  if (typeof record.code === "number") result.code = record.code;
  return result;
}

async function defaultRunInstallPlan(plan: InstallPlan, { stdio }: { cpbRoot: string; stdio: string }): Promise<InstallResult> {
  return installResult(await executeInstallPlan({
    command: plan.command,
    args: plan.args,
    requiresExplicitConfirmation: plan.requiresExplicitConfirmation,
  }, { stdio }));
}

function healthResult(value: unknown): HealthResult {
  return isErrorRecord(value) ? value : {};
}

async function defaultHealthCheck(agentId: string): Promise<HealthResult> {
  return healthResult(await checkSetupAgentHealth(agentId));
}

function authResult(value: unknown): AuthResult {
  const record = isErrorRecord(value) ? value : {};
  const nativeRecord = isErrorRecord(record.providerNative) ? record.providerNative : null;
  return {
    ...record,
    providerNativeCommand: typeof record.providerNativeCommand === "string" ? record.providerNativeCommand : null,
    providerNative: nativeRecord && typeof nativeRecord.command === "string"
      ? {
        command: nativeRecord.command,
        args: Array.isArray(nativeRecord.args) ? nativeRecord.args.map(String) : [],
      }
      : null,
  };
}

function defaultAuthConnect(agentId: string): AuthResult {
  return authResult(getAuthConnectInstructions(agentId));
}

function installPlan(value: unknown): InstallPlan {
  const record = isErrorRecord(value) ? value : {};
  const args = Array.isArray(record.args) ? record.args.map(String) : [];
  const command = String(record.command || "");
  return {
    ...record,
    agent: setupAgent(record.agent),
    method: String(record.method || ""),
    command,
    args,
    displayCommand: String(record.displayCommand || command),
    requiresExplicitConfirmation: record.requiresExplicitConfirmation === true,
  };
}

function byAgentId(catalog: SetupAgent[]) {
  return new Map(catalog.map((agent) => [agent.id, agent]));
}

function missing(snapshot: SetupSnapshot, agent: SetupAgent): boolean {
  return snapshot.agents?.[agent.id]?.installed !== true;
}

function selectRecommended(catalog: SetupAgent[], snapshot: SetupSnapshot): SetupAgent[] {
  return catalog.filter((agent) => agent.recommended && missing(snapshot, agent));
}

function selectNamed(catalog: SetupAgent[], names: string[] = []): SetupAgent[] {
  const index = byAgentId(catalog);
  return names.map((name) => {
    const agent = index.get(name);
    if (!agent) throw new Error(`Unknown setup agent: ${name}`);
    return agent;
  });
}

function setupPromptLabel(agent: SetupAgent): string {
  if (agent.id === "codex") return "Codex";
  if (agent.id === "claude") return "Claude Code";
  if (agent.id === "opencode") return "OpenCode";
  return agent.displayName || agent.id;
}

function yes(answer: unknown): boolean {
  return /^y(es)?$/i.test(String(answer || "").trim());
}

async function askQuestion(question: string, questionFn: QuestionFn | null) {
  if (typeof questionFn === "function") return questionFn(question);
  if (!input.isTTY) return "";
  const rl = createInterface({ input, output });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function askForAgents(catalog: SetupAgent[], snapshot: SetupSnapshot, { questionFn }: { questionFn?: QuestionFn | null } = {}): Promise<SetupAgent[]> {
  const recommended = selectRecommended(catalog, snapshot);
  if (!input.isTTY && typeof questionFn !== "function") return recommended;

  const installPromptIds = ["codex", "claude", "opencode"];
  const index = byAgentId(catalog);
  const selected: SetupAgent[] = [];
  for (const id of installPromptIds) {
    const agent = index.get(id);
    if (!agent || !missing(snapshot, agent)) continue;
    const answer = await askQuestion(`Install ${setupPromptLabel(agent)}? y/N `, questionFn);
    if (yes(answer)) selected.push(agent);
  }
  return selected;
}

async function confirmPlan(plan: InstallPlan): Promise<boolean> {
  if (!input.isTTY) return false;
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`Execute ${plan.agent.displayName} install plan: ${plan.displayCommand}? [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function askRunAuthCheck({ mode, questionFn }: { mode?: string; questionFn?: QuestionFn | null } = {}) {
  if (mode !== "interactive") return true;
  if (!input.isTTY && typeof questionFn !== "function") return true;
  return yes(await askQuestion("Run auth check? y/N ", questionFn));
}

function installationRecord(plan: InstallPlan, result: InstallResult | null, error: unknown = null): LooseRecord {
  // error is either null (default) or an Error object thrown by runInstallPlanFn;
  // errorRecord narrows to the record shape for safe property access.
  const err = errorRecord(error);
  return {
    agentId: plan.agent.id,
    method: plan.method,
    status: err ? "failed" : "succeeded",
    exitCode: err ? (Number.isInteger(err.code) ? err.code : null) : result?.code ?? 0,
    error: err ? { message: String(err.message || "unknown error"), code: err.code || null } : null,
  };
}

function profileFromResult(result: WizardResult): LooseRecord {
  const agents: LooseRecord = {};
  for (const agent of result.selectedAgents) {
    const install = result.installations[agent.id] || null;
    const health = result.health[agent.id] || null;
    const auth = result.auth[agent.id] || null;
    const authStatus = health?.status === "ok" ? "connected" : health?.status === "skipped" ? "skipped" : auth?.error ? "error" : auth?.providerNativeCommand ? "pending" : "unknown";
    agents[agent.id] = {
      displayName: agent.displayName,
      installed: install?.status === "succeeded" || result.detected.agents?.[agent.id]?.installed === true,
      installStatus: install?.status || (result.detected.agents?.[agent.id]?.installed ? "already-installed" : "skipped"),
      healthStatus: health?.status || null,
      authStatus,
      authCheckedAt: new Date().toISOString(),
      auth: auth ? {
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
  detectFn = defaultDetectFn,
  catalog = setupCatalog(),
  runInstallPlanFn = defaultRunInstallPlan,
  healthCheckFn = defaultHealthCheck,
  authConnectFn = defaultAuthConnect,
  confirmFn = confirmPlan,
  questionFn = null,
  execute = true,
  stdio = "inherit",
}: SetupWizardOptions = {}) {
  const detected = await detectFn();
  let selectedAgents: SetupAgent[];
  if (agents.length > 0) selectedAgents = selectNamed(catalog, agents);
  else if (mode === "recommended" || mode === "non-interactive") selectedAgents = selectRecommended(catalog, detected);
  else selectedAgents = await askForAgents(catalog, detected, { questionFn });
  const runAuthCheck = await askRunAuthCheck({ mode, questionFn });

  const result: WizardResult = {
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

    const plan = installPlan(createInstallPlan({ agentId: agent.id, detected }));
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
      const install = await runInstallPlanFn(plan, { cpbRoot, stdio });
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
      result.health[agent.id] = { agent: { id: agent.id }, status: "error", error: { message: errorMessage(error) } };
    }
    try {
      result.auth[agent.id] = authConnectFn(agent.id);
    } catch (error) {
      result.auth[agent.id] = { provider: { id: agent.id }, error: errorMessage(error) };
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
        const command = auth?.providerNativeCommand;
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
          const { command: cmd, args = [] } = native;
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
          result.health[agent.id] = { agent: { id: agent.id }, status: "error", error: { message: errorMessage(error) } };
        }
        try {
          result.auth[agent.id] = authConnectFn(agent.id);
        } catch (error) {
          result.auth[agent.id] = { provider: { id: agent.id }, error: errorMessage(error) };
        }
      }
    }
  }

  result.profile = profileFromResult(result);
  await writeAtomicJson(setupProfilePath(cpbRoot), result.profile);
  return result;
}
