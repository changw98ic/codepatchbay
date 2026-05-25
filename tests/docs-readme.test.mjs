import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function readReadme() {
  return readFile(path.join(repoRoot, "README.md"), "utf8");
}

// --- D42: README Product Repositioning ---

test("D42: README first heading positions as local gateway for coding agents", async () => {
  const readme = await readReadme();
  const firstHeading = readme.match(/^#+\s+.+$/m)?.[0] ?? "";
  assert.match(
    firstHeading,
    /[Ll]ocal\s+gateway|gateway\s+for\s+coding\s+agent/i,
    `First heading "${firstHeading}" does not position as gateway for coding agents`
  );
});

test("D42: README quickstart includes npm install command", async () => {
  const readme = await readReadme();
  assert.match(
    readme,
    /npm\s+i(?:nstall)?\s+-g\s+codepatchbay/,
    "README quickstart must include 'npm i -g codepatchbay'"
  );
});

test("README documents the quick install shell script", async () => {
  const readme = await readReadme();
  assert.match(
    readme,
    /scripts\/install\.sh/,
    "README quickstart should document scripts/install.sh"
  );
  assert.match(
    readme,
    /node.+npm.+git.+gh/s,
    "README quick install docs should list prerequisite detection"
  );
  assert.match(
    readme,
    /gh auth status/,
    "README quick install docs should mention GitHub CLI auth verification"
  );
});

test("D42: README quickstart includes cpb setup", async () => {
  const readme = await readReadme();
  const quickstartBlock = extractQuickstartBlock(readme);
  assert.match(
    quickstartBlock,
    /cpb\s+setup/,
    "README quickstart block must include 'cpb setup'"
  );
});

test("D42: README quickstart includes cpb demo", async () => {
  const readme = await readReadme();
  const quickstartBlock = extractQuickstartBlock(readme);
  assert.match(
    quickstartBlock,
    /cpb\s+demo/,
    "README quickstart block must include 'cpb demo'"
  );
});

test("D42: README quickstart includes cpb init with dot-path", async () => {
  const readme = await readReadme();
  const quickstartBlock = extractQuickstartBlock(readme);
  assert.match(
    quickstartBlock,
    /cpb\s+init\s+\./,
    "README quickstart block must include 'cpb init .'"
  );
});

test("D42: README quickstart includes cpb run", async () => {
  const readme = await readReadme();
  const quickstartBlock = extractQuickstartBlock(readme);
  const hasCpbRun = /\bcpb\s+run\b/.test(quickstartBlock);

  assert.ok(
    hasCpbRun,
    "README quickstart must include 'cpb run'"
  );
});

test("D42: README does not label quickstart commands as upcoming", async () => {
  const readme = await readReadme();
  const quickstartBlock = extractQuickstartBlock(readme);
  assert.doesNotMatch(
    quickstartBlock,
    /\bupcoming\b|\bplanned\b|\bcoming soon\b|\broadmap\b|\bTODO\b/i,
    "README quickstart should contain ready commands only"
  );
});

/**
 * Extract the first fenced code block after a quickstart or getting started heading.
 */
function extractQuickstartBlock(readme) {
  // Find a quickstart/getting-started section heading
  const sectionMatch = readme.match(
    /#{1,3}\s+(?:quick\s*start|getting\s+started)[^\n]*\n([\s\S]*?)(?=\n#{1,3}\s|\n$)/i
  );
  if (!sectionMatch) {
    // Fallback: first 80 lines (covers the top quickstart area)
    return readme.split("\n").slice(0, 80).join("\n");
  }
  return sectionMatch[1];
}
