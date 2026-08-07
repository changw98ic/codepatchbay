/**
 * Local Code Index v2 — path-independent file fact extraction.
 *
 * CPB-owned, versioned extraction rules by supported language.  Produces
 * definitions, references, raw imports, signatures, parser errors, and
 * truncation markers with no path-dependent resolved target.
 *
 * Lexical and inventory-only fallback modes are explicit and never claim
 * structural completeness.
 *
 * Spec: docs/architecture/local-code-index-v2-spec.md sections 7.3, 8.4,
 *       9.1, 9.2, 9.3
 *
 * Dependencies: node:crypto, contracts.ts, canonical-json.ts.
 */

import { createHash } from "node:crypto";

import type { LocalCodeIndexCoverage, SourceRange } from "./contracts.js";
import { objectId } from "./canonical-json.js";
import { readOptionalPackageVersion } from "./optional-package-metadata.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** Schema version for extraction rules. Bump when rule format changes. */
export const EXTRACTION_RULE_SCHEMA_VERSION = 1;

/** Maximum source file size eligible for structural extraction (5 MiB). */
export const MAX_INDEX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

/** Maximum symbols (definitions) per file. */
export const MAX_SYMBOLS_PER_FILE = 10_000;

/** Maximum references per file. */
export const MAX_REFERENCES_PER_FILE = 100_000;

/** Maximum signature size in bytes. */
export const MAX_SIGNATURE_SIZE_BYTES = 16 * 1024;

/** Maximum parser output per process (64 MiB). */
export const MAX_PARSER_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Maximum files per parser batch. */
export const MAX_PARSER_BATCH_SIZE = 120;

/** Truncation marker appended when a limit is hit. */
export const TRUNCATION_MARKER = "..." as const;

// ── Supported languages ──────────────────────────────────────────────────────

/**
 * Languages with CPB-owned structural extraction rules.
 *
 * Each language maps to an effective language identifier used in the file
 * object ID derivation.  Additional languages are added by creating
 * versioned rule files under `rules/`.
 */
export type SupportedLanguage =
  | "typescript"
  | "typescriptreact"
  | "javascript"
  | "javascriptreact"
  | "json"
  | "python"
  | "rust"
  | "go"
  | "css"
  | "html"
  | "markdown"
  | "yaml";

/**
 * Parser modes supported by the extraction pipeline.
 *
 * - `"structural"` — ast-grep with CPB-owned rules; produces full
 *   definitions, references, imports, signatures.
 * - `"lexical-fallback"` — regex-based extraction; produces definitions
 *   and raw references only, labeled as non-structural.
 * - `"file-inventory-only"` — no parsing; file is indexed by path, size,
 *   and content hash only.
 */
export type ParserMode =
  | "structural"
  | "lexical-fallback"
  | "file-inventory-only";

// ── Extraction rule types ────────────────────────────────────────────────────

/**
 * A CPB-owned versioned extraction rule for a single language.
 *
 * Rules are grouped by language and included in the extractor fingerprint.
 * Each rule identifies a pattern kind (definition, reference, import,
 * export, signature) and the ast-grep pattern or regex that matches it.
 */
export type ExtractionRule = Readonly<{
  /** Rule identifier, unique within a language rule set. */
  id: string;
  /** Language this rule applies to. */
  language: SupportedLanguage;
  /** Pattern kind this rule extracts. */
  kind: "definition" | "reference" | "import" | "export" | "signature";
  /**
   * ast-grep pattern string for structural extraction.
   * Mutually exclusive with `regex`.
   */
  pattern?: string;
  /**
   * Regex pattern for lexical fallback extraction.
   * Mutually exclusive with `pattern`.
   */
  regex?: string;
  /** Human-readable description for diagnostics. */
  description: string;
  /** Version of this rule. Bump when the pattern changes. */
  version: number;
}>;

/**
 * A complete rule set for one language, with a version that feeds into
 * the extractor fingerprint.
 */
export type LanguageRuleSet = Readonly<{
  language: SupportedLanguage;
  /** Version of this rule set. Bump when any rule changes. */
  version: number;
  /** The extraction rules for this language. */
  rules: readonly ExtractionRule[];
}>;

// ── Extraction output types ──────────────────────────────────────────────────

/**
 * A definition extracted from source bytes.
 *
 * Contains only path-independent facts derivable from the source bytes
 * and extractor fingerprint.  No absolute path, source-relative path,
 * or resolved target.
 */
export type ExtractedDefinition = Readonly<{
  /** Symbol name as it appears in source. */
  name: string;
  /** Symbol kind (function, class, variable, type, interface, etc.). */
  kind: string;
  /** Source range of the definition. */
  range: SourceRange;
  /** Whether the symbol is exported. */
  exported: boolean;
  /** Optional signature text, bounded by MAX_SIGNATURE_SIZE_BYTES. */
  signature: string | null;
}>;

/**
 * A reference to a symbol extracted from source bytes.
 *
 * Path-independent: no resolved target, no defining file.
 */
export type ExtractedReference = Readonly<{
  /** Referenced symbol name. */
  name: string;
  /** Source range of the reference. */
  range: SourceRange;
  /**
   * Reference kind:
   * - `"read"` — value read
   * - `"write"` — value write
   * - `"call"` — function/method call
   * - `"type"` — type annotation usage
   * - `"import"` — import specifier (the local binding)
   * - `"unknown"` — lexical match without structural context
   */
  referenceKind: "read" | "write" | "call" | "type" | "import" | "unknown";
}>;

/**
 * A raw import/include request extracted from source bytes.
 *
 * Contains only the syntactic import specifier as written in source.
 * No resolved path, package resolution result, or repository config.
 */
export type ExtractedImport = Readonly<{
  /**
   * The raw import specifier as written in source
   * (e.g., "./utils", "lodash", "../types").
   */
  requested: string;
  /** Source range of the entire import statement/syntax. */
  range: SourceRange;
  /**
   * Import kind:
   * - `"esm"` — ES module import
   * - `"cjs"` — CommonJS require
   * - `"dynamic"` — dynamic import()
   * - `"type-only"` — TypeScript type-only import
   * - `"other"` — language-specific (e.g., Python import, Rust use)
   */
  importKind: "esm" | "cjs" | "dynamic" | "type-only" | "other";
}>;

/**
 * A parser error or warning recorded during extraction.
 */
export type ExtractedParserError = Readonly<{
  /** Human-readable error message. */
  message: string;
  /** Source range where the error occurred, if available. */
  range: SourceRange | null;
  /**
   * Error severity:
   * - `"error"` — extraction failed for this region
   * - `"warning"` — extraction succeeded but with caveats
   */
  severity: "error" | "warning";
}>;

/**
 * A truncation marker indicating that a limit was hit.
 */
export type ExtractedTruncationMarker = Readonly<{
  /** Which limit was exceeded. */
  limitKind:
    | "max-symbols"
    | "max-references"
    | "max-signature-size"
    | "max-file-size"
    | "max-parser-output";
  /** The limit value that was exceeded. */
  limit: number;
  /** The actual count or size that triggered truncation. */
  actual: number;
}>;

/**
 * Complete extraction result for a single file.
 *
 * Contains only path-independent facts.  No absolute path, source-relative
 * path, resolved import target, package resolution result, or repository
 * configuration.
 */
export type FileExtractionResult = Readonly<{
  /** SHA-256 hex digest of the source bytes. */
  sourceContentId: string;
  /** Byte size of the source file. */
  byteSize: number;
  /** Effective language used for extraction. */
  language: SupportedLanguage;
  /** Parser mode that was used. */
  parserMode: ParserMode;
  /** Language extractor fingerprint for this extraction. */
  extractorFingerprint: string;
  /** Coverage level achieved for this file. */
  coverage: LocalCodeIndexCoverage;
  /** Extracted definitions. */
  definitions: readonly ExtractedDefinition[];
  /** Extracted references. */
  references: readonly ExtractedReference[];
  /** Raw import/include requests. */
  imports: readonly ExtractedImport[];
  /** Parser errors and warnings. */
  errors: readonly ExtractedParserError[];
  /** Truncation markers indicating limits were hit. */
  truncation: readonly ExtractedTruncationMarker[];
}>;

// ── Language mapping ─────────────────────────────────────────────────────────

/**
 * Map a file extension to a supported language.
 *
 * Returns `null` when the extension is not recognized, which means the
 * file receives `"file-inventory-only"` coverage.
 */
export function languageForExtension(ext: string): SupportedLanguage | null {
  const normalized = ext.startsWith(".") ? ext.slice(1).toLowerCase() : ext.toLowerCase();
  switch (normalized) {
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
    case "json":
      return "json";
    case "py":
    case "pyi":
      return "python";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "css":
    case "scss":
    case "less":
      return "css";
    case "html":
    case "htm":
      return "html";
    case "md":
    case "markdown":
      return "markdown";
    case "yaml":
    case "yml":
      return "yaml";
    default:
      return null;
  }
}

/**
 * Map a file path to an effective language for extraction.
 *
 * Uses the file extension.  Returns `null` for unrecognized extensions.
 */
export function languageForFile(filePath: string): SupportedLanguage | null {
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot < 0 || lastDot === filePath.length - 1) return null;
  return languageForExtension(filePath.slice(lastDot));
}

// ── CPB-owned extraction rules ───────────────────────────────────────────────

/**
 * CPB-owned versioned extraction rules for all supported languages.
 *
 * Each language has a `LanguageRuleSet` with a version number that feeds
 * into the extractor fingerprint.  Rules are bumped when patterns change;
 * the version is part of the fingerprint so changed rules invalidate
 * affected file objects.
 *
 * Rules use ast-grep patterns for structural extraction and regex patterns
 * for lexical fallback.
 */

const TYPESCRIPT_RULES: LanguageRuleSet = {
  language: "typescript",
  version: 1,
  rules: [
    {
      id: "ts-function-decl",
      language: "typescript",
      kind: "definition",
      pattern: "function $NAME($$$) { $$$ }",
      regex: "(?:export\\s+)?(?:async\\s+)?function\\s+(\\w+)",
      description: "Function declaration",
      version: 1,
    },
    {
      id: "ts-class-decl",
      language: "typescript",
      kind: "definition",
      pattern: "class $NAME { $$$ }",
      regex: "(?:export\\s+)?(?:abstract\\s+)?class\\s+(\\w+)",
      description: "Class declaration",
      version: 1,
    },
    {
      id: "ts-interface-decl",
      language: "typescript",
      kind: "definition",
      pattern: "interface $NAME { $$$ }",
      regex: "(?:export\\s+)?interface\\s+(\\w+)",
      description: "Interface declaration",
      version: 1,
    },
    {
      id: "ts-type-decl",
      language: "typescript",
      kind: "definition",
      pattern: "type $NAME = $$$",
      regex: "(?:export\\s+)?type\\s+(\\w+)",
      description: "Type alias declaration",
      version: 1,
    },
    {
      id: "ts-enum-decl",
      language: "typescript",
      kind: "definition",
      pattern: "enum $NAME { $$$ }",
      regex: "(?:export\\s+)?(?:const\\s+)?enum\\s+(\\w+)",
      description: "Enum declaration",
      version: 1,
    },
    {
      id: "ts-const-decl",
      language: "typescript",
      kind: "definition",
      pattern: "const $NAME = $$$",
      regex: "(?:export\\s+)?(?:declare\\s+)?const\\s+(\\w+)",
      description: "Const declaration",
      version: 1,
    },
    {
      id: "ts-let-decl",
      language: "typescript",
      kind: "definition",
      pattern: "let $NAME = $$$",
      regex: "(?:export\\s+)?let\\s+(\\w+)",
      description: "Let declaration",
      version: 1,
    },
    {
      id: "ts-import-esm",
      language: "typescript",
      kind: "import",
      pattern: "import { $$$ } from '$SOURCE'",
      regex: "(?:import\\s+(?:type\\s+)?(?:\\{[^}]*\\}|\\*\\s+as\\s+\\w+|\\w+)\\s+from\\s+['\"]([^'\"]+)['\"])",
      description: "ES module import",
      version: 1,
    },
    {
      id: "ts-import-default",
      language: "typescript",
      kind: "import",
      pattern: "import $NAME from '$SOURCE'",
      regex: "import\\s+(\\w+)\\s+from\\s+['\"]([^'\"]+)['\"]",
      description: "Default ES module import",
      version: 1,
    },
    {
      id: "ts-import-namespace",
      language: "typescript",
      kind: "import",
      pattern: "import * as $NAME from '$SOURCE'",
      regex: "import\\s+\\*\\s+as\\s+(\\w+)\\s+from\\s+['\"]([^'\"]+)['\"]",
      description: "Namespace ES module import",
      version: 1,
    },
    {
      id: "ts-import-type",
      language: "typescript",
      kind: "import",
      pattern: "import type { $$$ } from '$SOURCE'",
      regex: "import\\s+type\\s+\\{[^}]*\\}\\s+from\\s+['\"]([^'\"]+)['\"]",
      description: "Type-only import",
      version: 1,
    },
    {
      id: "ts-import-dynamic",
      language: "typescript",
      kind: "import",
      pattern: "import('$SOURCE')",
      regex: "import\\s*\\(\\s*['\"]([^'\"]+)['\"]\\s*\\)",
      description: "Dynamic import",
      version: 1,
    },
    {
      id: "ts-export-named",
      language: "typescript",
      kind: "export",
      pattern: "export { $$$ }",
      regex: "export\\s+\\{([^}]+)\\}",
      description: "Named re-export",
      version: 1,
    },
    {
      id: "ts-export-all",
      language: "typescript",
      kind: "export",
      pattern: "export * from '$SOURCE'",
      regex: "export\\s+\\*\\s+from\\s+['\"]([^'\"]+)['\"]",
      description: "Re-export all",
      version: 1,
    },
    {
      id: "ts-reference-identifier",
      language: "typescript",
      kind: "reference",
      regex: "\\b([a-zA-Z_$][\\w$]*)\\b",
      description: "Identifier reference (lexical fallback)",
      version: 1,
    },
  ],
};

const JAVASCRIPT_RULES: LanguageRuleSet = {
  language: "javascript",
  version: 1,
  rules: [
    {
      id: "js-function-decl",
      language: "javascript",
      kind: "definition",
      pattern: "function $NAME($$$) { $$$ }",
      regex: "(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+(\\w+)",
      description: "Function declaration",
      version: 1,
    },
    {
      id: "js-class-decl",
      language: "javascript",
      kind: "definition",
      pattern: "class $NAME { $$$ }",
      regex: "(?:export\\s+)?(?:default\\s+)?class\\s+(\\w+)",
      description: "Class declaration",
      version: 1,
    },
    {
      id: "js-const-decl",
      language: "javascript",
      kind: "definition",
      pattern: "const $NAME = $$$",
      regex: "(?:export\\s+)?const\\s+(\\w+)",
      description: "Const declaration",
      version: 1,
    },
    {
      id: "js-let-decl",
      language: "javascript",
      kind: "definition",
      pattern: "let $NAME = $$$",
      regex: "(?:export\\s+)?let\\s+(\\w+)",
      description: "Let declaration",
      version: 1,
    },
    {
      id: "js-var-decl",
      language: "javascript",
      kind: "definition",
      pattern: "var $NAME = $$$",
      regex: "(?:export\\s+)?var\\s+(\\w+)",
      description: "Var declaration",
      version: 1,
    },
    {
      id: "js-import-esm",
      language: "javascript",
      kind: "import",
      pattern: "import { $$$ } from '$SOURCE'",
      regex: "import\\s+\\{[^}]*\\}\\s+from\\s+['\"]([^'\"]+)['\"]",
      description: "ES module import",
      version: 1,
    },
    {
      id: "js-import-default",
      language: "javascript",
      kind: "import",
      pattern: "import $NAME from '$SOURCE'",
      regex: "import\\s+(\\w+)\\s+from\\s+['\"]([^'\"]+)['\"]",
      description: "Default ES module import",
      version: 1,
    },
    {
      id: "js-require",
      language: "javascript",
      kind: "import",
      regex: "(?:const|let|var)\\s+(?:\\{[^}]*\\}|\\w+)\\s*=\\s*require\\s*\\(\\s*['\"]([^'\"]+)['\"]\\s*\\)",
      description: "CommonJS require",
      version: 1,
    },
    {
      id: "js-import-dynamic",
      language: "javascript",
      kind: "import",
      pattern: "import('$SOURCE')",
      regex: "import\\s*\\(\\s*['\"]([^'\"]+)['\"]\\s*\\)",
      description: "Dynamic import",
      version: 1,
    },
    {
      id: "js-reference-identifier",
      language: "javascript",
      kind: "reference",
      regex: "\\b([a-zA-Z_$][\\w$]*)\\b",
      description: "Identifier reference (lexical fallback)",
      version: 1,
    },
  ],
};

const PYTHON_RULES: LanguageRuleSet = {
  language: "python",
  version: 1,
  rules: [
    {
      id: "py-function-def",
      language: "python",
      kind: "definition",
      pattern: "def $NAME($$$): $$$",
      regex: "(?:async\\s+)?def\\s+(\\w+)",
      description: "Function definition",
      version: 1,
    },
    {
      id: "py-class-def",
      language: "python",
      kind: "definition",
      pattern: "class $NAME($$$): $$$",
      regex: "class\\s+(\\w+)",
      description: "Class definition",
      version: 1,
    },
    {
      id: "py-assignment",
      language: "python",
      kind: "definition",
      pattern: "$NAME = $$$",
      regex: "^([a-zA-Z_]\\w*)\\s*=",
      description: "Top-level assignment",
      version: 1,
    },
    {
      id: "py-import",
      language: "python",
      kind: "import",
      pattern: "import $MODULE",
      regex: "^import\\s+([\\w.]+)",
      description: "Import statement",
      version: 1,
    },
    {
      id: "py-import-from",
      language: "python",
      kind: "import",
      pattern: "from $MODULE import $$$",
      regex: "^from\\s+([\\w.]+)\\s+import",
      description: "From import statement",
      version: 1,
    },
    {
      id: "py-reference-identifier",
      language: "python",
      kind: "reference",
      regex: "\\b([a-zA-Z_]\\w*)\\b",
      description: "Identifier reference (lexical fallback)",
      version: 1,
    },
  ],
};

const RUST_RULES: LanguageRuleSet = {
  language: "rust",
  version: 1,
  rules: [
    {
      id: "rust-fn-decl",
      language: "rust",
      kind: "definition",
      pattern: "fn $NAME($$$) { $$$ }",
      regex: "(?:pub\\s+)?(?:async\\s+)?fn\\s+(\\w+)",
      description: "Function declaration",
      version: 1,
    },
    {
      id: "rust-struct-decl",
      language: "rust",
      kind: "definition",
      pattern: "struct $NAME { $$$ }",
      regex: "(?:pub\\s+)?struct\\s+(\\w+)",
      description: "Struct declaration",
      version: 1,
    },
    {
      id: "rust-enum-decl",
      language: "rust",
      kind: "definition",
      pattern: "enum $NAME { $$$ }",
      regex: "(?:pub\\s+)?enum\\s+(\\w+)",
      description: "Enum declaration",
      version: 1,
    },
    {
      id: "rust-trait-decl",
      language: "rust",
      kind: "definition",
      pattern: "trait $NAME { $$$ }",
      regex: "(?:pub\\s+)?trait\\s+(\\w+)",
      description: "Trait declaration",
      version: 1,
    },
    {
      id: "rust-type-decl",
      language: "rust",
      kind: "definition",
      pattern: "type $NAME = $$$",
      regex: "(?:pub\\s+)?type\\s+(\\w+)",
      description: "Type alias declaration",
      version: 1,
    },
    {
      id: "rust-impl-decl",
      language: "rust",
      kind: "definition",
      pattern: "impl $NAME { $$$ }",
      regex: "impl\\s+(?:\\w+\\s+for\\s+)?(\\w+)",
      description: "Impl block",
      version: 1,
    },
    {
      id: "rust-use",
      language: "rust",
      kind: "import",
      pattern: "use $$$",
      regex: "(?:pub\\s+)?use\\s+([\\w:]+(?:\\:\\:\\*)?)",
      description: "Use statement",
      version: 1,
    },
    {
      id: "rust-reference-identifier",
      language: "rust",
      kind: "reference",
      regex: "\\b([a-zA-Z_]\\w*)\\b",
      description: "Identifier reference (lexical fallback)",
      version: 1,
    },
  ],
};

const GO_RULES: LanguageRuleSet = {
  language: "go",
  version: 1,
  rules: [
    {
      id: "go-func-decl",
      language: "go",
      kind: "definition",
      pattern: "func $NAME($$$) $$$ { $$$ }",
      regex: "func\\s+(\\w+)",
      description: "Function declaration",
      version: 1,
    },
    {
      id: "go-method-decl",
      language: "go",
      kind: "definition",
      pattern: "func ($$$) $NAME($$$) $$$ { $$$ }",
      regex: "func\\s*\\([^)]+\\)\\s*(\\w+)",
      description: "Method declaration",
      version: 1,
    },
    {
      id: "go-type-decl",
      language: "go",
      kind: "definition",
      pattern: "type $NAME $$$",
      regex: "type\\s+(\\w+)",
      description: "Type declaration",
      version: 1,
    },
    {
      id: "go-var-decl",
      language: "go",
      kind: "definition",
      pattern: "var $NAME $$$",
      regex: "var\\s+(\\w+)",
      description: "Var declaration",
      version: 1,
    },
    {
      id: "go-const-decl",
      language: "go",
      kind: "definition",
      pattern: "const $NAME $$$",
      regex: "const\\s+(\\w+)",
      description: "Const declaration",
      version: 1,
    },
    {
      id: "go-import",
      language: "go",
      kind: "import",
      pattern: "import $$$",
      regex: 'import\\s+(?:\\(\\s*)?["\']([^"\']+)["\']',
      description: "Import statement",
      version: 1,
    },
    {
      id: "go-reference-identifier",
      language: "go",
      kind: "reference",
      regex: "\\b([a-zA-Z_]\\w*)\\b",
      description: "Identifier reference (lexical fallback)",
      version: 1,
    },
  ],
};

const JSON_RULES: LanguageRuleSet = {
  language: "json",
  version: 1,
  rules: [
    {
      id: "json-top-key",
      language: "json",
      kind: "definition",
      regex: '"([^"]+)"\\s*:',
      description: "Top-level JSON key (inventory only, no structural claims)",
      version: 1,
    },
  ],
};

const CSS_RULES: LanguageRuleSet = {
  language: "css",
  version: 1,
  rules: [
    {
      id: "css-selector",
      language: "css",
      kind: "definition",
      regex: "^([.#]?[a-zA-Z][\\w-]*)",
      description: "CSS selector (inventory only)",
      version: 1,
    },
    {
      id: "css-import",
      language: "css",
      kind: "import",
      regex: '@import\\s+(?:url\\s*\\(\\s*)?["\']?([^"\')\\s]+)',
      description: "CSS @import",
      version: 1,
    },
  ],
};

const HTML_RULES: LanguageRuleSet = {
  language: "html",
  version: 1,
  rules: [
    {
      id: "html-script-src",
      language: "html",
      kind: "import",
      regex: '<script[^>]+src=["\']([^"\']+)["\']',
      description: "Script src reference",
      version: 1,
    },
    {
      id: "html-link-href",
      language: "html",
      kind: "import",
      regex: '<link[^>]+href=["\']([^"\']+)["\']',
      description: "Link href reference",
      version: 1,
    },
  ],
};

const MARKDOWN_RULES: LanguageRuleSet = {
  language: "markdown",
  version: 1,
  rules: [
    {
      id: "md-heading",
      language: "markdown",
      kind: "definition",
      regex: "^(#{1,6})\\s+(.+)$",
      description: "Markdown heading (inventory only)",
      version: 1,
    },
    {
      id: "md-link",
      language: "markdown",
      kind: "reference",
      regex: "\\[([^\\]]+)\\]\\(([^)]+)\\)",
      description: "Markdown link reference",
      version: 1,
    },
  ],
};

const YAML_RULES: LanguageRuleSet = {
  language: "yaml",
  version: 1,
  rules: [
    {
      id: "yaml-top-key",
      language: "yaml",
      kind: "definition",
      regex: "^([a-zA-Z_][\\w-]*)\\s*:",
      description: "Top-level YAML key (inventory only)",
      version: 1,
    },
  ],
};

/**
 * Complete set of CPB-owned extraction rules, keyed by language.
 */
const LANGUAGE_RULE_SETS: ReadonlyMap<SupportedLanguage, LanguageRuleSet> =
  new Map<SupportedLanguage, LanguageRuleSet>([
    ["typescript", TYPESCRIPT_RULES],
    ["typescriptreact", TYPESCRIPT_RULES],
    ["javascript", JAVASCRIPT_RULES],
    ["javascriptreact", JAVASCRIPT_RULES],
    ["json", JSON_RULES],
    ["python", PYTHON_RULES],
    ["rust", RUST_RULES],
    ["go", GO_RULES],
    ["css", CSS_RULES],
    ["html", HTML_RULES],
    ["markdown", MARKDOWN_RULES],
    ["yaml", YAML_RULES],
  ]);

// ── Symbol schema ────────────────────────────────────────────────────────────

/**
 * Symbol schema version.  Bump when the shape of extracted definitions,
 * references, or imports changes.
 */
export const SYMBOL_SCHEMA_VERSION = 2;

/**
 * Canonical symbol schema hash.
 *
 * Computed from the structural shape of ExtractedDefinition,
 * ExtractedReference, and ExtractedImport.  Bump when any field is
 * added, removed, or its type changes.
 */
const SYMBOL_SCHEMA_HASH_SEED = [
  "ExtractedDefinition:name:string",
  "ExtractedDefinition:kind:string",
  "ExtractedDefinition:range:SourceRange",
  "ExtractedDefinition:exported:boolean",
  "ExtractedDefinition:signature:string|null",
  "ExtractedReference:name:string",
  "ExtractedReference:range:SourceRange",
  "ExtractedReference:referenceKind:enum",
  "ExtractedImport:requested:string",
  "ExtractedImport:range:SourceRange",
  "ExtractedImport:importKind:enum",
].join("\0");

const SYMBOL_SCHEMA_HASH = createHash("sha256")
  .update(SYMBOL_SCHEMA_HASH_SEED)
  .digest("hex")
  .slice(0, 16);

// ── Language extractor fingerprint ───────────────────────────────────────────

/**
 * Compute the language extractor fingerprint for a given language.
 *
 * The fingerprint is derived from:
 * 1. Parser version (ast-grep version string, or null for fallback modes)
 * 2. Rule bytes (canonical hash of the language rule set)
 * 3. Symbol schema version and hash
 * 4. Language mapping (the effective language identifier)
 * 5. Effective language
 * 6. Parser mode
 *
 * This fingerprint is included in the file object ID derivation.  Any
 * change to the above inputs invalidates affected file objects and cannot
 * silently reuse old symbol data (spec section 8.4).
 *
 * @param language The effective language.
 * @param parserMode The parser mode used.
 * @param parserVersion The ast-grep version string, or null if unavailable.
 * @returns A 32-hex-char fingerprint string.
 */
/**
 * @ast-grep/napi package version, read once for extractor-fingerprint salting.
 * "unknown" when the optional dependency is absent. flow-2hh: references are
 * extracted in-process via @ast-grep/napi; salting the fingerprint with the
 * backend + version ensures a native-backend rebuild cannot reuse (or collide
 * with) a prior CLI-backend index, and that a napi version bump rebuilds.
 */
export const NAPI_BACKEND_VERSION: string = readOptionalPackageVersion("@ast-grep/napi") ?? "unknown";

/**
 * Installed @ast-grep/lang-* pack versions ("name:ver,...", "absent" if the
 * optional dep is missing). Salts the extractor fingerprint so a language-pack
 * bump (which can change that language's references) invalidates the index.
 */
export const LANG_PACK_VERSIONS: string = (() => {
  const names = ["@ast-grep/lang-python", "@ast-grep/lang-go", "@ast-grep/lang-rust"];
  const parts: string[] = [];
  for (const name of names) {
    parts.push(`${name}:${readOptionalPackageVersion(name) ?? "absent"}`);
  }
  return parts.join(",");
})();

/**
 * The shared backend-identity salt added to BOTH extractor fingerprints
 * (per-file and snapshot), so the references backend (napi + lang packs) is
 * captured in exactly one place and cannot drift between the two fingerprints.
 */
export function backendFingerprintSalt(): readonly string[] {
  return [
    "extractor-backend:napi",
    `napi-version:${NAPI_BACKEND_VERSION}`,
    `lang-pack-versions:${LANG_PACK_VERSIONS}`,
  ];
}

export function computeLanguageExtractorFingerprint(
  language: SupportedLanguage,
  parserMode: ParserMode,
  parserVersion: string | null,
): string {
  const ruleSet = LANGUAGE_RULE_SETS.get(language);
  const ruleHash = ruleSet
    ? objectId(ruleSet)
    : createHash("sha256").update("no-rules").digest("hex");

  const fingerprint = [
    `parser-version:${parserVersion ?? "none"}`,
    `rule-hash:${ruleHash}`,
    `symbol-schema-version:${SYMBOL_SCHEMA_VERSION}`,
    `symbol-schema-hash:${SYMBOL_SCHEMA_HASH}`,
    `language:${language}`,
    `parser-mode:${parserMode}`,
    ...backendFingerprintSalt(),
  ].join("\0");

  return createHash("sha256").update(fingerprint).digest("hex").slice(0, 32);
}

/**
 * Compute the file object ID for a file extraction result.
 *
 * Spec section 7.3:
 *   SHA-256(
 *     "cpb-file-object-v2\0" +
 *     effective-language + "\0" +
 *     parser-mode + "\0" +
 *     language-extractor-fingerprint + "\0" +
 *     source-content-id
 *   )
 *
 * @param language The effective language.
 * @param parserMode The parser mode used.
 * @param extractorFingerprint The language extractor fingerprint.
 * @param sourceContentId SHA-256 hex digest of the source bytes.
 * @returns 64-hex-char file object ID.
 */
export function computeFileObjectId(
  language: SupportedLanguage,
  parserMode: ParserMode,
  extractorFingerprint: string,
  sourceContentId: string,
): string {
  const payload = [
    "cpb-file-object-v2",
    language,
    parserMode,
    extractorFingerprint,
    sourceContentId,
  ].join("\0");

  return createHash("sha256").update(payload).digest("hex");
}

// ── Source content ID ────────────────────────────────────────────────────────

/**
 * Compute the SHA-256 hex digest of source bytes.
 *
 * This is the source content ID used in file object ID derivation and
 * stored in file objects.
 *
 * @param sourceBytes The raw source file bytes.
 * @returns 64-hex-char SHA-256 digest.
 */
export function computeSourceContentId(sourceBytes: Uint8Array): string {
  return createHash("sha256").update(sourceBytes).digest("hex");
}

// ── Source range helper ──────────────────────────────────────────────────────

/**
 * Compute a source range from a regex match in source text.
 *
 * Counts newlines before the match to determine start line and column.
 *
 * @param sourceText The full source text.
 * @param matchIndex The character index of the match start.
 * @param matchLength The length of the matched text.
 * @returns A SourceRange with 1-based line numbers and 1-based columns.
 */
function rangeFromMatch(
  sourceText: string,
  matchIndex: number,
  matchLength: number,
): SourceRange {
  let startLine = 1;
  let startColumn = 1;
  for (let i = 0; i < matchIndex; i++) {
    if (sourceText.charCodeAt(i) === 10) {
      // \n
      startLine++;
      startColumn = 1;
    } else {
      startColumn++;
    }
  }

  let endLine = startLine;
  let endColumn = startColumn + matchLength;
  for (let i = matchIndex; i < matchIndex + matchLength; i++) {
    if (sourceText.charCodeAt(i) === 10) {
      endLine++;
      endColumn = 1;
    } else {
      endColumn++;
    }
  }

  return { startLine, startColumn, endLine, endColumn };
}

// ── Lexical extraction ───────────────────────────────────────────────────────

/**
 * Extract file facts using lexical (regex-based) patterns.
 *
 * This is the fallback when ast-grep is unavailable.  It produces
 * definitions and raw references but does NOT claim structural completeness.
 * Results are labeled with coverage `"lexical-reference-fallback"`.
 *
 * @param sourceText The source file content as a string.
 * @param language The effective language.
 * @param extractorFingerprint The language extractor fingerprint.
 * @param sourceContentId SHA-256 hex digest of the source bytes.
 * @param byteSize Byte size of the source file.
 * @returns A FileExtractionResult with lexical coverage.
 */
export function extractLexical(
  sourceText: string,
  language: SupportedLanguage,
  extractorFingerprint: string,
  sourceContentId: string,
  byteSize: number,
): FileExtractionResult {
  const ruleSet = LANGUAGE_RULE_SETS.get(language);
  const definitions: ExtractedDefinition[] = [];
  const references: ExtractedReference[] = [];
  const imports: ExtractedImport[] = [];
  const errors: ExtractedParserError[] = [];
  const truncation: ExtractedTruncationMarker[] = [];

  if (!ruleSet) {
    // No rules for this language — file inventory only.
    return {
      sourceContentId,
      byteSize,
      language,
      parserMode: "file-inventory-only",
      extractorFingerprint,
      coverage: "file-inventory-only",
      definitions: [],
      references: [],
      imports: [],
      errors: [],
      truncation: [],
    };
  }

  const definitionNameSet = new Set<string>();
  const referenceNameSet = new Set<string>();
  const importSpecifierSet = new Set<string>();

  for (const rule of ruleSet.rules) {
    const regexStr = rule.regex;
    if (!regexStr) continue;

    let regex: RegExp;
    try {
      regex = new RegExp(regexStr, "gm");
    } catch {
      errors.push({
        message: `Invalid regex in rule ${rule.id}: ${regexStr}`,
        range: null,
        severity: "warning",
      });
      continue;
    }

    let match: RegExpExecArray | null;
    while ((match = regex.exec(sourceText)) !== null) {
      const matchRange = rangeFromMatch(sourceText, match.index, match[0].length);

      switch (rule.kind) {
        case "definition": {
          if (definitions.length >= MAX_SYMBOLS_PER_FILE) {
            if (truncation.every((t) => t.limitKind !== "max-symbols")) {
              truncation.push({
                limitKind: "max-symbols",
                limit: MAX_SYMBOLS_PER_FILE,
                actual: definitions.length,
              });
            }
            break;
          }
          const name = match[1];
          if (name && !definitionNameSet.has(name)) {
            definitionNameSet.add(name);
            definitions.push({
              name,
              kind: inferDefinitionKind(rule.id),
              range: matchRange,
              exported: isExportedMatch(match[0]),
              signature: null,
            });
          }
          break;
        }
        case "reference": {
          if (references.length >= MAX_REFERENCES_PER_FILE) {
            if (truncation.every((t) => t.limitKind !== "max-references")) {
              truncation.push({
                limitKind: "max-references",
                limit: MAX_REFERENCES_PER_FILE,
                actual: references.length,
              });
            }
            break;
          }
          const name = match[1];
          if (name && !definitionNameSet.has(name)) {
            const key = `${name}:${matchRange.startLine}:${matchRange.startColumn}`;
            if (!referenceNameSet.has(key)) {
              referenceNameSet.add(key);
              references.push({
                name,
                range: matchRange,
                referenceKind: "unknown",
              });
            }
          }
          break;
        }
        case "import": {
          // The import specifier is typically in the last capture group
          // that looks like a path or module name.
          const specifier = findImportSpecifier(match);
          if (specifier && !importSpecifierSet.has(specifier)) {
            importSpecifierSet.add(specifier);
            imports.push({
              requested: specifier,
              range: matchRange,
              importKind: inferImportKind(rule.id, match[0]),
            });
          }
          break;
        }
        // "export" rules are not separately extracted in lexical mode;
        // exports are reflected in the `exported` flag on definitions.
        default:
          break;
      }
    }
  }

  return {
    sourceContentId,
    byteSize,
    language,
    parserMode: "lexical-fallback",
    extractorFingerprint,
    coverage: "lexical-reference-fallback",
    definitions,
    references,
    imports,
    errors,
    truncation,
  };
}

// ── File inventory extraction ────────────────────────────────────────────────

/**
 * Produce a file-inventory-only extraction result.
 *
 * Used when:
 * - The file language is not recognized.
 * - The file exceeds the size limit.
 * - ast-grep is unavailable and no lexical rules exist.
 * - The file is JSON, YAML, CSS, HTML, or Markdown (inventory-only coverage).
 *
 * @param language The effective language (or null for unrecognized).
 * @param extractorFingerprint The language extractor fingerprint.
 * @param sourceContentId SHA-256 hex digest of the source bytes.
 * @param byteSize Byte size of the source file.
 * @returns A FileExtractionResult with file-inventory-only coverage.
 */
export function extractInventoryOnly(
  language: SupportedLanguage | null,
  extractorFingerprint: string,
  sourceContentId: string,
  byteSize: number,
): FileExtractionResult {
  return {
    sourceContentId,
    byteSize,
    language: language ?? ("unknown" as SupportedLanguage),
    parserMode: "file-inventory-only",
    extractorFingerprint,
    coverage: "file-inventory-only",
    definitions: [],
    references: [],
    imports: [],
    errors: [],
    truncation: [],
  };
}

// ── Main extraction entry point ──────────────────────────────────────────────

/**
 * Extract path-independent file facts from source bytes.
 *
 * This is the main entry point for file extraction.  It selects the
 * appropriate extraction mode based on the language and available
 * tools, then produces definitions, references, raw imports, signatures,
 * parser errors, and truncation markers.
 *
 * The result contains only path-independent facts.  No absolute path,
 * source-relative path, resolved import target, package resolution
 * result, or repository configuration is included.
 *
 * When `astGrepResult` is provided (from the ast-grep adapter), it is
 * used for structural extraction.  When `null`, the function falls back
 * to lexical extraction if rules exist, or file-inventory-only otherwise.
 *
 * @param sourceBytes The raw source file bytes.
 * @param filePath The source file path (used only for language detection).
 * @param parserVersion The ast-grep version string, or null if unavailable.
 * @param astGrepResult Pre-parsed ast-grep output, or null for fallback.
 * @returns A FileExtractionResult.
 */
export function extractFileFacts(
  sourceBytes: Uint8Array,
  filePath: string,
  parserVersion: string | null,
  astGrepResult: AstGrepParseResult | null,
): FileExtractionResult {
  const byteSize = sourceBytes.byteLength;
  const sourceContentId = computeSourceContentId(sourceBytes);
  const language = languageForFile(filePath);
  const extractorFingerprint = language
    ? computeLanguageExtractorFingerprint(
        language,
        astGrepResult ? "structural" : "lexical-fallback",
        parserVersion,
      )
    : computeLanguageExtractorFingerprint(
        "unknown" as SupportedLanguage,
        "file-inventory-only",
        parserVersion,
      );

  // No recognized language — file inventory only.
  if (!language) {
    return extractInventoryOnly(null, extractorFingerprint, sourceContentId, byteSize);
  }

  // Oversized files get file-inventory-only coverage.
  if (byteSize > MAX_INDEX_FILE_SIZE_BYTES) {
    const result = extractInventoryOnly(
      language,
      extractorFingerprint,
      sourceContentId,
      byteSize,
    );
    return {
      ...result,
      truncation: [
        ...result.truncation,
        {
          limitKind: "max-file-size",
          limit: MAX_INDEX_FILE_SIZE_BYTES,
          actual: byteSize,
        },
      ],
    };
  }

  // Languages with no structural claims get file-inventory-only.
  const inventoryOnlyLanguages: ReadonlySet<SupportedLanguage> = new Set([
    "json",
    "yaml",
    "css",
    "html",
    "markdown",
  ]);
  if (inventoryOnlyLanguages.has(language)) {
    // For these languages, still do lexical extraction if rules exist,
    // but label as file-inventory-only since no structural claims are made.
    const ruleSet = LANGUAGE_RULE_SETS.get(language);
    if (ruleSet && ruleSet.rules.length > 0) {
      // Do lexical extraction for import/export inventory.
      const sourceText = new TextDecoder().decode(sourceBytes);
      const result = extractLexical(
        sourceText,
        language,
        extractorFingerprint,
        sourceContentId,
        byteSize,
      );
      // Override coverage to file-inventory-only since these languages
      // don't support structural extraction.
      return { ...result, coverage: "file-inventory-only" };
    }
    return extractInventoryOnly(language, extractorFingerprint, sourceContentId, byteSize);
  }

  // Structural extraction via ast-grep.
  if (astGrepResult) {
    return extractStructural(
      sourceBytes,
      language,
      parserVersion,
      extractorFingerprint,
      sourceContentId,
      byteSize,
      astGrepResult,
    );
  }

  // Lexical fallback when ast-grep is unavailable.
  const sourceText = new TextDecoder().decode(sourceBytes);
  return extractLexical(
    sourceText,
    language,
    extractorFingerprint,
    sourceContentId,
    byteSize,
  );
}

// ── Structural extraction (ast-grep adapter output) ──────────────────────────

/**
 * Input from the ast-grep adapter for structural extraction.
 *
 * This type represents pre-parsed output from the ast-grep process
 * adapter.  The adapter is responsible for invoking ast-grep, validating
 * output, and producing this intermediate representation.
 */
export type AstGrepParseResult = Readonly<{
  /** ast-grep version string. */
  version: string;
  /** Whether the parse completed without errors. */
  success: boolean;
  /** Raw ast-grep output nodes. */
  nodes: readonly AstGrepNode[];
  /** Parser errors from ast-grep. */
  parseErrors: readonly string[];
}>;

/**
 * A single node from ast-grep output.
 */
export type AstGrepNode = Readonly<{
  /** Node kind (e.g., "function_declaration", "identifier"). */
  kind: string;
  /** Text content of the node. */
  text: string;
  /** Start position. */
  start: Readonly<{ line: number; column: number }>;
  /** End position. */
  end: Readonly<{ line: number; column: number }>;
  /** Named children of this node. */
  children?: readonly AstGrepNode[];
  /** Whether this node is exported (for declarations). */
  isExported?: boolean;
  /** True when an identifier names its enclosing declaration, not a use. */
  isDefinitionName?: boolean;
}>;

/**
 * Extract file facts from structural ast-grep output.
 *
 * Converts ast-grep nodes into ExtractedDefinition, ExtractedReference,
 * and ExtractedImport records.  All results are path-independent.
 */
function extractStructural(
  sourceBytes: Uint8Array,
  language: SupportedLanguage,
  parserVersion: string | null,
  extractorFingerprint: string,
  sourceContentId: string,
  byteSize: number,
  astGrepResult: AstGrepParseResult,
): FileExtractionResult {
  const definitions: ExtractedDefinition[] = [];
  const references: ExtractedReference[] = [];
  const imports: ExtractedImport[] = [];
  const errors: ExtractedParserError[] = [];
  const truncation: ExtractedTruncationMarker[] = [];

  // Convert parse errors.
  for (const errMsg of astGrepResult.parseErrors) {
    errors.push({
      message: errMsg,
      range: null,
      severity: "error",
    });
  }

  // Walk ast-grep nodes and extract facts.
  for (const node of astGrepResult.nodes) {
    extractFromNode(node, definitions, references, imports, truncation, language);
  }

  // Check for truncation.
  if (definitions.length >= MAX_SYMBOLS_PER_FILE && !truncation.some((t) => t.limitKind === "max-symbols")) {
    truncation.push({
      limitKind: "max-symbols",
      limit: MAX_SYMBOLS_PER_FILE,
      actual: definitions.length,
    });
  }
  if (references.length >= MAX_REFERENCES_PER_FILE && !truncation.some((t) => t.limitKind === "max-references")) {
    truncation.push({
      limitKind: "max-references",
      limit: MAX_REFERENCES_PER_FILE,
      actual: references.length,
    });
  }

  return {
    sourceContentId,
    byteSize,
    language,
    parserMode: "structural",
    extractorFingerprint,
    coverage: "ast-grep-structural",
    definitions,
    references,
    imports,
    errors,
    truncation,
  };
}

/**
 * Recursively extract facts from an ast-grep node tree.
 */
function extractFromNode(
  node: AstGrepNode,
  definitions: ExtractedDefinition[],
  references: ExtractedReference[],
  imports: ExtractedImport[],
  truncation: ExtractedTruncationMarker[],
  _language: SupportedLanguage,
): void {
  const range: SourceRange = {
    startLine: node.start.line,
    startColumn: node.start.column,
    endLine: node.end.line,
    endColumn: node.end.column,
  };

  const kind = node.kind;

  // Definition nodes.
  if (
    kind === "function_declaration" ||
    kind === "class_declaration" ||
    kind === "interface_declaration" ||
    kind === "type_alias_declaration" ||
    kind === "enum_declaration" ||
    kind === "variable_declaration" ||
    kind === "lexical_declaration" ||
    kind === "method_definition"
  ) {
    if (definitions.length < MAX_SYMBOLS_PER_FILE) {
      const name = extractNameFromNode(node);
      if (name) {
        const signature = extractSignatureFromNode(node);
        definitions.push({
          name,
          kind: mapNodeKindToSymbolKind(kind),
          range,
          exported: node.isExported ?? false,
          signature:
            signature && signature.length <= MAX_SIGNATURE_SIZE_BYTES
              ? signature
              : null,
        });
      }
    }
  }

  // Import nodes.
  if (
    kind === "import_statement" ||
    kind === "import_from_statement" ||
    kind === "call_expression" // for require() and import()
  ) {
    if (imports.length < MAX_SYMBOLS_PER_FILE) {
      const specifier = extractImportSpecifierFromNode(node);
      if (specifier) {
        imports.push({
          requested: specifier,
          range,
          importKind: inferImportKindFromNodeKind(kind, node.text),
        });
      }
    }
  }

  // Reference nodes (identifiers that are not definitions or imports).
  if (
    (kind === "identifier" || kind === "type_identifier")
    && node.isDefinitionName !== true
  ) {
    if (references.length < MAX_REFERENCES_PER_FILE) {
      references.push({
        name: node.text,
        range,
        referenceKind: kind === "type_identifier" ? "type" : "unknown",
      });
    }
  }

  // Recurse into children.
  if (node.children) {
    for (const child of node.children) {
      extractFromNode(child, definitions, references, imports, truncation, _language);
    }
  }
}

/**
 * Extract the name from a definition node.
 */
function extractNameFromNode(node: AstGrepNode): string | null {
  if (node.children) {
    for (const child of node.children) {
      if (child.kind === "identifier" || child.kind === "type_identifier") {
        return child.text;
      }
    }
  }
  // Fallback: try to extract from the text.
  const text = node.text;
  const match = text.match(
    /(?:function|class|interface|type|enum|const|let|var|fn|struct|trait|impl|def)\s+(\w+)/,
  );
  return match?.[1] ?? null;
}

/**
 * Extract a signature from a definition node.
 */
function extractSignatureFromNode(node: AstGrepNode): string | null {
  // For functions and methods, extract the parameter list.
  if (
    node.kind === "function_declaration" ||
    node.kind === "method_definition"
  ) {
    const text = node.text;
    const parenStart = text.indexOf("(");
    const parenEnd = text.indexOf(")");
    if (parenStart >= 0 && parenEnd > parenStart) {
      return text.slice(parenStart, parenEnd + 1);
    }
  }
  return null;
}

/**
 * Extract an import specifier from an import node.
 */
function extractImportSpecifierFromNode(node: AstGrepNode): string | null {
  // Look for string literals in children.
  if (node.children) {
    for (const child of node.children) {
      if (
        child.kind === "string" ||
        child.kind === "string_literal"
      ) {
        // Strip quotes.
        const text = child.text;
        if (
          (text.startsWith('"') && text.endsWith('"')) ||
          (text.startsWith("'") && text.endsWith("'"))
        ) {
          return text.slice(1, -1);
        }
        return text;
      }
    }
  }
  // Fallback: regex on the text.
  const match = node.text.match(/['"]([^'"]+)['"]/);
  return match?.[1] ?? null;
}

/**
 * Map ast-grep node kind to a human-readable symbol kind.
 */
function mapNodeKindToSymbolKind(kind: string): string {
  switch (kind) {
    case "function_declaration":
      return "function";
    case "class_declaration":
      return "class";
    case "interface_declaration":
      return "interface";
    case "type_alias_declaration":
      return "type";
    case "enum_declaration":
      return "enum";
    case "variable_declaration":
    case "lexical_declaration":
      return "variable";
    case "method_definition":
      return "method";
    default:
      return "unknown";
  }
}

/**
 * Infer import kind from node kind and text.
 */
function inferImportKindFromNodeKind(
  kind: string,
  text: string,
): ExtractedImport["importKind"] {
  if (kind === "call_expression") {
    if (/require\s*\(/.test(text)) return "cjs";
    if (/import\s*\(/.test(text)) return "dynamic";
  }
  if (/import\s+type\b/.test(text)) return "type-only";
  return "esm";
}

// ── Lexical helper functions ─────────────────────────────────────────────────

/**
 * Infer definition kind from a rule ID.
 */
function inferDefinitionKind(ruleId: string): string {
  if (ruleId.includes("function") || ruleId.includes("func") || ruleId.includes("fn"))
    return "function";
  if (ruleId.includes("class")) return "class";
  if (ruleId.includes("interface")) return "interface";
  if (ruleId.includes("type")) return "type";
  if (ruleId.includes("enum")) return "enum";
  if (ruleId.includes("struct")) return "struct";
  if (ruleId.includes("trait")) return "trait";
  if (ruleId.includes("impl")) return "impl";
  if (ruleId.includes("const")) return "variable";
  if (ruleId.includes("let")) return "variable";
  if (ruleId.includes("var")) return "variable";
  if (ruleId.includes("assignment")) return "variable";
  if (ruleId.includes("heading")) return "heading";
  if (ruleId.includes("selector")) return "selector";
  if (ruleId.includes("key")) return "key";
  return "unknown";
}

/**
 * Check if a regex match text indicates an exported declaration.
 */
function isExportedMatch(matchText: string): boolean {
  return /^\s*export\b/.test(matchText) || /\bpub\s+/.test(matchText);
}

/**
 * Find the import specifier from a regex match.
 *
 * The specifier is typically in the last capture group that looks like
 * a path or module name.
 */
function findImportSpecifier(match: RegExpExecArray): string | null {
  // Iterate capture groups from last to first, looking for a path-like string.
  for (let i = match.length - 1; i >= 1; i--) {
    const group = match[i];
    if (group && (group.includes("/") || group.includes(".") || group.startsWith("@"))) {
      return group;
    }
  }
  // Fallback: use the first non-empty capture group.
  for (let i = 1; i < match.length; i++) {
    if (match[i]) return match[i];
  }
  return null;
}

/**
 * Infer import kind from a rule ID and match text.
 */
function inferImportKind(
  ruleId: string,
  matchText: string,
): ExtractedImport["importKind"] {
  if (ruleId.includes("require")) return "cjs";
  if (ruleId.includes("dynamic")) return "dynamic";
  if (ruleId.includes("type")) return "type-only";
  if (ruleId.includes("use")) return "other";
  return "esm";
}

// ── Batch extraction ─────────────────────────────────────────────────────────

/**
 * Result of a batch extraction operation.
 */
export type BatchExtractionResult = Readonly<{
  /** Per-file extraction results, keyed by source-relative path. */
  readonly results: ReadonlyMap<string, FileExtractionResult>;
  /** Aggregate coverage summary across all files. */
  readonly coverage: LocalCodeIndexCoverage;
  /** Number of files that exceeded the size limit. */
  readonly oversizedFiles: number;
  /** Number of files with parser errors. */
  readonly failedFiles: number;
  /** Number of files that were parsed (not reused from cache). */
  readonly parsedFiles: number;
}>;

/**
 * Compute aggregate coverage from a set of per-file coverage values.
 *
 * The effective coverage is the weakest across all files.  Partial is
 * true when files have mixed coverage, failedFiles > 0, or
 * oversizedFiles > 0.
 *
 * @param coverages Per-file coverage values.
 * @param failedFiles Number of files with parser errors.
 * @param oversizedFiles Number of oversized files.
 * @returns Aggregate coverage summary.
 */
export function computeAggregateCoverage(
  coverages: readonly LocalCodeIndexCoverage[],
  failedFiles: number,
  oversizedFiles: number,
): { effective: LocalCodeIndexCoverage; partial: boolean } {
  const order: ReadonlyMap<LocalCodeIndexCoverage, number> = new Map([
    ["ast-grep-structural", 0],
    ["lexical-reference-fallback", 1],
    ["file-inventory-only", 2],
  ]);

  let weakest: LocalCodeIndexCoverage = "ast-grep-structural";
  let hasStructural = false;
  let hasLexical = false;
  let hasInventory = false;

  for (const coverage of coverages) {
    const rank = order.get(coverage) ?? 2;
    if (rank > (order.get(weakest) ?? 2)) {
      weakest = coverage;
    }
    if (coverage === "ast-grep-structural") hasStructural = true;
    if (coverage === "lexical-reference-fallback") hasLexical = true;
    if (coverage === "file-inventory-only") hasInventory = true;
  }

  const mixed =
    (hasStructural && hasLexical) ||
    (hasStructural && hasInventory) ||
    (hasLexical && hasInventory);

  return {
    effective: weakest,
    partial: mixed || failedFiles > 0 || oversizedFiles > 0,
  };
}
