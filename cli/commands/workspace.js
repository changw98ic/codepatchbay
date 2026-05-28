import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFile = promisify(execFileCb);
const TEMPLATES_DIR = path.join(import.meta.dirname, "..", "..", "core", "agents", "templates");

function optionValue(args, name) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}

function configDir(cpbRoot) {
  return process.env.CPB_WORKSPACE_CONFIG_DIR || path.join(cpbRoot, "cpb-task", "workspaces");
}

function fillTemplate(template, vars) {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value || "");
  }
  return result;
}

async function loadTemplate(name) {
  try {
    return await readFile(path.join(TEMPLATES_DIR, `${name}.json`), "utf8");
  } catch {
    return null;
  }
}

function statusMark(ok) {
  return ok ? "OK" : "--";
}

async function isCommandAvailable(command) {
  return execFile("which", [command])
    .then(() => true)
    .catch(() => false);
}

// ─── init ───

async function initWorkspace(args, { cpbRoot }) {
  const type = optionValue(args, "--type") || "ssh";
  const name = optionValue(args, "--name");
  const displayName = optionValue(args, "--display-name") || name;
  const description = optionValue(args, "--description") || `${name} workspace backend`;

  if (!name) {
    console.error("--name is required");
    return 1;
  }

  if (!["ssh", "devcontainer"].includes(type)) {
    console.error(`--type must be 'ssh' or 'devcontainer', got: ${type}`);
    return 1;
  }

  const templateName = `${type}-workspace`;
  const templateStr = await loadTemplate(templateName);
  if (!templateStr) {
    console.error(`Unknown template: ${templateName}`);
    return 1;
  }

  // Type-specific fields
  const vars = {
    name,
    displayName,
    description,
    name_upper: name.toUpperCase().replace(/-/g, "_"),
    host: optionValue(args, "--host") || "localhost",
    port: optionValue(args, "--port") || "22",
    user: optionValue(args, "--user") || "root",
    path: optionValue(args, "--path") || "/workspace",
    syncStrategy: optionValue(args, "--sync-strategy") || "rsync",
    containerId: optionValue(args, "--container-id") || name,
    image: optionValue(args, "--image") || "ubuntu:latest",
    dockerfilePath: optionValue(args, "--dockerfile") || ".devcontainer/Dockerfile",
    contextPath: optionValue(args, "--context") || ".",
    mountPoint: optionValue(args, "--mount") || "/workspace",
  };

  const filled = fillTemplate(templateStr, vars);
  let descriptor;
  try {
    descriptor = JSON.parse(filled);
  } catch (e) {
    console.error(`Generated invalid JSON: ${e.message}`);
    return 1;
  }

  const dir = configDir(cpbRoot);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${name}.json`);
  await writeFile(filePath, `${JSON.stringify(descriptor, null, 2)}\n`, "utf8");

  console.log(`Workspace '${name}' registered at ${filePath}`);
  console.log(`  type:       ${type}`);
  console.log(`  stability:  ${descriptor.stability}`);
  console.log(`  workspace:  ${descriptor.workspace.type}`);
  return 0;
}

// ─── list ───

async function listWorkspaces(args, { cpbRoot }) {
  const dir = configDir(cpbRoot);
  const { readdir } = await import("node:fs/promises");

  let files;
  try {
    files = await readdir(dir);
  } catch {
    console.log("No workspaces registered.");
    return 0;
  }

  const workspaceFiles = files.filter((f) => f.endsWith(".json"));
  if (workspaceFiles.length === 0) {
    console.log("No workspaces registered.");
    return 0;
  }

  const workspaces = [];
  for (const f of workspaceFiles) {
    try {
      const content = await readFile(path.join(dir, f), "utf8");
      const descriptor = JSON.parse(content);
      workspaces.push(descriptor);
    } catch {
      // Skip invalid descriptors
    }
  }

  if (workspaces.length === 0) {
    console.log("No valid workspaces registered.");
    return 0;
  }

  const json = args.includes("--json");
  if (json) {
    console.log(JSON.stringify(workspaces, null, 2));
    return 0;
  }

  const header = "  STS  NAME              TYPE           DISPLAY NAME             STABILITY";
  console.log(header);
  for (const w of workspaces) {
    const available = await isCommandAvailable(w.command);
    const line = [
      `  ${statusMark(available)}`,
      (w.name || "").padEnd(18),
      (w.workspace?.type || "").padEnd(15),
      (w.displayName || "").padEnd(25),
      w.stability || "unknown",
    ].join("  ");
    console.log(line);
  }
  console.log("");
  console.log("  STS = command found in PATH");
  return 0;
}

// ─── status ───

async function statusWorkspace(args, { cpbRoot }) {
  const name = args.find((a) => !a.startsWith("-"));
  if (!name) {
    console.error("Usage: cpb workspace status <name>");
    return 1;
  }

  const dir = configDir(cpbRoot);
  const filePath = path.join(dir, `${name}.json`);

  if (!existsSync(filePath)) {
    console.error(`Workspace '${name}' not found.`);
    return 1;
  }

  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch (e) {
    console.error(`Failed to read workspace: ${e.message}`);
    return 1;
  }

  let descriptor;
  try {
    descriptor = JSON.parse(content);
  } catch (e) {
    console.error(`Invalid workspace descriptor: ${e.message}`);
    return 1;
  }

  const json = args.includes("--json");
  if (json) {
    console.log(JSON.stringify(descriptor, null, 2));
    return 0;
  }

  console.log(`Workspace: ${descriptor.name}`);
  console.log(`  Display Name:  ${descriptor.displayName}`);
  console.log(`  Type:         ${descriptor.workspace?.type || "unknown"}`);
  console.log(`  Stability:    ${descriptor.stability}`);
  console.log(`  Command:      ${descriptor.command} ${descriptor.args?.join(" ") || ""}`);

  if (descriptor.workspace) {
    console.log(`  Workspace Config:`);
    for (const [key, value] of Object.entries(descriptor.workspace)) {
      if (key === "type") continue;
      console.log(`    ${key}: ${value}`);
    }
  }

  const available = await isCommandAvailable(descriptor.command);
  console.log(`  Status:       ${available ? "Available" : "Not available (command not in PATH)"}`);

  return 0;
}

// ─── doctor ───

async function doctorWorkspace(args, { cpbRoot }) {
  const dir = configDir(cpbRoot);
  const { readdir } = await import("node:fs/promises");

  let files;
  try {
    files = await readdir(dir);
  } catch {
    console.log("No workspaces directory found.");
    return 0;
  }

  const workspaceFiles = files.filter((f) => f.endsWith(".json"));
  if (workspaceFiles.length === 0) {
    console.log("No workspaces registered.");
    return 0;
  }

  let passed = 0;
  let failed = 0;
  let warned = 0;

  console.log("Workspace doctor checks:");
  console.log("");

  for (const f of workspaceFiles) {
    const name = f.replace(".json", "");
    const filePath = path.join(dir, f);
    let descriptor;

    try {
      const content = await readFile(filePath, "utf8");
      descriptor = JSON.parse(content);
    } catch {
      console.log(`  ✗ ${name}: Invalid descriptor`);
      failed++;
      continue;
    }

    // Check 1: workspace type
    if (!descriptor.workspace?.type) {
      console.log(`  ✗ ${name}: Missing workspace type`);
      failed++;
      continue;
    }

    // Check 2: command available
    const cmdAvailable = await isCommandAvailable(descriptor.command);
    if (cmdAvailable) {
      console.log(`  ✓ ${name}: Command '${descriptor.command}' available`);
      passed++;
    } else {
      console.log(`  ! ${name}: Command '${descriptor.command}' not in PATH`);
      warned++;
    }

    // Check 3: type-specific checks
    if (descriptor.workspace.type === "ssh") {
      if (descriptor.workspace.host) {
        console.log(`    ├─ host: ${descriptor.workspace.host}`);
        passed++;
      } else {
        console.log(`    └─ host: missing`);
        warned++;
      }
    } else if (descriptor.workspace.type === "devcontainer") {
      if (descriptor.workspace.containerId || descriptor.workspace.image) {
        const target = descriptor.workspace.containerId || descriptor.workspace.image;
        console.log(`    ├─ target: ${target}`);
        passed++;
      } else {
        console.log(`    └─ target: missing containerId and image`);
        warned++;
      }
    }
  }

  console.log("");
  console.log(`Result: ${passed} passed, ${warned} warnings, ${failed} failed`);
  return failed > 0 ? 1 : 0;
}

// ─── main ───

export async function run(args, { cpbRoot } = {}) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage:
  cpb workspace init --name <name> --type <ssh|devcontainer> [--display-name <name>] [--host <host>] [--port <port>] [--user <user>] [--path <path>]
  cpb workspace init --name <name> --type devcontainer [--container-id <id>] [--image <image>] [--dockerfile <path>]
  cpb workspace list [--json]
  cpb workspace status <name> [--json]
  cpb workspace doctor`);
    return 0;
  }

  if (!cpbRoot) cpbRoot = process.env.CPB_ROOT || process.cwd();

  const subcommand = args[0];
  switch (subcommand) {
    case "init":
      return initWorkspace(args.slice(1), { cpbRoot });
    case "list":
      return listWorkspaces(args.slice(1), { cpbRoot });
    case "status":
      return statusWorkspace(args.slice(1), { cpbRoot });
    case "doctor":
      return doctorWorkspace(args.slice(1), { cpbRoot });
    default:
      console.error("Unknown subcommand. Use: init, list, status, doctor");
      return 1;
  }
}
