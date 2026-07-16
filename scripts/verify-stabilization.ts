#!/usr/bin/env node
import { spawn } from "node:child_process";

export type StabilizationCheck = {
  label: string;
  command: string;
  args: string[];
};

export type StabilizationRunner = (check: StabilizationCheck) => Promise<boolean>;

export const stabilizationChecks: StabilizationCheck[] = [
  { label: "typecheck", command: "npm", args: ["run", "typecheck"] },
  { label: "strict engine typecheck", command: "npm", args: ["run", "typecheck:strict:engine"] },
  { label: "engine type-debt gate", command: "npm", args: ["run", "typecheck:type-debt:engine"] },
  { label: "dependency vulnerability gate", command: "npm", args: ["run", "verify:dependency-audit"] },
  { label: "patch integrity gate", command: "npm", args: ["run", "verify:patch-integrity"] },
  { label: "flagship release gate", command: "npm", args: ["run", "verify:release-gate"] },
  { label: "enterprise Redis/HA gate", command: "npm", args: ["run", "verify:enterprise-gate"] },
  { label: "product validation gate", command: "npm", args: ["run", "verify:product-gate"] },
];

const PASS = "\x1b[0;32mPASS\x1b[0m";
const FAIL = "\x1b[0;31mFAIL\x1b[0m";

function commandText(check: StabilizationCheck) {
  return [check.command, ...check.args].join(" ");
}

export function runShellCheck(check: StabilizationCheck) {
  console.log(`\n${check.label}`);
  console.log(`$ ${commandText(check)}`);
  return new Promise<boolean>((resolve) => {
    const child = spawn(check.command, check.args, {
      cwd: process.cwd(),
      stdio: "inherit",
      env: {
        ...process.env,
        CPB_WORKER_DISPATCH_ENABLED: "0",
      },
    });
    child.on("close", (code) => {
      const ok = code === 0;
      console.log(`${ok ? PASS : FAIL} ${check.label}`);
      resolve(ok);
    });
    child.on("error", (error) => {
      console.error(`${FAIL} ${check.label}: ${error.message}`);
      resolve(false);
    });
  });
}

export async function verifyStabilization({
  checks = stabilizationChecks,
  run = runShellCheck,
}: {
  checks?: StabilizationCheck[];
  run?: StabilizationRunner;
} = {}) {
  const results: Array<{ check: StabilizationCheck; ok: boolean }> = [];
  for (const check of checks) {
    const ok = await run(check);
    results.push({ check, ok });
    if (!ok) break;
  }
  return {
    ok: results.every((result) => result.ok) && results.length === checks.length,
    results,
  };
}

async function main() {
  const result = await verifyStabilization();
  if (!result.ok) {
    console.error(`\n${FAIL} Stabilization verification failed.`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n${PASS} Stabilization verification passed.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
