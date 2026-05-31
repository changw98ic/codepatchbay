import { readFile } from "node:fs/promises";
import { validatePolicy, defaultPolicy, approvalOperations, requiresApproval } from "../../core/policy/team-policy.js";
import { getPhasePolicy } from "../../server/services/permission-matrix.js";
import { knowledgePolicySummary } from "../../server/services/knowledge-policy.js";

const CYAN = "\x1b[0;36m";
const GREEN = "\x1b[0;32m";
const YELLOW = "\x1b[1;33m";
const RED = "\x1b[0;31m";
const BOLD = "\x1b[1m";
const NC = "\x1b[0m";

function optionValue(args, name) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}

function usage() {
  return [
    "Usage: cpb policy <show|validate|defaults|knowledge> [options]",
    "",
    "Commands:",
    "  cpb policy show [--role <role>] [--project <name>]  Show effective phase policy",
    "  cpb policy validate <file>                           Validate a team-policy JSON file",
    "  cpb policy defaults [--json]                         Show default policy",
    "  cpb policy knowledge [--json]                        Show knowledge write policy",
  ].join("\n");
}

async function policyShow(args, { cpbRoot }) {
  const role = optionValue(args, "--role") || "executor";
  const project = optionValue(args, "--project") || "default";

  const phasePolicy = getPhasePolicy(role, cpbRoot, project);

  if (args.includes("--json")) {
    console.log(JSON.stringify(phasePolicy, null, 2));
    return 0;
  }

  console.log(`${BOLD}Phase Policy for role '${role}':${NC}`);
  console.log(`  Read scope:    ${phasePolicy.readScope}`);
  console.log(`  Read allowed:  ${phasePolicy.readAllowed.join(", ")}`);
  console.log(`  Write allowed:`);
  for (const p of phasePolicy.writeAllowed) console.log(`    ${GREEN}${p}${NC}`);
  if (phasePolicy.writeDenied?.length) {
    console.log(`  Write denied:`);
    for (const p of phasePolicy.writeDenied) console.log(`    ${RED}${p}${NC}`);
  }
  if (phasePolicy.denyTools?.length) {
    console.log(`  Deny tools:   ${phasePolicy.denyTools.join(", ")}`);
  }
  if (phasePolicy.denyCommands?.length) {
    console.log(`  Deny commands: ${phasePolicy.denyCommands}`);
  }
  if (phasePolicy.profileConfigured) {
    console.log(`  ${YELLOW}Profile overrides applied${NC}`);
  }
  return 0;
}

async function policyValidate(args) {
  const filePath = args.find(a => !a.startsWith("-"));
  if (!filePath) {
    console.error("Usage: cpb policy validate <file.json>");
    return 1;
  }

  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    console.error(`${RED}Cannot read file: ${filePath}${NC}`);
    return 1;
  }

  let policy;
  try {
    policy = JSON.parse(content);
  } catch (e) {
    console.error(`${RED}Invalid JSON: ${e.message}${NC}`);
    return 1;
  }

  const result = validatePolicy(policy);
  if (result.valid) {
    console.log(`${GREEN}Valid team policy.${NC}`);
    const ops = approvalOperations();
    const required = ops.filter(op => requiresApproval(policy, op));
    if (required.length > 0) {
      console.log(`Approvals required for: ${required.join(", ")}`);
    } else {
      console.log("No approval requirements (all operations unrestricted).");
    }
  } else {
    console.error(`${RED}Invalid team policy:${NC}`);
    for (const err of result.errors) console.error(`  - ${err}`);
    return 1;
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  }
  return 0;
}

async function policyDefaults(args) {
  const policy = defaultPolicy();
  if (args.includes("--json")) {
    console.log(JSON.stringify(policy, null, 2));
    return 0;
  }

  console.log(`${BOLD}Default Team Policy:${NC}`);
  console.log(JSON.stringify(policy, null, 2));
  return 0;
}

async function policyKnowledge(args) {
  const summary = knowledgePolicySummary();
  if (args.includes("--json")) {
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }

  console.log(`${BOLD}Knowledge Write Policy:${NC}`);
  console.log(`  Composition order:  ${summary.promptCompositionOrder.join(" → ")}`);
  console.log(`  Automatic writes:   ${summary.automaticWrites.join(", ")}`);
  console.log(`  Semi-auto writes:   ${summary.semiAutomaticWrites.join(", ")}`);
  console.log(`  Explicit confirm:   ${summary.explicitConfirmationWrites.join(", ")}`);
  console.log(`  Forbidden (md):     ${summary.forbiddenMarkdownState.join(", ")}`);
  return 0;
}

export async function run(args, { cpbRoot } = {}) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return 0;
  }

  if (!cpbRoot) cpbRoot = process.env.CPB_ROOT || process.cwd();

  const subcommand = args[0];
  switch (subcommand) {
    case "show":
      return policyShow(args.slice(1), { cpbRoot });
    case "validate":
      return policyValidate(args.slice(1));
    case "defaults":
      return policyDefaults(args.slice(1));
    case "knowledge":
      return policyKnowledge(args.slice(1));
    default:
      console.error(usage());
      return 1;
  }
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
