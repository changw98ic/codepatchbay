#!/usr/bin/env node
// scripts/code-index.ts — programmatic entry for code-index operations
//
// Usage: node dist/scripts/code-index.js <subcommand> [args...]
// Subcommands: status, build, query

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CPB_ROOT = path.resolve(process.env.CPB_ROOT || path.join(__dirname, ".."));

async function main() {
  const args = process.argv.slice(2);
  const subcommand = args[0];

  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    console.log("Usage: node dist/scripts/code-index.js <status|build|query> [args...]");
    process.exit(0);
  }

  const mod = await import("../cli/commands/code-index.js");
  const code = await mod.run(args, { cpbRoot: CPB_ROOT, executorRoot: CPB_ROOT });
  if (Number.isInteger(code)) process.exitCode = code;
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
