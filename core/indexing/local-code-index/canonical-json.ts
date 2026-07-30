/**
 * Canonical JSON serialization + deterministic object identity hashing.
 *
 *   canonicalStringify — byte-stable regardless of property insertion order.
 *   objectId            — full SHA-256 hex digest of a canonical UTF-8 payload.
 *
 * Used by the local-code-index layer to derive content-addressed identities
 * for index objects (files, symbols, relations) so that two semantically
 * identical objects always produce the same hash, regardless of how the
 * in-memory representation was assembled.
 *
 * Constraints:
 *   - No external dependencies.
 *   - Uses node:crypto for SHA-256 (built-in).
 *   - Output is always valid JSON terminated by exactly one trailing newline.
 *
 * Spec: docs/architecture/local-code-index-v2-spec.md
 */

import { createHash } from "node:crypto";

// ── canonicalStringify ────────────────────────────────────────────────────────

/**
 * Deterministic JSON serialization.
 *
 * Rules:
 *   1. Object keys are sorted lexicographically (by UTF-16 code unit, which
 *      is the same as `Array.prototype.sort()` default for ASCII-safe keys
 *      used throughout this codebase).
 *   2. No insignificant whitespace — no spaces after `:`, `,`, or inside
 *      brackets/braces.
 *   3. Strings are encoded as standard JSON strings (the built-in encoder
 *      is already deterministic for identical input).
 *   4. Arrays preserve element order (order is semantically significant).
 *   5. Primitives use the default JSON representation.
 *   6. The output is a single UTF-8 line terminated by exactly one `\n`.
 *
 * @param value - Any JSON-serializable value (no circular refs, no BigInt).
 * @returns A deterministic, newline-terminated JSON string.
 */
export function canonicalStringify(value: unknown): string {
  return _canonicalStringify(value) + "\n";
}

/** Internal recursive serializer — returns the JSON body without trailing newline. */
function _canonicalStringify(value: unknown): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
    case "number":
      // JSON.stringify handles -0, Infinity, NaN the same way we want (→ null).
      // For finite numbers it produces the shortest representation.
      return JSON.stringify(value) as string;

    case "string":
      return JSON.stringify(value) as string;

    case "object": {
      // Arrays — preserve order, recurse each element.
      if (Array.isArray(value)) {
        const items = value.map(_canonicalStringify);
        return "[" + items.join(",") + "]";
      }

      // Plain objects — sort keys, recurse each value.
      const keys = Object.keys(value as Record<string, unknown>).sort();
      const pairs = keys.map(
        (k) =>
          JSON.stringify(k) +
          ":" +
          _canonicalStringify(
            (value as Record<string, unknown>)[k],
          ),
      );
      return "{" + pairs.join(",") + "}";
    }

    default:
      // undefined, function, symbol, bigint — JSON.stringify returns undefined
      // for these; we follow the same convention and emit "null".
      return "null";
  }
}

// ── objectId ──────────────────────────────────────────────────────────────────

/**
 * Full SHA-256 hex digest of a value's canonical JSON representation.
 *
 * The input is first passed through `canonicalStringify`, then hashed as
 * UTF-8 bytes — so the hash is stable across insertion orders.
 *
 * @param value - Any JSON-serializable value.
 * @returns 64-character lowercase hex SHA-256 digest.
 */
export function objectId(value: unknown): string {
  const canonical = canonicalStringify(value);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
