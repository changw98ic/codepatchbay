/**
 * Local Code Index v2 — Extraction rule loader.
 *
 * Loads and caches language-specific extraction rules from JSON assets.
 * Provides lookup by language identifier or file extension.
 *
 * Schema version: 1.0.0
 */

import { readFileSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ExtractionRules,
  SupportedLanguage,
} from "./types.js";

import {
  EXTENSION_TO_LANGUAGE,
  SUPPORTED_LANGUAGES,
} from "./types.js";

// ── Rule cache ────────────────────────────────────────────────────────────────

const ruleCache = new Map<SupportedLanguage, ExtractionRules>();

/** Directory containing the JSON rule assets. */
const RULES_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Load extraction rules for a specific language.
 *
 * Results are cached after the first load. Throws if the rule file
 * is missing or contains invalid JSON.
 */
export function loadRules(language: SupportedLanguage): ExtractionRules {
  const cached = ruleCache.get(language);
  if (cached !== undefined) return cached;

  const filePath = join(RULES_DIR, `${language}.json`);
  const raw = readFileSync(filePath, "utf-8");
  const rules = JSON.parse(raw) as ExtractionRules;

  // Basic validation
  if (rules.version === undefined || rules.language === undefined) {
    throw new Error(
      `Invalid extraction rules for ${language}: missing version or language field`,
    );
  }
  if (rules.extensions === undefined || rules.extensions.length === 0) {
    throw new Error(
      `Invalid extraction rules for ${language}: extensions array is empty`,
    );
  }
  if (rules.patterns === undefined) {
    throw new Error(
      `Invalid extraction rules for ${language}: patterns object is missing`,
    );
  }

  ruleCache.set(language, rules);
  return rules;
}

/**
 * Look up the language for a file by its extension.
 *
 * Returns `undefined` if the extension is not in the supported set.
 */
export function languageForExtension(ext: string): SupportedLanguage | undefined {
  const normalized = ext.startsWith(".") ? ext : `.${ext}`;
  return EXTENSION_TO_LANGUAGE[normalized];
}

/**
 * Load rules for a file based on its path extension.
 *
 * Returns `undefined` if the file extension is not supported.
 */
export function loadRulesForFile(filePath: string): ExtractionRules | undefined {
  const ext = extname(filePath);
  const language = languageForExtension(ext);
  if (language === undefined) return undefined;
  return loadRules(language);
}

/**
 * Get the list of all supported language identifiers.
 */
export function getSupportedLanguages(): readonly SupportedLanguage[] {
  return SUPPORTED_LANGUAGES;
}

/**
 * Get all file extensions covered by the supported languages.
 */
export function getSupportedExtensions(): readonly string[] {
  return Object.keys(EXTENSION_TO_LANGUAGE);
}

/**
 * Check if a file path is supported for extraction.
 */
export function isFileSupported(filePath: string): boolean {
  const ext = extname(filePath);
  return languageForExtension(ext) !== undefined;
}

/**
 * Get all loaded rules (loads all languages if not already cached).
 *
 * Useful for building a combined symbol kind registry or generating
 * documentation.
 */
export function loadAllRules(): ReadonlyMap<SupportedLanguage, ExtractionRules> {
  for (const lang of SUPPORTED_LANGUAGES) {
    loadRules(lang);
  }
  return ruleCache;
}

/**
 * Clear the rule cache. Primarily useful for testing.
 */
export function clearRuleCache(): void {
  ruleCache.clear();
}
