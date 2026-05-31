#!/usr/bin/env node
import path from "node:path";
import {
  listReleases,
  inspectCurrentRelease,
  selectRelease,
} from "../../server/services/release-store.js";

function parseFlags(args) {
  const rest = [];
  let json = false;
  let destRoot = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") { json = true; continue; }
    if (args[i] === "--dest-root" && i + 1 < args.length) { destRoot = args[++i]; continue; }
    if (args[i].startsWith("--dest-root=")) { destRoot = args[i].slice("--dest-root=".length); continue; }
    if (args[i] === "--help" || args[i] === "-h") {
      printUsage();
      process.exit(0);
    }
    rest.push(args[i]);
  }
  return { json, destRoot, rest };
}

function printUsage() {
  console.log(`Usage: cpb release <subcommand> [options]

Subcommands:
  list [--json] [--dest-root DIR]    List installed releases
  current [--json]                   Show current release
  use <release-id> [--json] [--dest-root DIR]  Select a release
  install [--name ID] [--dest-root DIR] [--json]  Install a release
  pack [--output DIR] [--verify] [--json]  Create distributable tarball
  doctor [--json]                    Release health checks
  gc [--dry-run|--execute] [--json]  Release garbage collection

Options:
  --json          Output as JSON
  --dest-root DIR Release store root directory
  --dry-run       Preview only (default for gc)
  --execute       Execute GC deletions
  --output DIR    Output directory for tarball (pack)
  --verify        Verify tarball after creation (pack)
  --help          Show this help`);
}

async function cmdList({ json, destRoot }) {
  const result = await listReleases({ destRoot });
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  console.log(`Release store: ${result.releaseStoreRoot}`);
  if (result.releases.length === 0) {
    console.log("  No releases installed.");
    return;
  }
  for (const r of result.releases) {
    const marker = r.current ? "*" : " ";
    if (r.status === "invalid") {
      console.log(`  ${marker} ${r.releaseId} (invalid: ${r.error})`);
    } else {
      console.log(`  ${marker} ${r.releaseId}  v${r.codeVersion || "?"}  ${r.createdAt || ""}`);
    }
  }
}

async function cmdCurrent({ json }) {
  const result = await inspectCurrentRelease();
  if (!result) {
    if (json) {
      process.stderr.write(JSON.stringify({ current: false, error: "No release selected" }) + "\n");
    } else {
      console.error("No release selected. Use: cpb release use <release-id>");
    }
    process.exitCode = 1;
    return;
  }
  if (json) {
    process.stdout.write(JSON.stringify({ current: true, selector: result.selector, metadata: result.metadata }, null, 2) + "\n");
    return;
  }
  const m = result.metadata;
  if (m) {
    console.log(`Current release: ${m.releaseId}`);
    console.log(`  Path: ${m.installedPath}`);
    console.log(`  Created: ${m.createdAt}`);
    console.log(`  Version: ${m.codeVersion}`);
    console.log(`  Package: ${m.packageName}`);
  } else {
    console.log(`Current release: ${result.selector?.releaseId || "unknown"} (metadata unavailable)`);
  }
}

async function cmdUse({ json, destRoot, rest }) {
  const releaseId = rest[0];
  if (!releaseId) {
    if (json) {
      process.stderr.write(JSON.stringify({ ok: false, error: "Missing release-id argument" }) + "\n");
    } else {
      console.error("Usage: cpb release use <release-id> [--json] [--dest-root DIR]");
    }
    process.exitCode = 1;
    return;
  }

  try {
    const result = await selectRelease({ releaseId, destRoot });
    if (json) {
      process.stdout.write(JSON.stringify({
        selected: true,
        selector: result.selector,
        metadata: result.metadata,
        compatibility: result.compatibility,
      }, null, 2) + "\n");
      return;
    }
    console.log(`Selected release: ${result.selector.releaseId}`);
    console.log(`  Path: ${result.selector.releasePath}`);
  } catch (err) {
    if (err.name === "ReleaseCompatibilityError") {
      if (json) {
        process.stderr.write(JSON.stringify({
          ok: false,
          error: { code: "release_incompatible", message: err.message, releaseId, failures: err.failures },
          releaseId,
          failures: err.failures,
        }, null, 2) + "\n");
      } else {
        console.error(`Cannot select release '${releaseId}':`);
        for (const f of err.failures) {
          console.error(`  ${f.code}: ${f.message}`);
        }
      }
    } else {
      if (json) {
        process.stderr.write(JSON.stringify({ ok: false, error: err.message, releaseId }) + "\n");
      } else {
        console.error(`Error: ${err.message}`);
      }
    }
    process.exitCode = 1;
  }
}

async function cmdDoctor({ json }) {
  const {
    runReleaseDoctorChecks,
    formatReleaseDoctorHuman,
    formatReleaseDoctorJson,
  } = await import("../../server/services/readiness-checks.js");

  const result = await runReleaseDoctorChecks({ cpbRoot: process.env.CPB_ROOT });
  if (json) {
    process.stdout.write(formatReleaseDoctorJson(result) + "\n");
  } else {
    process.stdout.write(formatReleaseDoctorHuman(result) + "\n");
  }
  if (!result.summary.success) process.exitCode = 1;
}

async function cmdGc({ json, rest }) {
  const hasExecute = rest.includes("--execute");
  const hasDryRun = rest.includes("--dry-run");
  const dryRun = !hasExecute || hasDryRun;

  const {
    buildReleaseGcPlan,
    executeReleaseGc,
    formatGcPlanHuman,
    formatGcResultHuman,
  } = await import("../../server/services/release-gc.js");

  const plan = await buildReleaseGcPlan({ cpbRoot: process.env.CPB_ROOT });

  if (dryRun) {
    if (json) {
      process.stdout.write(JSON.stringify({ dryRun: true, plan }, null, 2) + "\n");
    } else {
      console.log("=== DRY RUN: No releases will be deleted ===\n");
      process.stdout.write(formatGcPlanHuman(plan) + "\n");
    }
    return;
  }

  const result = await executeReleaseGc(plan, { cpbRoot: process.env.CPB_ROOT });
  if (json) {
    process.stdout.write(JSON.stringify({ dryRun: false, plan, result }, null, 2) + "\n");
  } else {
    process.stdout.write(formatGcResultHuman(result) + "\n");
  }
}

async function cmdInstall(args, context) {
  const mod = await import("./install-release.js");
  if (typeof mod.run !== "function") {
    console.error("install-release module missing run()");
    process.exitCode = 1;
    return;
  }
  const code = await mod.run(args, context);
  if (Number.isInteger(code)) process.exitCode = code;
}

async function cmdPack(args, context) {
  const mod = await import("./release-pack.js");
  if (typeof mod.run !== "function") {
    console.error("release-pack module missing run()");
    process.exitCode = 1;
    return;
  }
  const code = await mod.run(args, context);
  if (Number.isInteger(code)) process.exitCode = code;
}

export async function run(args, context) {
  const sub = args[0] || "";
  const flags = parseFlags(args.slice(1));
  switch (sub) {
    case "list": await cmdList(flags); break;
    case "current": await cmdCurrent(flags); break;
    case "use": await cmdUse(flags); break;
    case "install": await cmdInstall(args.slice(1), context); break;
    case "pack": await cmdPack(args.slice(1), context); break;
    case "doctor": await cmdDoctor(flags); break;
    case "gc": await cmdGc(flags); break;
    default:
      printUsage();
      return 1;
  }
  return process.exitCode || 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
