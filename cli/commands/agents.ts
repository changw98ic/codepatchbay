#!/usr/bin/env node
import { AnyRecord } from "../../shared/types.js";
import { listSetupAgents } from "../../core/setup/agent-catalog.js";
import { detectSetupEnvironment } from "../../core/setup/detect.js";
import { checkSetupAgentHealth } from "../../core/setup/health-check.js";
import { createInstallPlan, upgradeFor } from "../../core/setup/install-plan.js";
import { runInstallPlanWithEvents } from "../../server/services/setup.js";


const runInstallPlan = runInstallPlanWithEvents as (plan: AnyRecord, options?: AnyRecord) => Promise<AnyRecord>;

function usage() {
  return [
    "Usage: cpb agents <list|detect|install|upgrade|test> [options]",
    "",
    "Commands:",
    "  cpb agents list [--json]",
    "  cpb agents detect [--json]",
    "  cpb agents install <agent> [--method <method>] [--version <ver>] [--json] [--yes]",
    "  cpb agents upgrade <agent> [--method <method>] [--json] [--yes]",
    "  cpb agents test <agent> [--json]",
  ].join("\n");
}

function optionValue(args: string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

export async function run(args: string[] = []) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return 0;
  }

  const [command] = args;
  if (!command || command === "list") {
    const agents = listSetupAgents();
    if (args.includes("--json")) {
      console.log(JSON.stringify({ agents }, null, 2));
    } else {
      for (const agent of agents) {
        const adapter = agent.adapter;
        const protocol = adapter?.protocol || "unknown";
        const adapterCmd = adapter?.command || "-";
        console.log(`${agent.id}\t${agent.displayName}\t${protocol}\t${adapterCmd}`);
      }
    }
    return 0;
  }

  if (command === "detect") {
    const snapshot = await detectSetupEnvironment();
    if (args.includes("--json")) {
      console.log(JSON.stringify(snapshot, null, 2));
    } else {
      for (const [id, agent] of Object.entries(snapshot.agents as Record<string, AnyRecord>)) {
        const version = agent.version ? ` (${agent.version})` : "";
        console.log(`${id}\t${agent.installed ? "installed" : "missing"}${version}`);
      }
    }
    return 0;
  }

  if (command === "install") {
    const agentId = args[1];
    const method = optionValue(args, "--method");
    const version = optionValue(args, "--version");
    if (!agentId) {
      console.error(usage());
      return 1;
    }

    const detected = await detectSetupEnvironment();
    const plan = createInstallPlan({ agentId, method, version, detected }) as AnyRecord;
    const shouldExecute = args.includes("--yes");
    const result: AnyRecord = { executed: false, plan };

    if (shouldExecute) {
      result.installResult = await runInstallPlan(plan, { cpbRoot: process.env.CPB_ROOT });
      result.executed = true;
    }

    if (args.includes("--json")) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Plan: ${plan.displayCommand}`);
      if (plan.version) console.log(`Pinned: ${plan.version}`);
      if (plan.upgrade) console.log(`Upgrade: ${plan.upgrade.displayCommand}`);
      if (plan.rollback?.command) console.log(`Rollback: ${plan.rollback.command}`);
      console.log(shouldExecute ? "Executed: yes" : "Executed: no (pass --yes to run)");
    }
    return 0;
  }

  if (command === "upgrade") {
    const agentId = args[1];
    const method = optionValue(args, "--method");
    if (!agentId) {
      console.error(usage());
      return 1;
    }

    const { getSetupAgent } = await import("../../core/setup/agent-catalog.js");
    const agent = getSetupAgent(agentId) as AnyRecord | null;
    if (!agent) {
      console.error(`Unknown agent: ${agentId}`);
      return 1;
    }

    const detected = await detectSetupEnvironment();
    const selectedMethod = method || (agent.install.brew && detected?.tools?.brew?.installed
      ? "brew"
      : Object.keys(agent.upgrade || {})[0]);
    const upgrade = upgradeFor(selectedMethod, agent) as AnyRecord | null;
    if (!upgrade) {
      console.error(`No upgrade path found for '${agentId}' via '${selectedMethod}'`);
      return 1;
    }

    const shouldExecute = args.includes("--yes");
    if (shouldExecute) {
      await runInstallPlan(
        { ...upgrade, agent: { id: agent.id, displayName: agent.displayName, vendor: agent.vendor, binary: agent.binary } },
        { cpbRoot: process.env.CPB_ROOT },
      );
    }

    if (args.includes("--json")) {
      console.log(JSON.stringify({ executed: shouldExecute, upgrade }, null, 2));
    } else {
      console.log(`Upgrade: ${upgrade.displayCommand}`);
      console.log(`Source: ${upgrade.sourceUrl}`);
      console.log(shouldExecute ? "Executed: yes" : "Executed: no (pass --yes to run)");
    }
    return 0;
  }

  if (command === "test") {
    const agentId = args[1];
    if (!agentId) {
      console.error(usage());
      return 1;
    }
    const result = await checkSetupAgentHealth(agentId);
    if (args.includes("--json")) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`${agentId}: ${result.status}`);
    }
    return result.status === "ready" ? 0 : 1;
  }

  console.error(usage());
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2))
    .then((code) => {
      if (Number.isInteger(code)) process.exitCode = code;
    })
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    });
}
