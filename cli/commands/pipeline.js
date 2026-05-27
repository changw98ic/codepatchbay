export async function run(args, { cpbRoot, executorRoot }) {
  const interactive = args[0] === "--interactive";
  if (interactive) args.shift();
  let planMode = "auto";
  let agent = "";
  let model = "";
  const filtered = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--plan-mode" && args[i + 1]) {
      planMode = args[++i];
    } else if (args[i] === "--agent" && args[i + 1]) {
      agent = args[++i];
    } else if (args[i] === "--model" && args[i + 1]) {
      model = args[++i];
    } else {
      filtered.push(args[i]);
    }
  }
  const project = filtered[0];
  const task = filtered[1];
  const retries = parseInt(filtered[2] || "3", 10);
  if (!project || !task) {
    console.error("Usage: cpb pipeline [--interactive] [--plan-mode auto|none|light|full|parent] [--agent <name>] [--model <profile>] <project> '<task>' [retries]");
    process.exit(1);
  }
  if (interactive) {
    console.error("Interactive mode not yet implemented in Node CLI");
    process.exit(1);
  }

  // Resolve model profile env vars
  let modelEnv = {};
  if (model) {
    const { resolveModelProfileEnv } = await import("./model-profile.js");
    if (!cpbRoot) cpbRoot = process.env.CPB_ROOT || process.cwd();
    modelEnv = await resolveModelProfileEnv(cpbRoot, model);
    if (Object.keys(modelEnv).length === 0) {
      console.error(`Model profile '${model}' not found. Register with: cpb model-profile add --name ${model} ...`);
      process.exit(1);
    }
  }

  const { runPipeline } = await import("../../bridges/run-pipeline.mjs");
  const code = await runPipeline({
    project, task, maxRetries: retries, planMode,
    agent: agent || undefined, model: model || undefined, modelEnv,
    executorRoot, cpbRoot,
  });
  return Number.isInteger(code) ? code : 0;
}
