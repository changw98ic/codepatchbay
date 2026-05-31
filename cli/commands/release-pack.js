#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packRelease, verifyTarball, formatPackResult } from "../../server/services/release-pack.js";

function usage() {
  return [
    "Usage: cpb release pack [--output DIR] [--verify] [--json]",
    "",
    "Create a distributable tarball from the current executor root.",
    "",
    "Options:",
    "  --output DIR   Output directory for tarball (default: source root)",
    "  --verify       Verify tarball after creation",
    "  --json         Output as JSON",
    "  --help         Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { output: null, verify: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--verify") options.verify = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--output" || arg === "-o") {
      if (!argv[i + 1]) throw new Error("--output requires a value");
      options.output = argv[++i];
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function main(args, context) {
  const options = parseArgs(args);
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const sourceRoot = context?.executorRoot
    || process.env.CPB_EXECUTOR_ROOT
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

  const manifest = await packRelease({ sourceRoot, outputDir: options.output, json: options.json });

  if (options.verify) {
    const verification = await verifyTarball({ tgzPath: manifest.tgzPath });
    if (options.json) {
      console.log(JSON.stringify({ manifest, verification }, null, 2));
    } else {
      console.log(formatPackResult(manifest, { json: false }));
      console.log("\nVerification:");
      for (const c of verification.checks) {
        const icon = c.status === "ok" ? "✓" : c.status === "warn" ? "!" : "✗";
        console.log(`  ${icon} ${c.id}: ${c.message}`);
      }
      if (!verification.summary.success) {
        console.error("Verification failed.");
        return 1;
      }
    }
    return 0;
  }

  console.log(formatPackResult(manifest, { json: options.json }));
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
