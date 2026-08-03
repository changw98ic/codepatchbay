import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { run as runCodeIndexCommand } from "../cli/commands/code-index.js";
import { verifyDocsContract } from "../scripts/verify-docs-contract.js";
import { syncRepositoryCommandDocs } from "../scripts/sync-repository-command-docs.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

test("repository documentation matches current scripts and CLI syntax", async () => {
  assert.deepEqual(await verifyDocsContract(REPO_ROOT), { ok: true, violations: [] });
  assert.deepEqual(await syncRepositoryCommandDocs({ root: REPO_ROOT, check: true }), {
    ok: true,
    changed: [],
    violations: [],
  });
});

test("code-index syntax-only mode validates without reading or changing an index", async () => {
  const missingSource = path.join(os.tmpdir(), "cpb-docs-contract-missing-source");
  const examples = [
    ["build", "-s", missingSource, "--json"],
    ["status", "-s", missingSource, "--json"],
    ["query", "definitions", "--symbol", "runJob", "-s", missingSource, "--json"],
    ["query", "references", "--symbol", "runJob", "-s", missingSource, "--json"],
    ["query", "inventory", "-s", missingSource, "--json"],
    ["evidence", "-s", missingSource, "-t", "runJob", "--json"],
    ["gc", "-s", missingSource, "--json"],
  ];

  for (const args of examples) {
    assert.equal(await runCodeIndexCommand([...args, "--syntax-only"]), 0, args.join(" "));
  }
});
