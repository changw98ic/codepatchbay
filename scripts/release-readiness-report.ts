#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { stabilizationChecks } from "./verify-stabilization.js";
import { verifyPatchIntegrityStatus } from "./verify-patch-integrity.js";
import {
  formatProductGateViolations,
  verifyProductGateEvidenceFile,
} from "./verify-product-gate.js";

const PRODUCT_GATE_EVIDENCE_FILE = "docs/product/cpb-flagship-product-validation.json";

function gitStatus(root: string) {
  return execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
  });
}

async function productGateStatus(root: string) {
  const evidencePath = path.resolve(root, PRODUCT_GATE_EVIDENCE_FILE);
  const raw = await readFile(evidencePath, "utf8").catch((error: unknown) => {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (raw === null) {
    return {
      ok: false,
      evidenceFile: PRODUCT_GATE_EVIDENCE_FILE,
      recordCount: 0,
      missingEvidence: true,
      violations: [
        {
          path: PRODUCT_GATE_EVIDENCE_FILE,
          reason: "missing product validation evidence file",
        },
      ],
    };
  }
  let evidence: unknown;
  try {
    evidence = JSON.parse(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      evidenceFile: PRODUCT_GATE_EVIDENCE_FILE,
      recordCount: 0,
      missingEvidence: false,
      violations: [
        {
          path: PRODUCT_GATE_EVIDENCE_FILE,
          reason: `invalid product validation JSON: ${message}`,
        },
      ],
    };
  }
  const result = await verifyProductGateEvidenceFile(evidence, { root });
  return {
    ok: result.ok,
    evidenceFile: PRODUCT_GATE_EVIDENCE_FILE,
    recordCount: result.recordCount,
    supplementalOfficialScoreBundleCount: result.supplementalOfficialScoreBundleCount,
    missingEvidence: false,
    violations: result.violations,
  };
}

export async function buildReleaseReadinessReport({ root = process.cwd() } = {}) {
  const patchIntegrity = verifyPatchIntegrityStatus(gitStatus(root));
  const productGate = await productGateStatus(root);
  const remaining = [];
  if (!patchIntegrity.ok) {
    remaining.push({
      gate: "patch-integrity",
      reason: "untracked implementation files remain outside the reviewed patch",
      files: patchIntegrity.untrackedImplementationFiles,
    });
  }
  if (!productGate.ok) {
    remaining.push({
      gate: "product-gate",
      reason: productGate.missingEvidence
        ? "missing 3 real product validation records (maintainer/team dry-runs or SWE-bench Verified dry-run samples)"
        : "product validation evidence does not satisfy the gate",
      evidenceFile: productGate.evidenceFile,
      violations: productGate.violations,
    });
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    stabilizationCommand: "npm run verify:stabilization",
    stabilizationChecks: stabilizationChecks.map((check) => ({
      label: check.label,
      command: [check.command, ...check.args].join(" "),
    })),
    gates: {
      patchIntegrity: {
        ok: patchIntegrity.ok,
        untrackedImplementationFiles: patchIntegrity.untrackedImplementationFiles,
      },
      productGate,
    },
    ready: remaining.length === 0,
    remaining,
  };
}

async function main() {
  const report = await buildReleaseReadinessReport();
  console.log(JSON.stringify(report, null, 2));
  if (!report.ready) {
    console.error(formatProductGateViolations(report.gates.productGate.violations));
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
