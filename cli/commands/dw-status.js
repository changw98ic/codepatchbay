/**
 * cpb dw-status — report Dynamic Workflow Strict Completion readiness.
 *
 * Checks that all DW subsystem modules exist, export the expected symbols,
 * and that the phase policy / completion gate / adversarial pipeline are
 * wired correctly.
 *
 * @module cli/commands/dw-status
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFile } from "node:fs/promises";

const CYAN = "\x1b[0;36m";
const GREEN = "\x1b[0;32m";
const RED = "\x1b[0;31m";
const BOLD = "\x1b[1m";
const NC = "\x1b[0m";

/**
 * Attempt to import a module and check that it exports the named symbols.
 *
 * @param {string} modPath — absolute path to the module
 * @param {string[]} expectedExports — export names to verify
 * @returns {Promise<{ ok: boolean, missing: string[], error?: string }>}
 */
async function checkModuleExports(modPath, expectedExports) {
  try {
    const mod = await import(modPath);
    const missing = expectedExports.filter((name) => typeof mod[name] !== "function" && mod[name] == null);
    return { ok: missing.length === 0, missing };
  } catch (err) {
    return { ok: false, missing: expectedExports, error: err.message };
  }
}

/**
 * Check that a source file contains a specific string pattern.
 *
 * @param {string} filePath — absolute path
 * @param {string} pattern — string to search for
 * @returns {Promise<boolean>}
 */
async function fileContains(filePath, pattern) {
  try {
    const src = await readFile(filePath, "utf8");
    return src.includes(pattern);
  } catch {
    return false;
  }
}

/**
 * Run the DW status check.
 *
 * @param {string[]} args
 * @param {{ cpbRoot?: string, executorRoot?: string }} opts
 * @returns {Promise<number>} exit code (0 = ready, 1 = incomplete)
 */
export async function run(args, { cpbRoot, executorRoot } = {}) {
  const root = executorRoot || cpbRoot || ".";
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const coreBase = path.resolve(root, "core");

  // Parallel checks — all module existence + export verification
  const [
    phasePolicy,
    completionGate,
    dagBuilder,
    scopeGuard,
    adversarialVerify,
    dynamicAgentPlan,
    dwAcceptance,
    verifyVerdict,
    reviewBundleDwFields,
    // Wiring checks
    runJobUsesPhasePolicy,
    runJobUsesCompletionGate,
    runJobUsesScopeGuardBlock,
    runJobPassesDagToValidation,
  ] = await Promise.all([
    checkModuleExports(
      path.join(coreBase, "engine", "phase-policy.js"),
      ["resolveSemanticPhases"],
    ),
    checkModuleExports(
      path.join(coreBase, "engine", "completion-gate.js"),
      ["evaluateCompletionGate"],
    ),
    checkModuleExports(
      path.join(coreBase, "engine", "dag-builder.js"),
      ["buildWorkflowDag"],
    ),
    checkModuleExports(
      path.join(coreBase, "engine", "scope-guard.js"),
      ["validateScopeConstraint"],
    ),
    checkModuleExports(
      path.join(coreBase, "phases", "adversarial_verify.js"),
      ["runAdversarialVerify"],
    ),
    checkModuleExports(
      path.join(coreBase, "agents", "dynamic-agent-plan.js"),
      ["validateDynamicAgentPlan"],
    ),
    checkModuleExports(
      path.join(coreBase, "engine", "dw-acceptance.js"),
      ["evaluateDwAcceptance"],
    ),
    fileContains(
      path.join(coreBase, "phases", "verify.js"),
      "VERDICT:",
    ),
    fileContains(
      path.join(root, "server", "services", "review-bundle.js"),
      "dynamicAgentPlan",
    ),
    // Wiring: run-job.js must import resolveSemanticPhases from phase-policy
    fileContains(
      path.join(coreBase, "engine", "run-job.js"),
      'resolveSemanticPhases',
    ),
    // Wiring: run-job.js must call evaluateCompletionGate
    fileContains(
      path.join(coreBase, "engine", "run-job.js"),
      "evaluateCompletionGate",
    ),
    // Wiring: run-job.js must fail job on scope guard violation (failJob in the same block)
    fileContains(
      path.join(coreBase, "engine", "run-job.js"),
      "scope_guard_violation",
    ) && fileContains(
      path.join(coreBase, "engine", "run-job.js"),
      "scope guard violation: changed files outside fix_scope",
    ),
    // Wiring: run-job.js must pass workflowDag to validateDynamicAgentPlan
    fileContains(
      path.join(coreBase, "engine", "run-job.js"),
      "validateDynamicAgentPlan(dynamicAgentPlan, workflowDag)",
    ),
  ]);

  // Derive boolean results
  const phasePolicyOk = phasePolicy.ok;
  const completionGateOk = completionGate.ok;
  const adversarialOk = adversarialVerify.ok;
  const dagBuilderOk = dagBuilder.ok;
  const dynamicPlanOk = dynamicAgentPlan.ok && dynamicAgentPlan.ok;
  const scopeGuardOk = scopeGuard.ok;
  const reviewBundleOk = reviewBundleDwFields;
  const verdictFormatOk = verifyVerdict;
  const dwAcceptanceOk = dwAcceptance.ok;
  const wiringPhasePolicyOk = runJobUsesPhasePolicy;
  const wiringCompletionGateOk = runJobUsesCompletionGate;
  const wiringScopeGuardOk = runJobUsesScopeGuardBlock;
  const wiringDagValidationOk = runJobPassesDagToValidation;

  // Print summary table
  console.log(`${BOLD}DW Strict Completion Status${NC}`);
  console.log("═".repeat(50));
  console.log(`  Phase Policy (light=execute+verify) : ${phasePolicyOk ? `${GREEN}✓${NC}` : `${RED}✗${NC}`}`);
  if (!phasePolicyOk && phasePolicy.error) console.log(`    ↳ ${RED}${phasePolicy.error}${NC}`);

  console.log(`  Completion Gate                     : ${completionGateOk ? `${GREEN}✓${NC}` : `${RED}✗${NC}`}`);
  if (!completionGateOk && completionGate.error) console.log(`    ↳ ${RED}${completionGate.error}${NC}`);

  console.log(`  Adversarial Verify                  : ${adversarialOk ? `${GREEN}✓${NC}` : `${RED}✗${NC}`}`);
  if (!adversarialOk && adversarialVerify.error) console.log(`    ↳ ${RED}${adversarialVerify.error}${NC}`);

  console.log(`  DAG Builder                         : ${dagBuilderOk ? `${GREEN}✓${NC}` : `${RED}✗${NC}`}`);
  if (!dagBuilderOk && dagBuilder.error) console.log(`    ↳ ${RED}${dagBuilder.error}${NC}`);

  console.log(`  Dynamic Agent Plan                  : ${dynamicPlanOk ? `${GREEN}✓${NC}` : `${RED}✗${NC}`}`);
  if (!dynamicPlanOk && dynamicAgentPlan.error) console.log(`    ↳ ${RED}${dynamicAgentPlan.error}${NC}`);

  console.log(`  Scope Guard                         : ${scopeGuardOk ? `${GREEN}✓${NC}` : `${RED}✗${NC}`}`);
  if (!scopeGuardOk && scopeGuard.error) console.log(`    ↳ ${RED}${scopeGuard.error}${NC}`);

  console.log(`  Review Bundle DW Fields             : ${reviewBundleOk ? `${GREEN}✓${NC}` : `${RED}✗${NC}`}`);
  console.log(`  Verdict Format (VERDICT: line)      : ${verdictFormatOk ? `${GREEN}✓${NC}` : `${RED}✗${NC}`}`);
  console.log(`  DW Acceptance Harness               : ${dwAcceptanceOk ? `${GREEN}✓${NC}` : `${RED}✗${NC}`}`);

  // Wiring checks
  console.log(`  Wiring: run-job uses phase-policy   : ${wiringPhasePolicyOk ? `${GREEN}✓${NC}` : `${RED}✗${NC}`}`);
  console.log(`  Wiring: run-job calls completion gate: ${wiringCompletionGateOk ? `${GREEN}✓${NC}` : `${RED}✗${NC}`}`);
  console.log(`  Wiring: scope guard blocks on violation: ${wiringScopeGuardOk ? `${GREEN}✓${NC}` : `${RED}✗${NC}`}`);
  console.log(`  Wiring: DAG passed to plan validation: ${wiringDagValidationOk ? `${GREEN}✓${NC}` : `${RED}✗${NC}`}`);

  const allOk = [
    phasePolicyOk,
    completionGateOk,
    adversarialOk,
    dagBuilderOk,
    dynamicPlanOk,
    scopeGuardOk,
    reviewBundleOk,
    verdictFormatOk,
    dwAcceptanceOk,
    wiringPhasePolicyOk,
    wiringCompletionGateOk,
    wiringScopeGuardOk,
    wiringDagValidationOk,
  ].every(Boolean);

  const allChecks = [phasePolicyOk, completionGateOk, adversarialOk, dagBuilderOk, dynamicPlanOk, scopeGuardOk, reviewBundleOk, verdictFormatOk, dwAcceptanceOk, wiringPhasePolicyOk, wiringCompletionGateOk, wiringScopeGuardOk, wiringDagValidationOk];
  const passCount = allChecks.filter(Boolean).length;
  const total = allChecks.length;

  console.log("─".repeat(50));
  console.log(`  ${BOLD}Score: ${passCount}/${total}${NC}`);
  console.log(`  ${BOLD}Overall: ${allOk ? `${GREEN}DW READY${NC}` : `${RED}INCOMPLETE${NC}`}${NC}`);

  return allOk ? 0 : 1;
}
