/**
 * Local Code Index v2 — Extraction rules barrel.
 *
 * Re-exports all rule types and the loader API.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type {
  PatternCaptureGroups,
  DefinitionPattern,
  ImportPattern,
  ExportPattern,
  ReferencePattern,
  FoldingRules,
  ExtractionRules,
  SupportedLanguage,
} from "./types.js";

export {
  EXTENSION_TO_LANGUAGE,
  SUPPORTED_LANGUAGES,
} from "./types.js";

// ── Loader ────────────────────────────────────────────────────────────────────

export {
  loadRules,
  languageForExtension,
  loadRulesForFile,
  getSupportedLanguages,
  getSupportedExtensions,
  isFileSupported,
  loadAllRules,
  clearRuleCache,
} from "./loader.js";
