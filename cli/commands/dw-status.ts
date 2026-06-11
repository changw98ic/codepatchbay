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
import { existsSync } from "node:fs";
import { collectRuntimeHealth } from "../../server/services/runtime-health.js";

const CYAN = "\x1b[0;36m";
const GREEN = "\x1b[0;32m";
const YELLOW = "\x1b[1;33m";
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

async function checkModuleContract(modPath, exportName, predicate) {
  try {
    const mod = await import(modPath);
    if (typeof mod[exportName] !== "function") {
      return { ok: false, missing: [exportName], error: `missing export: ${exportName}` };
    }
    const details = mod[exportName]();
    return { ok: Boolean(predicate(details)), missing: [], details };
  } catch (err) {
    return { ok: false, missing: [exportName], error: err.message };
  }
}

function resolveCompiledRoot(root, __dirname) {
  const absRoot = path.resolve(root);
  const candidate = path.join(absRoot, "core", "engine", "phase-policy.js");
  if (existsSync(candidate)) return absRoot;

  const distCandidate = path.join(absRoot, "dist", "core", "engine", "phase-policy.js");
  if (existsSync(distCandidate)) return path.join(absRoot, "dist");

  const commandDistRoot = path.resolve(__dirname, "..", "..");
  const commandCandidate = path.join(commandDistRoot, "core", "engine", "phase-policy.js");
  if (existsSync(commandCandidate)) return commandDistRoot;

  return absRoot;
}

/**
 * Run the DW status check.
 *
 * @param {string[]} args
 * @param {{ cpbRoot?: string, executorRoot?: string }} opts
 * @returns {Promise<number>} exit code (0 = ready, 1 = incomplete)
 */
export async function run(args, { cpbRoot, executorRoot }: Record<string, any> = {}) {
  const root = executorRoot || cpbRoot || ".";
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const contractRoot = resolveCompiledRoot(root, __dirname);
  const coreBase = path.join(contractRoot, "core");
  const runtimeHealth = await collectRuntimeHealth({ cpbRoot: cpbRoot || root, executorRoot: root });

  // Parallel checks — all module existence + export verification
  const [
    phasePolicy,
    completionGate,
    dagBuilder,
    dagExecutor,
    scopeGuard,
    adversarialVerify,
    dynamicAgentPlan,
    dwAcceptance,
    verifyVerdictContract,
    reviewBundleDwContract,
    runJobExecutionContract,
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
      path.join(coreBase, "workflow", "dag-executor.js"),
      ["deriveDagResumeState", "readyNodes"],
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
    checkModuleContract(
      path.join(coreBase, "phases", "verify.js"),
      "verifyPhaseOutputContract",
      (contract) => contract?.verdictLinePrefix === "VERDICT:",
    ),
    checkModuleContract(
      path.join(contractRoot, "server", "services", "review-bundle.js"),
      "reviewBundleDwContract",
      (contract) => contract?.includesDynamicAgentPlan === true &&
        contract?.includesWorkflowDag === true &&
        contract?.includesCompletionGate === true,
    ),
    checkModuleContract(
      path.join(coreBase, "engine", "run-job.js"),
      "runJobExecutionContract",
      (contract) => contract?.usesPhasePolicy === true &&
        contract?.callsCompletionGate === true &&
        contract?.scopeGuardBlocksOnViolation === true &&
        contract?.passesDagToPlanValidation === true &&
        contract?.dagNodeFirstSequentialReady === true &&
        contract?.dagParallelExecutionReady === false,
    ),
  ]);

  // Derive boolean results
  const phasePolicyOk = phasePolicy.ok;
  const completionGateOk = completionGate.ok;
  const adversarialOk = adversarialVerify.ok;
  const dagBuilderOk = dagBuilder.ok;
  const dagMetadataReady = dagBuilderOk;
  const dagResumeReady = dagExecutor.ok;
  const dagNodeFirstSequentialReady = runJobExecutionContract.details?.dagNodeFirstSequentialReady === true;
  const dagParallelExecutionReady = false;
  const dynamicPlanOk = dynamicAgentPlan.ok && dynamicAgentPlan.ok;
  const scopeGuardOk = scopeGuard.ok;
  const reviewBundleOk = reviewBundleDwContract.ok;
  const verdictFormatOk = verifyVerdictContract.ok;
  const dwAcceptanceOk = dwAcceptance.ok;
  const wiringPhasePolicyOk = runJobExecutionContract.details?.usesPhasePolicy === true;
  const wiringCompletionGateOk = runJobExecutionContract.details?.callsCompletionGate === true;
  const wiringScopeGuardOk = runJobExecutionContract.details?.scopeGuardBlocksOnViolation === true;
  const wiringDagValidationOk = runJobExecutionContract.details?.passesDagToPlanValidation === true;
  const runJobDoesNotClaimDagParallelReady = runJobExecutionContract.details?.dagParallelExecutionReady === false;

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
  console.log("");
  console.log(`${BOLD}DAG Readiness${NC}`);
  console.log(`  dag_metadata_ready                  : ${dagMetadataReady ? "true" : "false"}`);
  console.log(`  dag_node_first_sequential_ready     : ${dagNodeFirstSequentialReady ? "true" : "false"}`);
  console.log(`  dag_resume_ready                    : ${dagResumeReady ? "true" : "false"}`);
  console.log(`  dag_parallel_execution_ready        : ${dagParallelExecutionReady ? "true" : "false"}`);
  console.log(`  DAG Metadata Ready                  : ${dagMetadataReady ? `${GREEN}✓${NC}` : `${RED}✗${NC}`}`);
  console.log(`  DAG Resume Ready                    : ${dagResumeReady ? `${GREEN}✓${NC}` : `${RED}✗${NC}`}`);
  if (!dagResumeReady && dagExecutor.error) console.log(`    ↳ ${RED}${dagExecutor.error}${NC}`);
  console.log(`  DAG Node-First Sequential Ready     : ${dagNodeFirstSequentialReady ? `${GREEN}✓${NC}` : `${RED}✗${NC}`}`);
  console.log(`  DAG Parallel Execution Ready        : ${dagParallelExecutionReady ? `${GREEN}✓${NC}` : `${YELLOW}not ready${NC} (sequential boundary only)`}`);
  console.log("");

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
  console.log("");
  console.log(`${BOLD}Runtime Health Gate${NC}`);
  console.log(`  Source Version                      : ${runtimeHealth.sourceVersion || "unknown"}`);
  console.log(`  Active Release Version              : ${runtimeHealth.activeReleaseVersion || "unknown"}`);
  console.log(`  Launcher Release Version            : ${runtimeHealth.launcherReleaseVersion || "unknown"}`);
  console.log(`  Initialized                         : ${runtimeHealth.initialized ? `${GREEN}✓${NC}` : `${YELLOW}warning${NC}`}`);
  console.log(`  Hub Orchestrator                    : ${runtimeHealth.hubOrchestratorStatus || "unknown"}`);
  console.log(`  Queue: codegraph_unavailable        : ${runtimeHealth.queueBlockingCounts.codegraph_unavailable}`);
  console.log(`  Queue: agent_rate_limited           : ${runtimeHealth.queueBlockingCounts.agent_rate_limited}`);
  console.log(`  Stale Jobs                          : ${runtimeHealth.staleJobs}`);
  console.log(`  Jobs Index Divergence               : ${runtimeHealth.jobsIndexDivergence.count} (${runtimeHealth.jobsIndexDivergence.severity})`);
  for (const blocker of runtimeHealth.blockers) {
    console.log(`    ${RED}BLOCKER:${NC} ${blocker.code} — ${blocker.message}`);
  }
  for (const warning of runtimeHealth.warnings) {
    console.log(`    ${YELLOW}WARN:${NC} ${warning.code} — ${warning.message}`);
  }

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
    dagResumeReady,
    dagNodeFirstSequentialReady,
    runJobDoesNotClaimDagParallelReady,
    runtimeHealth.ok,
  ].every(Boolean);

  const allChecks = [phasePolicyOk, completionGateOk, adversarialOk, dagBuilderOk, dagResumeReady, dagNodeFirstSequentialReady, runJobDoesNotClaimDagParallelReady, dynamicPlanOk, scopeGuardOk, reviewBundleOk, verdictFormatOk, dwAcceptanceOk, wiringPhasePolicyOk, wiringCompletionGateOk, wiringScopeGuardOk, wiringDagValidationOk, runtimeHealth.ok];
  const passCount = allChecks.filter(Boolean).length;
  const total = allChecks.length;

  console.log("─".repeat(50));
  console.log(`  ${BOLD}Score: ${passCount}/${total}${NC}`);
  console.log(`  ${BOLD}Overall: ${allOk ? `${GREEN}DW READY${NC}` : `${RED}INCOMPLETE${NC}`}${NC}`);

  return allOk ? 0 : 1;
}
