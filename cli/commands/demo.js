import { runDemo } from "../../server/services/demo-runner.js";

function usage() {
  return `Usage: cpb demo [--json] [--project <name>] [--task <text>]

Runs a local mock plan -> diff -> tests -> verdict -> risk story in a temporary toy repo.
No real agent credentials or provider API keys are required.`;
}

function parseArgs(args) {
  const opts = { json: false, project: undefined, task: undefined, help: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--project") {
      const value = args[++i];
      if (!value) throw new Error("--project requires a value");
      opts.project = value;
    } else if (arg === "--task") {
      const value = args[++i];
      if (!value) throw new Error("--task requires a value");
      opts.task = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

export async function run(args) {
  const opts = parseArgs(args);
  if (opts.help) {
    console.log(usage());
    return 0;
  }

  const result = await runDemo({ project: opts.project, task: opts.task });
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  console.log("CodePatchBay demo completed.");
  console.log(`Project: ${result.project}`);
  console.log(`Job: ${result.job.jobId}`);
  console.log(`Status: ${result.job.status}`);
  console.log(`Temp root: ${result.tempRoot}`);
  console.log(`Toy repo: ${result.sourcePath}`);
  console.log(`CPB root: ${result.cpbRoot}`);
  console.log(`Event log: ${result.eventLog}`);
  console.log("Story:");
  for (const entry of result.story || []) {
    console.log("");
    console.log(entry.label);
    console.log(`- ${entry.summary}`);
    console.log(`- Artifact: ${entry.path}`);
  }
  return 0;
}
