/**
 * Local Code Index v2 — evidence rendering for assurance packs.
 *
 * Provides:
 *   1. Task-symbol candidate extraction from task descriptions.
 *   2. Evidence rendering from v2 query results (not parsed manifests).
 *   3. Bounded evidence pack for assurance (maxChars cap + truncation marker).
 *   4. Related-file score evidence formatting.
 *
 * Migrated from core/indexing/local-code-index-snapshot.ts to consume
 * LocalCodeIndexQueryResult from contracts.ts instead of v1 snapshot shapes.
 *
 * Spec: docs/architecture/local-code-index-v2-spec.md
 */

import type {
  LocalCodeIndexQueryResult,
  SymbolOccurrence,
  FileRelationship,
  LocalCodeIndexCoverageSummary,
} from "./contracts.js";

// ── Task-symbol candidate extraction ─────────────────────────────────────────

/** Minimum identifier length to be considered a valid symbol candidate. */
const MIN_SYMBOL_LENGTH = 3;

/** Maximum number of symbol candidates to extract from a task description. */
const MAX_SYMBOL_CANDIDATES = 5;

/**
 * Extract plausible code-symbol candidates from a free-text task description.
 *
 * Extraction rules (preserved from v1 characterization tests):
 *   1. Backtick-quoted identifiers: `buildIndex` -> "buildIndex"
 *   2. Function-call syntax: parseConfig() -> "parseConfig"
 *   3. Single/double-char identifiers are excluded (MIN_SYMBOL_LENGTH = 3)
 *   4. Results are deduplicated and capped at MAX_SYMBOL_CANDIDATES
 *
 * Note: bare camelCase identifiers without call syntax or backticks are
 * NOT extracted (v1 characterization test constraint).
 */
export function taskSymbolCandidates(task: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  function push(candidate: string) {
    const trimmed = candidate.trim();
    if (
      trimmed.length >= MIN_SYMBOL_LENGTH &&
      /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(trimmed) &&
      !seen.has(trimmed)
    ) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }

  // 1. Backtick-quoted identifiers
  for (const match of task.matchAll(/`([a-zA-Z_$][a-zA-Z0-9_$]*)`/g)) {
    if (result.length >= MAX_SYMBOL_CANDIDATES) break;
    push(match[1]);
  }

  // 2. Function-call syntax: identifier followed by ()
  for (const match of task.matchAll(/([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g)) {
    if (result.length >= MAX_SYMBOL_CANDIDATES) break;
    push(match[1]);
  }

  return result;
}

// ── Definition lookup from query results ─────────────────────────────────────

/**
 * Find files that contain an exact definition of the given symbol,
 * using v2 "definitions" query results.
 *
 * Returns an array of file paths where the symbol is defined.
 * Migrated from v1 exactSymbolFiles which searched a snapshot's file list.
 */
export function exactSymbolFilesFromQuery(
  queryResult: LocalCodeIndexQueryResult,
  symbol: string,
): string[] {
  if (queryResult.kind !== "definitions") return [];
  const lower = symbol.toLowerCase();
  const paths = new Set<string>();
  for (const occ of queryResult.occurrences) {
    if (occ.role === "definition" && occ.symbol.toLowerCase() === lower) {
      paths.add(occ.path);
    }
  }
  return [...paths];
}

// ── Bounded evidence pack rendering ──────────────────────────────────────────

const DEFAULT_EVIDENCE_MAX_CHARS = 32_000;

/**
 * Render a bounded evidence pack from v2 query results.
 *
 * Accepts a partial record of query results keyed by kind. Callers fetch
 * the queries they need (definitions, related-files, inventory) and pass
 * them in. The renderer produces structured text for the assurance prompt.
 *
 * Sections:
 *   - Symbol definitions (from "definitions" result)
 *   - File inventory (from "inventory" result)
 *   - Related files with scores (from "related-files" result)
 *   - Coverage summary (from any available result)
 *
 * The output is capped at maxChars with a truncation marker when exceeded.
 *
 * Migrated from v1 buildLocalCodeIndexEvidence which consumed parsed
 * manifest data. This version consumes typed LocalCodeIndexQueryResult.
 */
export function buildLocalCodeIndexEvidence(
  queryResults: Readonly<Record<string, LocalCodeIndexQueryResult>>,
  task: string,
  maxChars: number = DEFAULT_EVIDENCE_MAX_CHARS,
): string {
  const sections: string[] = [];

  // ── Header ──
  const snapshotId = findSnapshotId(queryResults);
  sections.push(
    `Local code index evidence (v2)` +
    (snapshotId ? ` [snapshot: ${snapshotId}]` : ""),
  );
  sections.push(`Task: ${task}`);
  sections.push("");

  // ── Symbol definitions ──
  const definitionsResult = queryResults.definitions;
  if (definitionsResult && definitionsResult.kind === "definitions") {
    const byFile = new Map<string, SymbolOccurrence[]>();
    for (const occ of definitionsResult.occurrences) {
      if (occ.role !== "definition") continue;
      const list = byFile.get(occ.path) ?? [];
      list.push(occ);
      byFile.set(occ.path, list);
    }
    if (byFile.size > 0) {
      sections.push("## Symbol definitions");
      for (const [filePath, occurrences] of byFile) {
        const symbolNames = occurrences.map((o) => `${o.symbol} (${o.kind})`).join(", ");
        sections.push(`  ${filePath}: ${symbolNames}`);
      }
      if (definitionsResult.truncated) {
        sections.push("  [definitions truncated]");
      }
      sections.push("");
    }
  }

  // ── File inventory ──
  const inventoryResult = queryResults.inventory;
  if (inventoryResult && inventoryResult.kind === "inventory") {
    sections.push(`## File inventory (${inventoryResult.files.length} files)`);
    for (const file of inventoryResult.files) {
      sections.push(`  ${file.path} [${file.language}, ${file.size}B, ${file.coverage}]`);
    }
    if (inventoryResult.truncated) {
      sections.push("  [inventory truncated]");
    }
    sections.push("");
  }

  // ── Related files with scores ──
  const relatedResult = queryResults["related-files"];
  if (relatedResult && relatedResult.kind === "related-files") {
    sections.push("## Related files");
    for (const file of relatedResult.files) {
      sections.push(`  ${file.path} (score: ${file.score.toFixed(2)})`);
      for (const rel of file.evidence) {
        sections.push(`    -> ${rel.fromPath} ${rel.type} ${rel.toPath} (weight: ${rel.weight})`);
      }
    }
    if (relatedResult.truncated) {
      sections.push("  [related files truncated]");
    }
    sections.push("");
  }

  // ── Coverage summary ──
  const coverage = findCoverage(queryResults);
  if (coverage) {
    sections.push(
      `## Coverage: ${coverage.effective} (partial=${coverage.partial}, ` +
      `failedFiles=${coverage.failedFiles}, oversizedFiles=${coverage.oversizedFiles})`,
    );
    sections.push("");
  }

  // ── Empty fallback ──
  if (sections.length <= 3) {
    return "No relevant local code index evidence found for this task.";
  }

  // ── Bounded output ──
  let result = sections.join("\n");
  if (result.length > maxChars) {
    result = result.slice(0, maxChars) +
      `\n\n[Local code index evidence truncated at ${maxChars} chars; original length: ${result.length}]`;
  }
  return result;
}

// ── Related-file score evidence formatting ───────────────────────────────────

/**
 * Format related-file scores from a v2 "related-files" query result
 * into human-readable evidence strings.
 *
 * Each entry shows the file path, its relevance score, and the
 * relationship evidence chain (imports, references).
 */
export function formatRelatedFileScores(
  queryResult: LocalCodeIndexQueryResult,
): string[] {
  if (queryResult.kind !== "related-files") return [];
  const lines: string[] = [];
  for (const file of queryResult.files) {
    const parts: string[] = [`${file.path} (score: ${file.score.toFixed(2)})`];
    for (const rel of file.evidence) {
      parts.push(formatRelationship(rel));
    }
    lines.push(parts.join(" <- "));
  }
  return lines;
}

function formatRelationship(rel: FileRelationship): string {
  const symbolPart = rel.symbol ? ` "${rel.symbol}"` : "";
  return `${rel.fromPath} --[${rel.type}${symbolPart}]--> ${rel.toPath} (w=${rel.weight})`;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function findSnapshotId(
  queryResults: Readonly<Record<string, LocalCodeIndexQueryResult>>,
): string | null {
  for (const result of Object.values(queryResults)) {
    if (result && typeof result === "object" && "snapshotId" in result) {
      return (result as { snapshotId: string }).snapshotId ?? null;
    }
  }
  return null;
}

function findCoverage(
  queryResults: Readonly<Record<string, LocalCodeIndexQueryResult>>,
): LocalCodeIndexCoverageSummary | null {
  for (const result of Object.values(queryResults)) {
    if (result && typeof result === "object" && "coverage" in result) {
      return (result as { coverage: LocalCodeIndexCoverageSummary }).coverage ?? null;
    }
  }
  return null;
}
