#!/usr/bin/env node
import { listSetupAgents } from "../../core/setup/agent-catalog.js";
import { detectSetupEnvironment } from "../../core/setup/detect.js";
import { createInstallPlan, executeInstallPlan } from "../../core/setup/install-plan.js";

function usage() {
  return [
    "Usage: cpb agents <list|detect|install|test> [options]",
    "",
    "Commands:",
    "  cpb agents list [--json]",
    "  cpb agents detect [--json]",
    "  cpb agents install <agent> --method <method> [--json] [--yes]",
    "  cpb agents test <agent> [--json]",
  ].join("\n");
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

export async function run(args = []) {
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
        console.log(`${agent.id}\t${agent.displayName}`);
      }
    }
    return 0;
  }

  if (command === "detect") {
    const snapshot = await detectSetupEnvironment();
    if (args.includes("--json")) {
      console.log(JSON.stringify(snapshot, null, 2));
    } else {
      for (const [id, agent] of Object.entries(snapshot.agents)) {
        const version = agent.version ? ` (${agent.version})` : "";
        console.log(`${id}\t${agent.installed ? "installed" : "missing"}${version}`);
      }
    }
    return 0;
  }

  if (command === "install") {
    const agentId = args[1];
    const method = optionValue(args, "--method");
    if (!agentId) {
      console.error(usage());
      return 1;
    }

    const detected = await detectSetupEnvironment();
    const plan = createInstallPlan({ agentId, method, detected });
    const shouldExecute = args.includes("--yes");
    const result = { executed: false, plan };

    if (shouldExecute) {
      result.installResult = await executeInstallPlan(plan);
      result.executed = true;
    }

    if (args.includes("--json")) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Plan: ${plan.displayCommand}`);
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
    const snapshot = await detectSetupEnvironment();
    const result = snapshot.agents[agentId];
    if (!result) {
      console.error(`Unknown agent: ${agentId}`);
      return 1;
    }
    if (args.includes("--json")) {
      console.log(JSON.stringify({ agent: result }, null, 2));
    } else {
      const version = result.version ? ` (${result.version})` : "";
      console.log(`${agentId}: ${result.installed ? "installed" : "missing"}${version}`);
    }
    return result.installed ? 0 : 1;
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
