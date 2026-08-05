/**
 * Local Code Index v2 — sole ast-grep process adapter.
 *
 * Invokes `ast-grep outline --json=stream` with argument arrays and returns
 * structured per-file extraction results.  Captures the ast-grep version,
 * validates streamed output line-by-line, and enforces fixed bounds on output
 * size, symbol counts, and signature length.
 *
 * The binary path is never hardcoded — the caller supplies it at construction.
 *
 * Spec: docs/architecture/local-code-index-v2-spec.md sections 6, 9, 11
 * Dependencies: node:child_process.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { LocalCodeIndexUnavailableError } from "./contracts.js";
import type { AstGrepNode, AstGrepParseResult } from "./extract.js";

// ── Bounded constants (spec section 9.3) ──────────────────────────────────────

/**
 * Maximum stdout bytes accepted from a single ast-grep process invocation.
 * Spec section 9.3: "maximum parser output per process: 64 MiB".
 */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * `outline` produces a compact, bounded summary and can safely amortize
 * process startup across a large set of approved paths. Identifier scans are
 * intentionally smaller because a reference-heavy file can emit far more JSON
 * than its source size.
 */
export const AST_GREP_OUTLINE_BATCH_SIZE = 2_048;
export const AST_GREP_REFERENCE_BATCH_SIZE = 120;

/**
 * Maximum symbols per file (definitions + references combined).
 * Spec section 9.3: "maximum symbols per file: 10,000".
 */
const MAX_SYMBOLS_PER_FILE = 10_000;

/**
 * Maximum signature size in bytes.
 * Spec section 9.3: "maximum signature size: 16 KiB".
 */
const MAX_SIGNATURE_BYTES = 16 * 1024;

/**
 * Default per-invocation timeout in milliseconds.
 * A generous bound — typical invocations complete in under 5 seconds.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

// ── Native @ast-grep/napi loader (references extraction) ─────────────────────
//
// References extraction runs in-process via @ast-grep/napi, eliminating the
// per-batch CLI spawn (83 spawns per 10000-file round). outline + version
// extraction stay on the external ast-grep CLI. The napi module and its
// dynamic language packs are loaded LAZILY on the first references extraction:
// a static top-level `import "@ast-grep/napi"` would crash this entire module
// when a platform .node binary is missing, taking down the still-CLI
// outline/version path with it. Dynamic import isolates any failure to the
// references path only (extractReferences throws parser_unavailable; outline
// and getVersion continue via runAstGrep).
//
// registerDynamicLanguage is documented to be called exactly once per process;
// loadNapi memoizes the module and the registered-language set so registration
// happens at most once.

type NapiModule = typeof import("@ast-grep/napi");

/** Registration object exposed by each @ast-grep/lang-* pack. */
interface NapiLangRegistration {
  libraryPath: string;
  extensions: string[];
  languageSymbol?: string;
  metaVarChar?: string;
  expandoChar?: string;
}

/** Built-in languages available without dynamic registration (default Lang enum). */
const NAPI_BUILTIN_LANGS: ReadonlySet<string> = new Set([
  "TypeScript",
  "Tsx",
  "JavaScript",
  "Css",
  "Html",
]);

/** Dynamic language packs registered on first load; key = napi language name. */
const NAPI_DYNAMIC_PACKS: ReadonlyArray<readonly [string, () => Promise<NapiLangRegistration>]> = [
  ["python", async () => extractLangRegistration(await import("@ast-grep/lang-python"))],
  ["go", async () => extractLangRegistration(await import("@ast-grep/lang-go"))],
  ["rust", async () => extractLangRegistration(await import("@ast-grep/lang-rust"))],
];

let napiModuleCache: NapiModule | null = null;
let napiRegisteredLangs: ReadonlySet<string> | null = null;

/** Read the LangRegistration out of a dynamically imported @ast-grep/lang-* pack. */
function extractLangRegistration(mod: unknown): NapiLangRegistration {
  // The packs are CJS modules whose default/namespace export is the
  // { libraryPath, extensions, languageSymbol, expandoChar } object.
  const reg = (mod as { default?: unknown }).default ?? mod;
  if (
    reg !== null
    && typeof reg === "object"
    && typeof (reg as { libraryPath?: unknown }).libraryPath === "string"
  ) {
    return reg as NapiLangRegistration;
  }
  throw new Error("dynamic language pack did not expose a libraryPath registration");
}

/**
 * Lazily load @ast-grep/napi and register the dynamic language packs.
 *
 * Returns the module and the set of available language names (built-ins plus
 * successfully registered dynamic packs). Throws `parser_unavailable` only if
 * the napi module itself cannot be loaded; a missing/unavailable dynamic
 * language pack merely excludes that language from the registered set
 * (extractReferences then routes its files to failedLangPaths).
 */
async function loadNapi(): Promise<{
  napi: NapiModule;
  registeredLangs: ReadonlySet<string>;
}> {
  if (napiModuleCache !== null && napiRegisteredLangs !== null) {
    return { napi: napiModuleCache, registeredLangs: napiRegisteredLangs };
  }
  let napi: NapiModule;
  try {
    napi = await import("@ast-grep/napi");
  } catch (error) {
    throw new LocalCodeIndexUnavailableError("parser_unavailable", {
      cause: error instanceof Error ? error : new Error(String(error)),
    });
  }
  const registered = new Set<string>(NAPI_BUILTIN_LANGS);
  const dynamic: Record<string, NapiLangRegistration> = {};
  for (const [name, load] of NAPI_DYNAMIC_PACKS) {
    try {
      dynamic[name] = await load();
    } catch {
      // Pack missing or unsupported on this platform: left unregistered.
      // extractReferences routes files of this language to failedLangPaths.
    }
  }
  if (Object.keys(dynamic).length > 0) {
    try {
      napi.registerDynamicLanguage(dynamic);
      for (const name of Object.keys(dynamic)) registered.add(name);
    } catch {
      // Registration rejected (e.g. already registered): no dynamic langs added.
    }
  }
  napiModuleCache = napi;
  napiRegisteredLangs = registered;
  return { napi, registeredLangs: registered };
}

/**
 * Map a source-relative path to its napi language name for references
 * extraction, or null if the file is not a structural references target.
 *
 * Mirrors the structural language set of extract.ts languageForExtension
 * (typescript / typescriptreact / javascript / javascriptreact / python / rust
 * / go). Non-structural languages (json/css/html/markdown/yaml) and unmatched
 * extensions (.mts/.cts/.pyw/.java/...) return null → file-inventory-only.
 * Returns the napi language name as a string (NapiLang = Lang | CustomLang);
 * built-in names are the Lang enum's string values ("TypeScript", "Tsx", ...).
 *
 * Note: .jsx maps to JavaScript because the default Lang enum has no Jsx member
 * and the JavaScript parser handles JSX syntax (verified by the flow-2hh PoC).
 */
export function langForPath(relPath: string): string | null {
  const dot = relPath.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = relPath.slice(dot + 1).toLowerCase();
  switch (ext) {
    case "ts":
      return "TypeScript";
    case "tsx":
      return "Tsx";
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
      return "JavaScript";
    case "py":
    case "pyi":
      return "python";
    case "go":
      return "go";
    case "rs":
      return "rust";
    default:
      return null;
  }
}

/** Structural surface of an napi SgNode used by references extraction. */
interface NapiSgNode {
  text(): string;
  range(): {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
}

/**
 * Bound concurrency for in-process references parsing. Matches the durable
 * write concurrency so references parsing overlaps I/O without exhausting
 * memory by holding many parsed ASTs live at once.
 */
const NAPI_REFERENCES_CONCURRENCY = 8;

/**
 * Stable positional ordering for references within a file. napi findAll is
 * already deterministic and matches the CLI order, but an explicit sort
 * guarantees byte-identical re-index (the object-identity collision guard)
 * regardless of any internal traversal ordering.
 */
function compareReferencePosition(a: AstGrepSymbol, b: AstGrepSymbol): number {
  return (
    a.range.startLine - b.range.startLine
    || a.range.startColumn - b.range.startColumn
    || a.range.endLine - b.range.endLine
    || a.range.endColumn - b.range.endColumn
    || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  );
}

/**
 * Run an async callback over items with bounded concurrency, preserving the
 * inability to cancel native parsing in flight: callers check the abort signal
 * between items so abort stops dispatching new work (running parses finish on
 * the libuv thread).
 */
async function mapBounded<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<unknown>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await fn(items[index]!, index);
    }
  };
  const size = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: size }, () => worker()));
}

// ── Symbol schema types ──────────────────────────────────────────────────────

/**
 * A validated source range extracted from ast-grep output.
 */
export type AstGrepRange = Readonly<{
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}>;

/**
 * A single validated symbol extracted from one file's outline.
 */
export type AstGrepSymbol = Readonly<{
  name: string;
  kind: string;
  role: "definition" | "reference";
  range: AstGrepRange;
  exported: boolean;
  signature: string | null;
  astKind: string | null;
  isImport: boolean;
  members: readonly AstGrepSymbol[];
}>;

/**
 * Structured extraction result for one file.
 */
export type AstGrepFileResult = Readonly<{
  path: string;
  language: string;
  symbols: readonly AstGrepSymbol[];
}>;

/**
 * Complete result from an extraction run.
 */
export type AstGrepExtractionResult = Readonly<{
  files: readonly AstGrepFileResult[];
  version: string | null;
  truncated: boolean;
  errors: readonly string[];
  /**
   * Paths whose references were truncated at the per-file symbol cap
   * (or refused for being oversized). Optional: outline extraction never
   * truncates per-file, so it omits this field.
   */
  truncatedPaths?: ReadonlySet<string>;
  /**
   * Paths whose references could not be extracted because their language was
   * unavailable (dynamic language pack missing or unsupported on the
   * platform). The service downgrades these files' coverage rather than
   * publishing empty references under ast-grep-structural.
   */
  failedLangPaths?: ReadonlySet<string>;
}>;

// ── Raw output types (untrusted, pre-validation) ─────────────────────────────

interface RawRange {
  start?: { line?: unknown; column?: unknown };
  end?: { line?: unknown; column?: unknown };
}

interface RawItem {
  name?: unknown;
  symbolType?: unknown;
  role?: unknown;
  range?: RawRange;
  isExported?: unknown;
  signature?: unknown;
  astKind?: unknown;
  isImport?: unknown;
  members?: unknown;
}

interface RawFileOutline {
  path?: unknown;
  language?: unknown;
  items?: unknown;
}

interface RawMatch {
  text?: unknown;
  file?: unknown;
  language?: unknown;
  range?: RawRange;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Validate a non-negative integer field.
 */
function isValidNonNegInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/**
 * Count the UTF-8 byte length of a string.
 */
function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Validate a single raw item and convert to AstGrepSymbol, or null if invalid.
 */
function validateItem(raw: unknown): AstGrepSymbol | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const item = raw as RawItem;

  // name: required string, non-empty
  if (typeof item.name !== "string" || item.name.length === 0) {
    return null;
  }

  // symbolType: required string (used as `kind`)
  if (typeof item.symbolType !== "string" || item.symbolType.length === 0) {
    return null;
  }

  // range: required, with valid start/end
  if (item.range === null || typeof item.range !== "object") {
    return null;
  }
  const range = item.range;
  if (
    range.start === null ||
    typeof range.start !== "object" ||
    range.end === null ||
    typeof range.end !== "object"
  ) {
    return null;
  }
  if (
    !isValidNonNegInt(range.start.line) ||
    !isValidNonNegInt(range.start.column) ||
    !isValidNonNegInt(range.end.line) ||
    !isValidNonNegInt(range.end.column)
  ) {
    return null;
  }

  const validatedRange: AstGrepRange = {
    startLine: range.start.line + 1,
    startColumn: range.start.column + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.column + 1,
  };

  // exported: boolean (default false)
  const exported = item.isExported === true;

  // signature: optional string, truncated to MAX_SIGNATURE_BYTES
  let signature: string | null = null;
  if (typeof item.signature === "string" && item.signature.length > 0) {
    if (utf8ByteLength(item.signature) <= MAX_SIGNATURE_BYTES) {
      signature = item.signature;
    } else {
      // Truncate to fit within the byte bound.
      const encoder = new TextEncoder();
      const decoder = new TextDecoder("utf-8", { fatal: false });
      const bytes = encoder.encode(item.signature);
      signature = decoder.decode(bytes.subarray(0, MAX_SIGNATURE_BYTES));
    }
  }

  // members: optional array, recursively validated
  let members: readonly AstGrepSymbol[] = [];
  if (Array.isArray(item.members)) {
    const validated: AstGrepSymbol[] = [];
    for (const m of item.members) {
      const v = validateItem(m);
      if (v !== null) {
        validated.push(v);
      }
    }
    members = validated;
  }

  return {
    name: item.name,
    kind: item.symbolType,
    role: item.role === "reference" ? "reference" : "definition",
    range: validatedRange,
    exported,
    signature,
    astKind: typeof item.astKind === "string" ? item.astKind : null,
    isImport: item.isImport === true,
    members,
  };
}

/**
 * Validate one line of `--json=stream` output.
 *
 * Returns a file result or null if the line is malformed.
 * Rejects lines that exceed the per-file symbol bound.
 */
function validateLine(line: string): AstGrepFileResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const raw = parsed as RawFileOutline;

  // path: required string
  if (typeof raw.path !== "string" || raw.path.length === 0) {
    return null;
  }

  // language: required string
  if (typeof raw.language !== "string" || raw.language.length === 0) {
    return null;
  }

  // items: required array
  if (!Array.isArray(raw.items)) {
    return null;
  }

  // Enforce per-file symbol bound.
  if (raw.items.length > MAX_SYMBOLS_PER_FILE) {
    return null;
  }

  const symbols: AstGrepSymbol[] = [];
  for (const item of raw.items) {
    const validated = validateItem(item);
    if (validated !== null) {
      symbols.push(validated);
    }
  }

  return {
    path: raw.path,
    language: raw.language,
    symbols,
  };
}

function validateReferenceLine(line: string): {
  path: string;
  language: string;
  symbol: AstGrepSymbol;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const match = parsed as RawMatch;
  if (
    typeof match.text !== "string"
    || match.text.length === 0
    || typeof match.file !== "string"
    || match.file.length === 0
    || typeof match.language !== "string"
    || match.range === null
    || typeof match.range !== "object"
    || match.range.start === null
    || typeof match.range.start !== "object"
    || match.range.end === null
    || typeof match.range.end !== "object"
    || !isValidNonNegInt(match.range.start.line)
    || !isValidNonNegInt(match.range.start.column)
    || !isValidNonNegInt(match.range.end.line)
    || !isValidNonNegInt(match.range.end.column)
  ) {
    return null;
  }
  return {
    path: match.file,
    language: match.language,
    symbol: {
      name: match.text,
      kind: "identifier",
      role: "reference",
      range: {
        startLine: match.range.start.line + 1,
        startColumn: match.range.start.column + 1,
        endLine: match.range.end.line + 1,
        endColumn: match.range.end.column + 1,
      },
      exported: false,
      signature: null,
      astKind: "identifier",
      isImport: false,
      members: [],
    },
  };
}

/**
 * Run an ast-grep command and return stdout.
 *
 * Uses `execFile` with argument arrays (never a shell) per spec section 11.
 * Respects the optional abort signal and enforces a timeout.
 */
function runAstGrep(
  binaryPath: string,
  args: readonly string[],
  options: Readonly<{
    timeoutMs: number;
    signal?: AbortSignal;
    maxBuffer: number;
    cwd?: string;
  }>,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const child = execFile(
      binaryPath,
      [...args],
      {
        cwd: options.cwd,
        maxBuffer: options.maxBuffer,
        encoding: "utf8",
        timeout: 0, // we manage timeout ourselves for abort-signal coordination
      },
      (error, stdout, _stderr) => {
        if (settled) return;
        settled = true;
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }

        if (error) {
          if ((error as NodeJS.ErrnoException).code === "ABORT_ERR") {
            reject(
              new LocalCodeIndexUnavailableError("operation_aborted", {
                cause: error,
              }),
            );
            return;
          }
          reject(
            new LocalCodeIndexUnavailableError("parser_unavailable", {
              cause: new Error(
                `${binaryPath} failed (exit ${(error as { code?: number }).code ?? "?"}): ${(_stderr ?? "").trim()}`,
              ),
            }),
          );
          return;
        }
        resolve(stdout ?? "");
      },
    );

    // Timeout
    timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new LocalCodeIndexUnavailableError("parser_unavailable", {
          cause: new Error(
            `${binaryPath} timed out after ${options.timeoutMs}ms`,
          ),
        }),
      );
    }, options.timeoutMs);

    // Abort signal
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        if (!settled) {
          settled = true;
          if (timeoutId !== null) {
            clearTimeout(timeoutId);
          }
          child.kill("SIGKILL");
          reject(
            new LocalCodeIndexUnavailableError("operation_aborted"),
          );
        }
        return;
      }

      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
        }
        child.kill("SIGKILL");
        reject(
          new LocalCodeIndexUnavailableError("operation_aborted", {
            cause: options.signal!.reason,
          }),
        );
      };
      options.signal.addEventListener("abort", onAbort, { once: true });

      // Clean up the listener when the process completes normally.
      child.on("close", () => {
        options.signal?.removeEventListener("abort", onAbort);
      });
    }
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Options for creating an {@link AstGrepAdapter}.
 */
export type AstGrepAdapterOptions = Readonly<{
  /**
   * Path to the ast-grep binary.  Must not be empty.
   * Typically `"ast-grep"` (resolved from PATH) or an absolute path.
   */
  binaryPath: string;
  /** Working directory used to resolve source-relative input paths. */
  cwd?: string;

  /**
   * Per-invocation timeout in milliseconds.
   * Defaults to 60 000 ms.
   */
  timeoutMs?: number;
}>;

/**
 * The sole ast-grep process adapter for the local code index.
 *
 * All ast-grep invocations go through this adapter.  It:
 * - invokes `ast-grep outline --json=stream` with argument arrays (never a shell);
 * - captures the tool version once and caches it;
 * - enforces fixed output bounds and per-file symbol limits;
 * - validates every JSON line against the expected schema;
 * - respects abort signals and timeouts.
 *
 * The binary path is supplied by the caller — nothing is hardcoded.
 *
 * Spec section 6: "ast-grep is a true external executable. The implementation
 * invokes it through one internal process adapter."
 */
export class AstGrepAdapter {
  private readonly binaryPath: string;
  private readonly cwd: string | undefined;
  private readonly timeoutMs: number;
  private versionPromise: Promise<string | null> | null = null;

  constructor(options: AstGrepAdapterOptions) {
    if (typeof options.binaryPath !== "string" || options.binaryPath.length === 0) {
      throw new LocalCodeIndexUnavailableError("parser_unavailable", {
        cause: new Error("ast-grep binary path must be a non-empty string"),
      });
    }
    this.binaryPath = options.binaryPath;
    this.cwd = options.cwd;
    this.timeoutMs =
      typeof options.timeoutMs === "number" && options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_TIMEOUT_MS;
  }

  /**
   * Capture and cache the ast-grep version string.
   *
   * Runs `ast-grep --version` once and caches the result.  Returns `null`
   * when the binary is not available or its output cannot be parsed.
   */
  async getVersion(signal?: AbortSignal): Promise<string | null> {
    if (this.versionPromise === null) {
      this.versionPromise = this.captureVersion(signal);
    }
    return this.versionPromise;
  }

  private async captureVersion(signal?: AbortSignal): Promise<string | null> {
    try {
      const stdout = await runAstGrep(this.binaryPath, ["--version"], {
        timeoutMs: this.timeoutMs,
        signal,
        maxBuffer: 1024, // version output is tiny
        cwd: this.cwd,
      });
      // Expected format: "ast-grep 0.45.0"
      const trimmed = stdout.trim();
      if (trimmed.length === 0) return null;
      // Extract the version portion after "ast-grep ".
      const match = trimmed.match(/^ast-grep\s+(\S+)/);
      return match !== null ? match[1]! : trimmed;
    } catch {
      return null;
    }
  }

  /**
   * Extract symbols from a batch of files.
   *
   * Invokes `ast-grep outline --json=stream --color never <paths...>` and
   * returns structured per-file results.
   *
   * @param paths File paths to extract (max 2,048).
   * @param options.lang Optional language hint (e.g., "typescript").
   * @param options.signal Optional abort signal.
   * @returns Structured extraction results with version, errors, and truncation flag.
   * @throws {LocalCodeIndexUnavailableError} when the process cannot be invoked
   *   or produces unparseable output.
   */
  async extractFiles(
    paths: readonly string[],
    options?: Readonly<{
      lang?: string;
      signal?: AbortSignal;
    }>,
  ): Promise<AstGrepExtractionResult> {
    // ── Validate inputs ──────────────────────────────────────────────────
    if (paths.length === 0) {
      return {
        files: [],
        version: await this.getVersion(options?.signal),
        truncated: false,
        errors: [],
      };
    }

    if (paths.length > AST_GREP_OUTLINE_BATCH_SIZE) {
      throw new LocalCodeIndexUnavailableError("parser_output_invalid", {
        cause: new Error(
          `Outline batch size ${paths.length} exceeds maximum ${AST_GREP_OUTLINE_BATCH_SIZE}`,
        ),
      });
    }

    for (const p of paths) {
      if (typeof p !== "string" || p.length === 0) {
        throw new LocalCodeIndexUnavailableError("parser_output_invalid", {
          cause: new Error("All paths must be non-empty strings"),
        });
      }
    }

    // ── Build argument list ──────────────────────────────────────────────
    const args: string[] = [
      "outline",
      "--json=stream",
      "--color",
      "never",
      "--items=all",
    ];
    if (options?.lang !== undefined && options.lang.length > 0) {
      args.push("--lang", options.lang);
    }
    args.push(...paths);

    // ── Invoke ast-grep ──────────────────────────────────────────────────
    let stdout: string;
    try {
      stdout = await runAstGrep(this.binaryPath, args, {
        timeoutMs: this.timeoutMs,
        signal: options?.signal,
        maxBuffer: MAX_OUTPUT_BYTES,
        cwd: this.cwd,
      });
    } catch (err: unknown) {
      if (err instanceof LocalCodeIndexUnavailableError) {
        throw err;
      }
      throw new LocalCodeIndexUnavailableError("parser_unavailable", {
        cause: err,
      });
    }

    // ── Validate total output size ───────────────────────────────────────
    const outputBytes = utf8ByteLength(stdout);
    if (outputBytes > MAX_OUTPUT_BYTES) {
      throw new LocalCodeIndexUnavailableError("parser_output_invalid", {
        cause: new Error(
          `ast-grep output (${outputBytes} bytes) exceeds bound (${MAX_OUTPUT_BYTES} bytes)`,
        ),
      });
    }

    // ── Parse and validate streamed lines ────────────────────────────────
    const lines = stdout.split("\n");
    const files: AstGrepFileResult[] = [];
    const errors: string[] = [];
    let truncated = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Skip empty lines (trailing newline produces one).
      if (line.length === 0) continue;

      const result = validateLine(line);
      if (result === null) {
        errors.push(`malformed outline at line ${i + 1}`);
        truncated = true;
        continue;
      }

      files.push(result);
    }

    // ── Capture version (in parallel with extraction if not yet cached) ──
    const version = await this.getVersion(options?.signal);

    return { files, version, truncated, errors };
  }

  /**
   * Extract identifier references from a batch using ast-grep's syntax tree,
   * not a text regular expression.
   */
  async extractReferences(
    paths: readonly string[],
    options?: Readonly<{ lang?: string; signal?: AbortSignal }>,
  ): Promise<AstGrepExtractionResult> {
    if (paths.length === 0) {
      return {
        files: [],
        version: await this.getVersion(options?.signal),
        truncated: false,
        truncatedPaths: new Set<string>(),
        failedLangPaths: new Set<string>(),
        errors: [],
      };
    }
    if (paths.length > AST_GREP_REFERENCE_BATCH_SIZE) {
      throw new LocalCodeIndexUnavailableError("parser_output_invalid");
    }
    const signal = options?.signal;
    if (signal?.aborted) {
      throw new LocalCodeIndexUnavailableError("operation_aborted");
    }

    // In-process references extraction via @ast-grep/napi (Strategy B:
    // per-file parseAsync + findAll). Eliminates the per-batch CLI spawn.
    // outline + version extraction stay on the external ast-grep CLI.
    const { napi, registeredLangs } = await loadNapi();

    const files: AstGrepFileResult[] = [];
    const truncatedPaths = new Set<string>();
    const failedLangPaths = new Set<string>();
    const errors: string[] = [];
    const decoder = new TextDecoder();

    const perFile = async (relPath: string): Promise<void> => {
      if (signal?.aborted) return;
      const lang = langForPath(relPath);
      if (lang === null) return; // non-structural: references not extracted
      if (!registeredLangs.has(lang)) {
        failedLangPaths.add(relPath);
        return;
      }
      let src: string;
      try {
        const abs = this.cwd ? path.resolve(this.cwd, relPath) : relPath;
        src = decoder.decode(await readFile(abs));
      } catch (error) {
        errors.push(`references: unreadable ${relPath}: ${(error as Error).message}`);
        return;
      }
      // OOM guard: refuse to feed oversized source to the native parser.
      if (Buffer.byteLength(src, "utf8") > MAX_OUTPUT_BYTES) {
        truncatedPaths.add(relPath);
        return;
      }
      let sgRoot: { root: () => { findAll: (matcher: unknown) => NapiSgNode[] } };
      try {
        // parseAsync returns an SgRoot; findAll lives on the root SgNode
        // obtained via SgRoot.root() (verified in the flow-2hh PoC).
        sgRoot = (await napi.parseAsync(lang, src)) as unknown as {
          root: () => { findAll: (matcher: unknown) => NapiSgNode[] };
        };
      } catch (error) {
        errors.push(`references: parse failed ${relPath}: ${(error as Error).message}`);
        return;
      }
      if (signal?.aborted) return;
      const nodes = sgRoot.root().findAll({ rule: { kind: "identifier" } });
      const symbols: AstGrepSymbol[] = [];
      for (const node of nodes) {
        if (symbols.length >= MAX_SYMBOLS_PER_FILE) {
          truncatedPaths.add(relPath);
          break;
        }
        const r = node.range();
        symbols.push({
          name: node.text(),
          kind: "identifier",
          role: "reference",
          range: {
            startLine: r.start.line + 1,
            startColumn: r.start.column + 1,
            endLine: r.end.line + 1,
            endColumn: r.end.column + 1,
          },
          exported: false,
          signature: null,
          astKind: "identifier",
          isImport: false,
          members: [],
        });
      }
      // Stable positional order: guarantees byte-identical re-index
      // (object-identity collision guard), independent of traversal order.
      symbols.sort(compareReferencePosition);
      files.push({ path: relPath, language: lang, symbols });
    };

    await mapBounded(paths, NAPI_REFERENCES_CONCURRENCY, perFile);

    if (signal?.aborted) {
      throw new LocalCodeIndexUnavailableError("operation_aborted");
    }

    return {
      files,
      version: await this.getVersion(options?.signal),
      truncated: truncatedPaths.size > 0,
      truncatedPaths,
      failedLangPaths,
      errors,
    };
  }
}

function declarationKind(symbol: AstGrepSymbol): string {
  switch (symbol.kind) {
    case "function":
      return "function_declaration";
    case "class":
      return "class_declaration";
    case "interface":
      return "interface_declaration";
    case "type":
    case "struct":
      return "type_alias_declaration";
    case "enum":
      return "enum_declaration";
    case "method":
      return "method_definition";
    case "constant":
    case "variable":
    case "field":
      return "lexical_declaration";
    default:
      return symbol.astKind ?? "variable_declaration";
  }
}

function importSpecifier(signature: string | null): string | null {
  if (signature === null) return null;
  const match = signature.match(
    /(?:\bfrom\s+|\bimport\s*\(|\brequire\s*\(|^\s*import\s+)(["'])([^"']+)\1/u,
  );
  return match?.[2] ?? null;
}

function symbolToNode(symbol: AstGrepSymbol): AstGrepNode {
  const start = {
    line: symbol.range.startLine,
    column: symbol.range.startColumn,
  };
  const end = {
    line: symbol.range.endLine,
    column: symbol.range.endColumn,
  };
  if (symbol.role === "reference") {
    return { kind: "identifier", text: symbol.name, start, end };
  }
  if (symbol.isImport) {
    const requested = importSpecifier(symbol.signature);
    return {
      kind: symbol.astKind ?? "import_statement",
      text: symbol.signature ?? symbol.name,
      start,
      end,
      children: requested === null
        ? []
        : [{
            kind: "string",
            text: JSON.stringify(requested),
            start,
            end,
          }],
    };
  }
  return {
    kind: declarationKind(symbol),
    text: symbol.signature ?? symbol.name,
    start,
    end,
    isExported: symbol.exported,
    children: [
      {
        kind: "identifier",
        text: symbol.name,
        start,
        end,
        isDefinitionName: true,
      },
      ...symbol.members.map(symbolToNode),
    ],
  };
}

/**
 * Convert validated outline output into the canonical structural extraction
 * input consumed by extractFileFacts.
 */
export function outlineFileToParseResult(
  file: AstGrepFileResult,
  version: string,
  parseErrors: readonly string[] = [],
): AstGrepParseResult {
  return {
    version,
    success: parseErrors.length === 0,
    nodes: file.symbols.map(symbolToNode),
    parseErrors,
  };
}
