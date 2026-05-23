#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveInstallBinExecutorRoot, installBin } from "../../server/services/install-bin.js";

function usage() {
  return [
    "Usage: cpb install-bin [--target PATH] [--bin-dir DIR] [--executor-root DIR|current] [--json]",
    "",
    "Install a stable CPB launcher that pins CPB_EXECUTOR_ROOT.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    target: null,
    binDir: null,
    executorRootOption: null,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--target") {
      if (!argv[i + 1]) throw new Error("--target requires a value");
      options.target = argv[i + 1];
      i += 1;
    } else if (arg === "--bin-dir") {
      if (!argv[i + 1]) throw new Error("--bin-dir requires a value");
      options.binDir = argv[i + 1];
      i += 1;
    } else if (arg === "--executor-root") {
      if (!argv[i + 1]) throw new Error("--executor-root requires a value");
      options.executorRootOption = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

async function main(args) {
  const options = parseArgs(args || process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  let target = options.target;
  if (!target && options.binDir) {
    target = path.join(options.binDir, "cpb");
  }
  if (!target) {
    target = "/usr/local/bin/cpb";
  }

  const scriptRoot = path.resolve(
    path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
  );

  const executorRoot = await resolveInstallBinExecutorRoot({
    executorRootOption: options.executorRootOption,
    scriptRoot,
    env: process.env,
  });

  const metadata = await installBin({ target, executorRoot });

  if (options.json) {
    console.log(JSON.stringify(metadata, null, 2));
  } else {
    console.log(`Installed CPB launcher: ${metadata.target}`);
    console.log(`Pinned executor root: ${metadata.executorRoot}`);
  }
}

export async function run(args) {
  return main(args);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
