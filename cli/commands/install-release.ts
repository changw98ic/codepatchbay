#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installRelease } from "../../server/services/release/release-store.js";

export { installRelease };

function usage() {
  return [
    "Usage: cpb release install [--name ID] [--dest-root DIR] [--json]",
    "",
    "Copies CPB executor assets into an immutable release directory.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    name: null,
    destRoot: null,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--name") {
      if (!argv[i + 1]) throw new Error("--name requires a value");
      options.name = argv[i + 1];
      i += 1;
    } else if (arg === "--dest-root") {
      if (!argv[i + 1]) throw new Error("--dest-root requires a value");
      options.destRoot = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

async function main(args, context: Record<string, any> = {}) {
  const options = parseArgs(args);
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const sourceRoot = context?.executorRoot
    || process.env.CPB_EXECUTOR_ROOT
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

  const manifest = await installRelease({
    sourceRoot,
    destRoot: options.destRoot,
    name: options.name,
  });

  if (options.json) {
    console.log(JSON.stringify(manifest, null, 2));
  } else {
    console.log(`Release installed: ${manifest.installedPath}`);
    console.log(`Use: CPB_EXECUTOR_ROOT=${manifest.installedPath} CPB_ROOT=<project-cpb-root> cpb hub-orch start`);
  }
  return 0;
}

export async function run(args, context) {
  return main(args, context);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
