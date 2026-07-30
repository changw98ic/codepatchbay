#!/usr/bin/env node
/**
 * Fake ast-grep executable adapter for testing.
 *
 * Drop-in replacement for the real `ast-grep` binary.  Accepts the same CLI
 * arguments that {@link AstGrepAdapter} uses and produces controlled,
 * deterministic output — no real parsing or filesystem access.
 *
 * Mode is selected via CPB_FAKE_ASTGREP_MODE:
 *
 *   "default"   — returns a fixed set of symbols for any input paths.
 *   "empty"     — returns zero symbols (valid empty outline per file).
 *   "error"     — exits with code 1 and writes an error to stderr.
 *   "timeout"   — hangs until killed (simulates a hung process).
 *   "malformed" — writes invalid JSON lines to stdout.
 *   "oversized" — writes output exceeding the 64 MiB bound.
 *   "custom"    — reads JSON outlines from CPB_FAKE_ASTGREP_CUSTOM_FILE
 *                  (one RawFileOutline per line) and echoes them verbatim.
 *
 * Environment variables:
 *   CPB_FAKE_ASTGREP_MODE        — mode selector (default: "default").
 *   CPB_FAKE_ASTGREP_VERSION     — version string for --version
 *                                   (default: "0.0.0-test").
 *   CPB_FAKE_ASTGREP_CUSTOM_FILE — path to a JSONL file of RawFileOutline
 *                                   objects, used in "custom" mode.
 *
 * Spec: the output schema matches `RawFileOutline` in
 *       core/indexing/local-code-index/ast-grep-adapter.ts (lines 97–116).
 */

import { readFileSync } from "node:fs";

// ── Configuration ────────────────────────────────────────────────────────────

const MODE = process.env.CPB_FAKE_ASTGREP_MODE ?? "default";
const VERSION = process.env.CPB_FAKE_ASTGREP_VERSION ?? "0.0.0-test";
const CUSTOM_FILE = process.env.CPB_FAKE_ASTGREP_CUSTOM_FILE ?? "";

// ── Argument parsing ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);

const isVersionRequest = args.includes("--version") && !args.includes("outline");

if (isVersionRequest) {
  process.stdout.write(`ast-grep ${VERSION}\n`);
  process.exit(0);
}

// ── Mode dispatch ────────────────────────────────────────────────────────────

switch (MODE) {
  case "timeout":
    // Simulate a hung process — the caller's timeout / abort signal must kill us.
    {
      const keepAlive = setInterval(() => {}, 2_147_483_647);
      // Prevent the timer from keeping the process alive after SIGKILL.
      keepAlive.unref();
    }
    break;

  case "error":
    process.stderr.write("fake-ast-grep: simulated binary failure\n");
    process.exit(1);
    break;

  case "malformed":
    process.stdout.write("{not valid json\n");
    process.stdout.write("also not json\n");
    process.stdout.write(JSON.stringify({ path: "ok.ts", language: "typescript", items: [] }) + "\n");
    process.exit(0);
    break;

  case "oversized":
    // Write 65 MiB of valid JSON lines to exceed the 64 MiB bound.
    {
      const bigItem = {
        name: "BigSymbol",
        symbolType: "function",
        role: "definition",
        range: { start: { line: 1, column: 1 }, end: { line: 1, column: 50 } },
        isExported: false,
        signature: null,
        members: [],
      };
      const line = JSON.stringify({
        path: "big.ts",
        language: "typescript",
        items: [bigItem],
      });
      // Each line ~150 bytes.  65 MiB / 150 ≈ 453_000 lines.
      const targetBytes = 65 * 1024 * 1024;
      let written = 0;
      while (written < targetBytes) {
        process.stdout.write(line + "\n");
        written += line.length + 1;
      }
      process.exit(0);
    }
    break;

  case "empty":
    // Emit one empty-outline line per input path.
    emitDefaultOutlines(/* symbolCount */ 0);
    process.exit(0);
    break;

  case "custom":
    // Read pre-built outlines from a JSONL file and echo them.
    {
      if (!CUSTOM_FILE) {
        process.stderr.write(
          "fake-ast-grep: CPB_FAKE_ASTGREP_CUSTOM_FILE is required for custom mode\n",
        );
        process.exit(1);
      }
      const content = readFileSync(CUSTOM_FILE, "utf8");
      // Each non-empty line is a complete RawFileOutline JSON object.
      for (const line of content.split("\n")) {
        if (line.trim().length > 0) {
          process.stdout.write(line + "\n");
        }
      }
      process.exit(0);
    }
    break;

  case "default":
  default:
    emitDefaultOutlines(/* symbolCount */ 3);
    process.exit(0);
    break;
}

// ── Default outline generator ────────────────────────────────────────────────

/**
 * Emit one JSON outline line per input file path.
 *
 * Paths are taken from the trailing positional arguments (after any flags).
 * When `symbolCount` is 0 the outline has an empty `items` array.
 *
 * The structure matches the `RawFileOutline` schema expected by
 * `validateLine` in `ast-grep-adapter.ts`:
 *
 * ```
 * {
 *   path: string,
 *   language: string,
 *   items: RawItem[]
 * }
 * ```
 *
 * where each `RawItem` has:
 *
 * ```
 * {
 *   name: string,
 *   symbolType: string,
 *   role: "definition" | "reference",
 *   range: { start: { line, column }, end: { line, column } },
 *   isExported: boolean,
 *   signature: string | null,
 *   members: RawItem[]
 * }
 * ```
 */
function emitDefaultOutlines(symbolCount: number): void {
  const paths = extractPaths(args);

  for (const filePath of paths) {
    const language = inferLanguage(filePath);
    const items = symbolCount > 0 ? buildDefaultSymbols(filePath, language, symbolCount) : [];
    const outline = { path: filePath, language, items };
    process.stdout.write(JSON.stringify(outline) + "\n");
  }
}

/**
 * Extract file paths from the argument list.
 *
 * Skips known flags and their values.  Everything else is treated as a path.
 */
function extractPaths(argv: readonly string[]): string[] {
  const paths: string[] = [];
  let skipNext = false;

  for (const arg of argv) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    // Skip flags that take a value argument.
    if (arg === "--lang" || arg === "--color") {
      skipNext = true;
      continue;
    }
    // Skip flags without values.
    if (arg.startsWith("--") || arg === "outline") {
      continue;
    }
    paths.push(arg);
  }

  return paths;
}

/**
 * Infer a language string from a file extension.
 */
function inferLanguage(filePath: string): string {
  const ext = filePath.includes(".") ? filePath.split(".").pop()!.toLowerCase() : "";
  switch (ext) {
    case "ts":
      return "typescript";
    case "tsx":
      return "typescriptreact";
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    case "jsx":
      return "javascriptreact";
    case "py":
    case "pyi":
      return "python";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "json":
      return "json";
    case "css":
    case "scss":
      return "css";
    case "html":
    case "htm":
      return "html";
    case "md":
      return "markdown";
    case "yaml":
    case "yml":
      return "yaml";
    default:
      return "unknown";
  }
}

/**
 * Build a deterministic set of default symbols for a file.
 *
 * Produces `symbolCount` definition symbols and one reference, each with
 * non-overlapping line ranges.  Every symbol has the shape required by
 * `validateItem` in `ast-grep-adapter.ts`.
 */
function buildDefaultSymbols(
  filePath: string,
  language: string,
  symbolCount: number,
): readonly object[] {
  const items: object[] = [];

  for (let i = 0; i < symbolCount; i++) {
    const line = i * 5 + 1;
    items.push({
      name: `Symbol${i}_${sanitize(filePath)}`,
      symbolType: i === 0 ? "function_declaration" : "variable_declaration",
      role: "definition",
      range: {
        start: { line, column: 1 },
        end: { line, column: 40 },
      },
      isExported: i === 0,
      signature: i === 0 ? `(arg${i}: ${language}) => void` : null,
      members: [],
    });
  }

  // Add one reference symbol.
  if (symbolCount > 0) {
    const refLine = symbolCount * 5 + 1;
    items.push({
      name: `Ref_${sanitize(filePath)}`,
      symbolType: "identifier",
      role: "reference",
      range: {
        start: { line: refLine, column: 5 },
        end: { line: refLine, column: 20 },
      },
      isExported: false,
      signature: null,
      members: [],
    });
  }

  return items;
}

/**
 * Produce a filesystem-safe suffix from a path string.
 */
function sanitize(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, "_").slice(-20);
}
