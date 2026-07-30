/**
 * Local Code Index v2 — Extraction rule type definitions.
 *
 * These types define the structure of language-specific extraction rules
 * used by the lexical-reference-fallback coverage mode. Each rule file
 * (e.g., typescript.json, python.json) conforms to the ExtractionRules schema.
 *
 * Schema version: 1.0.0
 */

// ── Pattern types ─────────────────────────────────────────────────────────────

/** Named capture group definitions used across all pattern types. */
export type PatternCaptureGroups = Readonly<{
  /** The symbol name (required for definitions). */
  name?: string;
  /** Whether the symbol is exported. */
  exported?: string;
  /** Whether the function is async. */
  async?: string;
  /** Whether the function is a generator. */
  generator?: string;
  /** Generic type parameters. */
  generics?: string;
  /** Visibility modifier (public/private/protected). */
  access?: string;
  /** Static modifier. */
  static?: string;
  /** Abstract modifier. */
  abstract?: string;
  /** Override modifier. */
  override?: string;
  /** Readonly modifier. */
  readonly?: string;
  /** Decorator name. */
  decorator?: string;
  /** Import source path. */
  source?: string;
  /** Named imports list. */
  names?: string;
  /** Default import name. */
  default?: string;
  /** Namespace import (import * as X). */
  namespace?: string;
  /** Import alias. */
  alias?: string;
  /** Receiver (Go methods). */
  receiver?: string;
  /** Visibility (Go exports). */
  visibility?: string;
  /** Impl trait name (Rust). */
  trait?: string;
  /** Method/field modifiers (Java). */
  modifiers?: string;
  /** Return type (Java methods). */
  type?: string;
}>;

/** A definition extraction pattern. */
export type DefinitionPattern = Readonly<{
  /** The symbol kind this pattern produces (must be a key in symbolKinds). */
  kind: string;
  /** Regex pattern with named capture groups. */
  pattern: string;
  /** Regex flags (default: 'gm'). */
  flags?: string;
  /** Human-readable description. */
  description?: string;
  /** Whether the pattern must match at line start (default: true). */
  requiresLineStart?: boolean;
}>;

/** An import extraction pattern. */
export type ImportPattern = Readonly<{
  /** Regex pattern with named capture groups. */
  pattern: string;
  /** Regex flags (default: 'gm'). */
  flags?: string;
  /** Import binding kind. */
  kind?: "static" | "dynamic" | "require" | "all";
  /** Human-readable description. */
  description?: string;
}>;

/** An export extraction pattern. */
export type ExportPattern = Readonly<{
  /** Regex pattern with named capture groups. */
  pattern: string;
  /** Regex flags (default: 'gm'). */
  flags?: string;
  /** Export binding kind. */
  kind?: "named" | "default" | "re-export" | "all";
  /** Human-readable description. */
  description?: string;
}>;

/** A reference extraction pattern. */
export type ReferencePattern = Readonly<{
  /** Regex pattern for symbol references. */
  pattern: string;
  /** Regex flags (default: 'gm'). */
  flags?: string;
  /** Contexts to exclude (e.g., 'comment', 'string', 'definition'). */
  excludeContexts?: readonly string[];
  /** Human-readable description. */
  description?: string;
}>;

// ── Rule structure ────────────────────────────────────────────────────────────

/** Block folding rules for scope detection. */
export type FoldingRules = Readonly<{
  /** Regex matching the start of a foldable block. */
  startPattern: string;
  /** Regex matching the end of a foldable block. */
  endPattern: string;
}>;

/** Complete extraction rules for a single language. */
export type ExtractionRules = Readonly<{
  /** Rule schema version. Breaking changes increment the major version. */
  version: string;
  /** Canonical language identifier (lowercase, hyphen-separated). */
  language: string;
  /** Alternative names for this language. */
  aliases?: readonly string[];
  /** File extensions including the leading dot. */
  extensions: readonly string[];
  /** Enumeration of symbol kinds this language supports. */
  symbolKinds: Readonly<Record<string, string>>;
  /** Extraction patterns grouped by category. */
  patterns: Readonly<{
    /** Ordered list of definition patterns. First match wins. */
    definitions: readonly DefinitionPattern[];
    /** Import extraction patterns. */
    imports: readonly ImportPattern[];
    /** Export identification patterns. */
    exports: readonly ExportPattern[];
    /** Optional reference extraction patterns. */
    references?: readonly ReferencePattern[];
  }>;
  /** Optional block folding rules. */
  folding?: FoldingRules;
  /** Implementation notes or caveats. */
  notes?: string;
}>;

// ── Language registry ─────────────────────────────────────────────────────────

/** Supported language identifiers. */
export type SupportedLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java";

/** Map from file extension to language identifier. */
export const EXTENSION_TO_LANGUAGE: Readonly<Record<string, SupportedLanguage>> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".pyw": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
};

/** All supported language identifiers. */
export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = [
  "typescript",
  "javascript",
  "python",
  "go",
  "rust",
  "java",
];
