import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultSddTrace, sddDir, sddQueueMetadata, sddTracePath } from "../../core/sdd/trace.js";

const TEMPLATE_FILES = {
  spec: "spec.md",
  design: "design.md",
  tasks: "tasks.md",
} as const;

type TemplateName = keyof typeof TEMPLATE_FILES;
type LooseRecord = Record<string, any>;

function usage() {
  return "Usage: cpb sdd <init|bootstrap|verify|drift> <project> [--task \"<task>\"] [--json]";
}

function validateProject(project: string | undefined) {
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(project || "");
}

async function readTemplate(executorRoot: string, name: TemplateName) {
  const file = path.join(executorRoot, "templates", "sdd", TEMPLATE_FILES[name]);
  return readFile(file, "utf8");
}

async function writeIfMissing(file: string, content: string) {
  try {
    await readFile(file, "utf8");
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeFile(file, content, "utf8");
    return true;
  }
}

async function initSdd({ cpbRoot, executorRoot, project, status = "initialized" }: LooseRecord) {
  const dir = sddDir(cpbRoot, project);
  await mkdir(dir, { recursive: true });

  const files: LooseRecord = {};
  const created: LooseRecord = {};
  for (const name of Object.keys(TEMPLATE_FILES) as TemplateName[]) {
    const target = path.join(dir, TEMPLATE_FILES[name]);
    files[name] = target;
    created[name] = await writeIfMissing(target, await readTemplate(executorRoot, name));
  }

  const trace = defaultSddTrace(project, { status });
  const traceFile = sddTracePath(cpbRoot, project);
  files.trace = traceFile;
  await writeFile(traceFile, `${JSON.stringify(trace, null, 2)}\n`, "utf8");

  return { project, files, created, trace };
}

export async function run(args: string[], { cpbRoot, executorRoot }: LooseRecord) {
  const subcommand = args[0];
  const project = args[1];
  const json = args.includes("--json");

  if (!["init", "bootstrap", "verify", "drift"].includes(subcommand) || !validateProject(project)) {
    console.error(usage());
    process.exit(1);
  }

  if (subcommand === "verify") {
    const { verifySddProject } = await import("../../server/services/sdd/sdd.js");
    const result = await verifySddProject(cpbRoot, project);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`SDD verify: ${result.status}`);
      for (const error of result.errors) console.log(`  - ${error}`);
      for (const warning of result.warnings) console.log(`  ! ${warning}`);
    }
    return result.status === "pass" ? 0 : 1;
  }

  if (subcommand === "drift") {
    const taskFlag = args.indexOf("--task");
    const task = taskFlag >= 0 ? args[taskFlag + 1] || "" : args.slice(2).filter((arg) => !arg.startsWith("--")).join(" ");
    const { getProject, resolveHubRoot } = await import("../../server/services/hub/hub-registry.js");
    const { analyzeSddDrift } = await import("../../server/services/sdd/sdd.js");
    const hubRoot = resolveHubRoot(cpbRoot);
    const projectRecord = await getProject(hubRoot, project);
    if (!projectRecord) {
      console.error(`Project '${project}' not found.`);
      process.exit(1);
    }
    const result = await (analyzeSddDrift as any)({ cpbRoot, projectRecord, hubRoot, task });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`SDD drift: ${result.status}`);
      console.log(`  Report: ${result.reportPath}`);
      for (const finding of result.findings) console.log(`  - ${finding.kind}: ${finding.message}`);
    }
    return result.status === "fail" ? 1 : 0;
  }

  const result: LooseRecord = await initSdd({
    cpbRoot,
    executorRoot,
    project,
    status: subcommand === "bootstrap" ? "bootstrapped" : "initialized",
  });
  if (subcommand === "bootstrap") {
    result.queueMetadata = sddQueueMetadata(result.trace);
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`SDD ${subcommand}: ${project}`);
    console.log(`Spec: ${result.files.spec}`);
    console.log(`Design: ${result.files.design}`);
    console.log(`Tasks: ${result.files.tasks}`);
    console.log(`Trace: ${result.files.trace}`);
  }

  return 0;
}
