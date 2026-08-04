import { createHash } from "node:crypto";

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

function canonicalJsonError(message: string): Error {
  return Object.assign(new TypeError(message), { code: "CANONICAL_JSON_INVALID" });
}

function assertWellFormedUnicode(value: string, location: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw canonicalJsonError(`unpaired high surrogate at ${location}`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw canonicalJsonError(`unpaired low surrogate at ${location}`);
    }
  }
}

function serializeCanonicalJson(value: unknown, ancestors: Set<object>, location: string): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    assertWellFormedUnicode(value, location);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw canonicalJsonError(`non-finite number at ${location}`);
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw canonicalJsonError(`unsupported ${typeof value} value at ${location}`);
  }

  if (ancestors.has(value)) {
    throw canonicalJsonError(`cyclic value at ${location}`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw canonicalJsonError(`sparse array item at ${location}[${index}]`);
        }
        items.push(serializeCanonicalJson(value[index], ancestors, `${location}[${index}]`));
      }
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw canonicalJsonError(`non-plain object at ${location}`);
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    for (const key of keys) assertWellFormedUnicode(key, `${location} key`);
    return `{${keys.map((key) => (
      `${JSON.stringify(key)}:${serializeCanonicalJson(record[key], ancestors, `${location}.${key}`)}`
    )).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * RFC 8785/JCS-compatible JSON for the JSON value domain used by CPB contracts.
 *
 * Distinct protocol from core/indexing/local-code-index/canonical-json.ts
 * (which serves content-addressed index identity under different rules: a
 * trailing newline, lenient coercion of undefined/bigint to null, and a bare
 * hex digest). The two must NOT be unified — merging would alter signed
 * release digests and index object identities. This serializer is the
 * authoritative canonical form for release-evidence signing.
 */
export function canonicalJson(value: unknown): string {
  return serializeCanonicalJson(value, new Set<object>(), "$");
}

export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}

export function sha256Identifier(bytes: string | NodeJS.ArrayBufferView): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function isSha256Identifier(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}
