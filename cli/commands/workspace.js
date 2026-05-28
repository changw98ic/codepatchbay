import {
  listWorkspaces,
  loadWorkspace,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
} from "../../server/services/workspace-registry.js";

const BOLD = "\x1b[1m";
const CYAN = "\x1b[0;36m";
const GREEN = "\x1b[0;32m";
const YELLOW = "\x1b[1;33m";
const RED = "\x1b[0;31m";
const NC = "\x1b[0m";

function formatWorkspace(workspace) {
  const type = workspace.workspace?.type || "?";
  const command = workspace.command || "?";
  const created = workspace.metadata?.createdAt
    ? new Date(workspace.metadata.createdAt).toLocaleDateString()
    : "?";
  return `  ${CYAN}${workspace.name}${NC} (${type}) — ${command}\n    created: ${created}`;
}

export async function run(args, { cpbRoot }) {
  const [subcommand, ...rest] = args;

  switch (subcommand) {
    case "list": {
      const workspaces = await listWorkspaces(cpbRoot);
      console.log(`${BOLD}Workspaces:${NC}`);
      if (workspaces.length === 0) {
        console.log("  None.");
      } else {
        for (const ws of workspaces) {
          console.log(formatWorkspace(ws));
        }
      }
      break;
    }

    case "show": {
      const name = rest[0];
      if (!name) {
        console.error(`${RED}Error:${NC} workspace name required`);
        console.log(`Usage: cpb workspace show <name>`);
        return 1;
      }

      const workspace = await loadWorkspace(cpbRoot, name);
      if (!workspace) {
        console.error(`${RED}Error:${NC} workspace not found: ${name}`);
        return 1;
      }

      console.log(`${BOLD}Workspace:${NC} ${workspace.name}`);
      console.log(`  ${YELLOW}Type:${NC} ${workspace.workspace?.type || "?"}`);
      console.log(`  ${YELLOW}Command:${NC} ${workspace.command}`);
      if (workspace.args?.length) {
        console.log(`  ${YELLOW}Args:${NC} ${workspace.args.join(" ")}`);
      }
      if (workspace.env && Object.keys(workspace.env).length > 0) {
        console.log(`  ${YELLOW}Env:${NC}`);
        for (const [key, val] of Object.entries(workspace.env)) {
          console.log(`    ${key}=${val}`);
        }
      }
      if (workspace.workspace?.host) {
        console.log(`  ${YELLOW}Host:${NC} ${workspace.workspace.host}`);
      }
      if (workspace.workspace?.user) {
        console.log(`  ${YELLOW}User:${NC} ${workspace.workspace.user}`);
      }
      if (workspace.workspace?.path) {
        console.log(`  ${YELLOW}Path:${NC} ${workspace.workspace.path}`);
      }
      console.log(`  ${YELLOW}Created:${NC} ${workspace.metadata?.createdAt || "?"}`);
      console.log(`  ${YELLOW}Updated:${NC} ${workspace.metadata?.updatedAt || "?"}`);
      break;
    }

    case "create": {
      let name, command, type;
      const extraArgs = [];

      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i];
        if (arg === "--command" && rest[i + 1]) {
          command = rest[++i];
        } else if (arg === "--type" && rest[i + 1]) {
          type = rest[++i];
        } else if (!arg.startsWith("-")) {
          name = arg;
        } else {
          extraArgs.push(arg);
        }
      }

      if (!name) {
        console.error(`${RED}Error:${NC} name required`);
        console.log(`Usage: cpb workspace create <name> --command <cmd> --type <type>`);
        return 1;
      }
      if (!command) {
        console.error(`${RED}Error:${NC} --command required`);
        console.log(`Usage: cpb workspace create <name> --command <cmd> --type <type>`);
        return 1;
      }
      if (!type) {
        console.error(`${RED}Error:${NC} --type required`);
        console.log(`Usage: cpb workspace create <name> --command <cmd> --type <type>`);
        return 1;
      }

      try {
        const workspace = await createWorkspace(cpbRoot, {
          name,
          command,
          args: extraArgs,
          workspace: { type },
        });
        console.log(`${GREEN}Created workspace:${NC} ${workspace.name}`);
        console.log(formatWorkspace(workspace));
      } catch (err) {
        console.error(`${RED}Error:${NC} ${err.message}`);
        return 1;
      }
      break;
    }

    case "delete": {
      const name = rest[0];
      if (!name) {
        console.error(`${RED}Error:${NC} workspace name required`);
        console.log(`Usage: cpb workspace delete <name>`);
        return 1;
      }

      const deleted = await deleteWorkspace(cpbRoot, name);
      if (!deleted) {
        console.error(`${RED}Error:${NC} workspace not found: ${name}`);
        return 1;
      }

      console.log(`${GREEN}Deleted workspace:${NC} ${name}`);
      break;
    }

    default:
      console.error(`${RED}Error:${NC} unknown subcommand: ${subcommand || "<none>"}`);
      console.log("");
      console.log(`${BOLD}Usage:${NC}`);
      console.log("  cpb workspace list                    List all workspaces");
      console.log("  cpb workspace show <name>             Show workspace details");
      console.log("  cpb workspace create <name> ...       Create a new workspace");
      console.log("      --command <cmd>                   Command to run");
      console.log("      --type <type>                     Workspace type (ssh, devcontainer, etc)");
      console.log("  cpb workspace delete <name>            Delete a workspace");
      return 1;
  }

  return 0;
}
