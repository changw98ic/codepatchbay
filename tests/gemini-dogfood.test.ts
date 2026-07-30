/**
 * Task B5 — gemini dogfood (RFC §6.5 / plan §B5).
 *
 * Goal: prove that onboarding a *third* provider family required NO source
 * changes to the registry mechanism. Dropping `core/agents/descriptors/gemini.json`
 * must be sufficient for the family to register, resolve a provider family,
 * declare HOME-inherited auth, and route — none of the refactored .ts paths
 * (`registry.ts` / `outcome-routing.ts` / `isolation.ts` / `agent-runner.ts` /
 * `dynamic-agent-plan.ts` / `routing.ts` / `high-assurance.ts` /
 * `provider-handoff.ts` / `phase-retry.ts`) may mention "gemini" by literal.
 *
 * If no real `gemini-acp` binary is installed, the registry-mechanism
 * assertions below still prove the onboarding path; the live binary is an
 * orthogonal "nice to have" (RFC §7 risk table).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  loadRegistry,
  hasAgent,
  getCapability,
  isBuiltinDescriptor,
} from "../core/agents/registry.js";
import { providerFamilyFor } from "../core/agents/outcome-routing.js";

// Compiled tests live at dist-tests/tests/, so `../..` resolves to the repo
// root that holds the source `core/` tree (matches tests/helpers/boundary-scanner.ts).
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const CORE_DIR = path.join(REPO_ROOT, "core");

/**
 * Literal (case-sensitive) grep over the core TypeScript sources. The
 * descriptors directory (JSON) is excluded — those files ARE the data-driven
 * onboarding surface, so the dogfood permits "gemini" there by construction.
 * Returns one `relpath:line:match` entry per hit.
 */
function grepCoreTs(literal: string, { excludeDirs = [] }: { excludeDirs?: string[] } = {}): string[] {
  const args = ["-rn", "--include=*.ts", "-e", literal, CORE_DIR];
  for (const dir of excludeDirs) args.push(`--exclude-dir=${dir}`);
  const result = spawnSync("grep", args, { encoding: "utf8" });
  // grep exit 1 = "no matches", which is success for our assertion; >1 = error.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`grep exited ${result.status}: ${result.stderr || "(no stderr)"}`);
  }
  return (result.stdout || "").split("\n").filter(Boolean);
}

test("B5 (a): gemini registers from descriptor alone — loadRegistry has it", async () => {
  await loadRegistry("");
  assert.equal(hasAgent("gemini"), true);
  // Loaded from the shipped descriptors dir → trusted builtin (§6.2 source
  // allowlist does not gate its $HOME/.gemini/auth.json inherit entry).
  assert.equal(isBuiltinDescriptor("gemini"), true);
});

test("B5 (b): providerFamilyFor(gemini) === 'gemini' — a NEW family, not unclassified/null", async () => {
  await loadRegistry("");
  // Reads descriptor.providerFamily via the registry path (B2a), not the
  // legacy regex — "gemini" would otherwise fall through to the generic
  // key/name fallback, not resolve to a distinct family.
  assert.equal(providerFamilyFor("gemini"), "gemini");
  assert.notEqual(providerFamilyFor("gemini"), "codex");
  assert.notEqual(providerFamilyFor("gemini"), "claude");
});

test("B5 (c): getCapability(gemini) exposes non-empty inheritFiles + declared policy", async () => {
  await loadRegistry("");
  const cap = getCapability("gemini");
  assert.ok(cap, "expected a capability projection for gemini");
  assert.ok(
    cap.inheritFiles.length > 0,
    "expected at least one inheritFiles entry (HOME inheritance is descriptor-driven)",
  );
  // The descriptor-declared capability fields surface verbatim.
  assert.equal(cap.providerFamily, "gemini");
  assert.equal(cap.tieBreakPriority, 60);
  assert.equal(cap.sandboxPolicy, "cpb-required");
  assert.equal(cap.quarantineFiles.length, 0);
});

test("B5 (d): zero 'gemini' literals in any registry-mechanism .ts path", async () => {
  // The selection / isolation / inherit / family-resolution files that Phase B
  // refactored to read descriptor data instead of `==="codex"` / `==="claude"`.
  // Onboarding a third family via a descriptor must not require teaching any of
  // these about "gemini" by name.
  const mechanismFiles = [
    "core/agents/registry.ts",
    "core/agents/outcome-routing.ts",
    "core/agents/isolation.ts",
    "core/agents/agent-runner.ts",
    "core/agents/dynamic-agent-plan.ts",
    "core/agents/routing.ts",
    "core/policy/high-assurance.ts",
    "core/engine/provider-handoff.ts",
    "core/engine/phase-retry.ts",
  ];
  for (const rel of mechanismFiles) {
    const abs = path.join(REPO_ROOT, rel);
    const r = spawnSync("grep", ["-n", "-e", "gemini", abs], { encoding: "utf8" });
    assert.equal(
      r.status,
      1,
      `${rel} must not mention "gemini" by literal; grep output:\n${r.stdout || "(none)"}`,
    );
  }
});

test("B5 (d) broad: the only 'gemini' in core/**/*.ts is the pre-existing child-env credential allowlist", () => {
  // Dogfood assertion: onboarding gemini required no NEW source edits anywhere
  // under core/. The single tolerated hit is the agent-name-keyed credential
  // pass-through DATA table in core/policy/child-env.ts
  // (`PROVIDER_CREDENTIALS_BY_AGENT`), which:
  //   (1) is keyed data, not a routing/isolation/inherit decision branch;
  //   (2) predates the Phase B registry refactor (the `["gemini", ...]` row is
  //       unchanged vs main — confirmed via `git diff main`); and
  //   (3) is outside Phase B's refactor scope (it is the env-var allowlist,
  //       not a `==="codex"`/`==="claude"` selection path).
  const matches = grepCoreTs("gemini");
  // Tolerate exactly the known child-env.ts credential-allowlist row.
  const novel = matches.filter((line) => {
    const rel = path.relative(CORE_DIR, line.split(":")[0]!);
    if (rel !== "policy/child-env.ts") return true;
    // Inside child-env.ts, only the PROVIDER_CREDENTIALS_BY_AGENT data row is
    // allowed (`["gemini", GEMINI_COMPATIBLE_CREDENTIALS]`).
    return !/\["gemini",\s*GEMINI_COMPATIBLE_CREDENTIALS\]/.test(line);
  });
  assert.equal(
    novel.length,
    0,
    `unexpected NEW "gemini" source mention(s) under core/ — onboarding should be descriptor-only:\n${
      novel.join("\n") || "(none)"
    }`,
  );
});
