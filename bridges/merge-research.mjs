#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : null;
}

const codexFile = getArg("codex");
const codexExit = parseInt(getArg("codex-exit") || "1", 10);
const claudeFile = getArg("claude");
const claudeExit = parseInt(getArg("claude-exit") || "1", 10);
const task = getArg("task") || "unknown";
const output = getArg("output");

if (!codexFile || !claudeFile || !output) {
  console.error("Usage: merge-research.mjs --codex <file> --codex-exit <n> --claude <file> --claude-exit <n> --task <str> --output <file>");
  process.exit(1);
}

function readFileSafe(path) {
  try { return readFileSync(path, "utf8").trim(); } catch { return "[read failed]"; }
}

const codexContent = readFileSafe(codexFile);
const claudeContent = readFileSafe(claudeFile);
const codexOk = codexExit === 0;
const claudeOk = claudeExit === 0;

const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

const metadata = {
  ts,
  task,
  codex_ok: codexOk,
  claude_ok: claudeOk,
};

const sections = [];
sections.push(`# Research: ${task}`);
sections.push("");
sections.push("## Metadata");
sections.push("```json");
sections.push(JSON.stringify(metadata, null, 2));
sections.push("```");
sections.push("");

if (codexOk) {
  sections.push("## Codex Analysis");
  sections.push(codexContent);
  sections.push("");
}

if (claudeOk) {
  sections.push("## Claude Analysis");
  sections.push(claudeContent);
  sections.push("");
}

if (!codexOk) {
  sections.push("## Codex Analysis (FAILED)");
  sections.push("Agent failed with exit code " + codexExit);
  sections.push("");
}

if (!claudeOk) {
  sections.push("## Claude Analysis (FAILED)");
  sections.push("Agent failed with exit code " + claudeExit);
  sections.push("");
}

const content = sections.join("\n");

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, content, "utf8");

console.log(`Merged research written to ${output}`);
console.log(`  Codex: ${codexOk ? "ok" : "failed"}`);
console.log(`  Claude: ${claudeOk ? "ok" : "failed"}`);
