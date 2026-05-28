import { hubStatus, listProjects, resolveHubRoot, workerStatus } from "../../server/services/hub-registry.js";

export async function run(args, { cpbRoot }) {
  const json = args.includes("--json");
  const hubRoot = resolveHubRoot(cpbRoot);

  const status = await hubStatus(hubRoot);
  const projects = await listProjects(hubRoot);

  if (json) {
    console.log(JSON.stringify({ ...status, projects }, null, 2));
  } else {
    const CYAN = "\x1b[0;36m";
    const GREEN = "\x1b[0;32m";
    const YELLOW = "\x1b[1;33m";
    const RED = "\x1b[0;31m";
    const NC = "\x1b[0m";
    const BOLD = "\x1b[1m";

    console.log(`${BOLD}Workspace${NC}`);
    console.log(`${CYAN}Hub Root:${NC} ${status.hubRoot}`);
    console.log(`${CYAN}Registry:${NC}  ${status.registryPath}`);
    console.log(`${CYAN}Projects:${NC} ${status.enabledProjectCount}/${status.projectCount} enabled`);
    console.log(`${CYAN}Workers:${NC}  ${GREEN}${status.workersOnline}${NC} online, ${YELLOW}${status.workersStale}${NC} stale, ${RED}${status.workersOffline}${NC} offline`);
    if (status.updatedAt) {
      console.log(`${CYAN}Updated:${NC}  ${status.updatedAt}`);
    }

    if (projects.length > 0) {
      console.log(`\n${BOLD}Projects${NC}`);
      for (const project of projects) {
        const enabled = project.enabled === false ? "-" : "+";
        const worker = project.worker?.lastSeenAt ? ` worker:${workerStatus(project)}` : "";
        console.log(`  ${enabled} ${project.id}\t${project.sourcePath}${worker}`);
      }
    }
  }

  return 0;
}
