#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildProjectCodeIndexSection, buildPlannerPrompt } from "../server/services/prompt-builder.js";
import { registerProject, resolveHubRoot } from "../server/services/hub-registry.js";
import { refreshProjectCodeIndex } from "../server/services/project-code-index.js";

// buildProjectCodeIndexSection returns empty when no project registered
{
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-pbi-cpb-"));
  const section = await buildProjectCodeIndexSection(cpbRoot, "nonexistent");
  assert.equal(section, "", "empty when no project registered");
  await rm(cpbRoot, { recursive: true, force: true });
}

// buildProjectCodeIndexSection returns summary when index is ready
{
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-pbi-cpb2-"));
  const hubRoot = resolveHubRoot(cpbRoot);
  const repoRoot = await mkdtemp(path.join(tmpdir(), "cpb-pbi-repo-"));
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  await writeFile(path.join(repoRoot, "package.json"), JSON.stringify({
    name: "pbi-test",
    scripts: { test: "node --test", build: "echo build", lint: "eslint ." },
  }, null, 2));
  await writeFile(path.join(repoRoot, "src", "app.js"), "export function run() {}\n");

  await registerProject(hubRoot, { id: "pbi-test", sourcePath: repoRoot });
  const project = await (await import("../server/services/hub-registry.js")).getProject(hubRoot, "pbi-test");
  await refreshProjectCodeIndex(project, { hubRoot });

  const origHubRoot = process.env.CPB_HUB_ROOT;
  process.env.CPB_HUB_ROOT = hubRoot;

  const section = await buildProjectCodeIndexSection(cpbRoot, "pbi-test");
  assert.ok(section.includes("## Project Code Index"), "has section header");
  assert.ok(section.includes("pbi-test"), "mentions project");
  assert.ok(section.includes("Commands") || section.includes("command"), "mentions commands");
  assert.ok(!section.includes("function run"), "does not include source file contents");

  // Also check buildPlannerPrompt includes the index section
  const executorRoot = cpbRoot;
  const wikiDir = path.join(cpbRoot, "wiki", "projects", "pbi-test");
  await mkdir(path.join(wikiDir, "inbox"), { recursive: true });
  await mkdir(path.join(wikiDir, "outputs"), { recursive: true });
  await mkdir(path.join(executorRoot, "profiles", "planner", "skills"), { recursive: true });
  await mkdir(path.join(executorRoot, "wiki", "system"), { recursive: true });
  await mkdir(path.join(executorRoot, "templates", "handoff"), { recursive: true });
  await writeFile(path.join(wikiDir, "context.md"), "# pbi-test\nTest project");
  await writeFile(path.join(wikiDir, "decisions.md"), "# Decisions");
  await writeFile(path.join(executorRoot, "wiki", "system", "handshake-protocol.md"), "# Handshake");
  await writeFile(path.join(executorRoot, "templates", "handoff", "plan-to-execute.md"), "# Template");

  const planFile = path.join(wikiDir, "inbox", "plan-999.md");
  const prompt = await buildPlannerPrompt(executorRoot, cpbRoot, "pbi-test", "Add feature X", planFile);
  assert.ok(prompt.includes("## Project Code Index"), "planner prompt has index section");
  assert.ok(prompt.includes("pbi-test"), "planner prompt mentions project");

  if (origHubRoot !== undefined) process.env.CPB_HUB_ROOT = origHubRoot;
  else delete process.env.CPB_HUB_ROOT;

  await rm(cpbRoot, { recursive: true, force: true });
  await rm(repoRoot, { recursive: true, force: true });
}

console.log("All prompt-builder-index tests passed.");
