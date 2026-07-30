import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalStringify,
  objectId,
} from "../core/indexing/local-code-index/canonical-json.js";

// ── canonicalStringify ────────────────────────────────────────────────────────

test("canonicalStringify: simple object", () => {
  const out = canonicalStringify({ b: 2, a: 1 });
  assert.equal(out, '{"a":1,"b":2}\n');
});

test("canonicalStringify: keys sorted regardless of insertion order", () => {
  // Build objects with deliberately reversed insertion orders.
  const order1: Record<string, number> = {};
  order1["z"] = 26;
  order1["m"] = 13;
  order1["a"] = 1;

  const order2: Record<string, number> = {};
  order2["a"] = 1;
  order2["m"] = 13;
  order2["z"] = 26;

  assert.equal(canonicalStringify(order1), canonicalStringify(order2));
  assert.equal(canonicalStringify(order1), '{"a":1,"m":13,"z":26}\n');
});

test("canonicalStringify: nested objects are recursively sorted", () => {
  const inner1: Record<string, unknown> = {};
  inner1["beta"] = 2;
  inner1["alpha"] = 1;

  const inner2: Record<string, unknown> = {};
  inner2["alpha"] = 1;
  inner2["beta"] = 2;

  const outer1 = { z: inner1, a: 10 };
  const outer2 = { a: 10, z: inner2 };

  assert.equal(canonicalStringify(outer1), canonicalStringify(outer2));
  assert.equal(
    canonicalStringify(outer1),
    '{"a":10,"z":{"alpha":1,"beta":2}}\n',
  );
});

test("canonicalStringify: deeply nested structure is stable", () => {
  const a = { l3: { b: 2, a: 1 }, x: true };
  const b = { x: true, l3: { a: 1, b: 2 } };
  assert.equal(canonicalStringify(a), canonicalStringify(b));
});

test("canonicalStringify: arrays preserve element order", () => {
  assert.equal(canonicalStringify([3, 1, 2]), "[3,1,2]\n");
});

test("canonicalStringify: array of objects", () => {
  const input = [
    { b: 2, a: 1 },
    { d: 4, c: 3 },
  ];
  assert.equal(
    canonicalStringify(input),
    '[{"a":1,"b":2},{"c":3,"d":4}]\n',
  );
});

test("canonicalStringify: primitive types", () => {
  assert.equal(canonicalStringify(null), "null\n");
  assert.equal(canonicalStringify(true), "true\n");
  assert.equal(canonicalStringify(false), "false\n");
  assert.equal(canonicalStringify(42), "42\n");
  assert.equal(canonicalStringify(3.14), "3.14\n");
  assert.equal(canonicalStringify("hello"), '"hello"\n');
  assert.equal(canonicalStringify(""), '""\n');
});

test("canonicalStringify: empty structures", () => {
  assert.equal(canonicalStringify({}), "{}\n");
  assert.equal(canonicalStringify([]), "[]\n");
});

test("canonicalStringify: no insignificant whitespace", () => {
  const out = canonicalStringify({ a: [1, 2], b: { c: 3 } });
  // No spaces after colons or commas (except inside strings).
  assert.ok(!out.includes(": "));
  assert.ok(!out.includes(", "));
  assert.equal(out, '{"a":[1,2],"b":{"c":3}}\n');
});

test("canonicalStringify: exactly one trailing newline", () => {
  const out = canonicalStringify({ x: 1 });
  assert.ok(out.endsWith("\n"), "must end with newline");
  assert.ok(!out.endsWith("\n\n"), "must not end with two newlines");
});

test("canonicalStringify: special string characters", () => {
  const out = canonicalStringify({ key: 'a "quoted" value\nwith newline' });
  // Must round-trip through JSON.parse.
  const parsed = JSON.parse(out);
  assert.equal(parsed.key, 'a "quoted" value\nwith newline');
});

test("canonicalStringify: unicode keys and values", () => {
  const out = canonicalStringify({ "é": "世界", a: 1 });
  const parsed = JSON.parse(out);
  assert.equal(parsed["é"], "世界");
  assert.equal(parsed.a, 1);
  // Keys must be sorted (é = 233, a = 97 → a comes first).
  assert.ok(out.indexOf('"a"') < out.indexOf('"é"'));
});

// ── objectId ──────────────────────────────────────────────────────────────────

test("objectId: returns 64-char hex string", () => {
  const id = objectId({ a: 1 });
  assert.match(id, /^[0-9a-f]{64}$/);
});

test("objectId: byte-stable across insertion orders", () => {
  const obj1: Record<string, number> = {};
  obj1["z"] = 26;
  obj1["a"] = 1;

  const obj2: Record<string, number> = {};
  obj2["a"] = 1;
  obj2["z"] = 26;

  assert.equal(objectId(obj1), objectId(obj2));
});

test("objectId: byte-stable across insertion orders in nested structures", () => {
  const buildA = () => {
    const inner: Record<string, number> = {};
    inner["beta"] = 2;
    inner["alpha"] = 1;
    const outer: Record<string, unknown> = {};
    outer["zulu"] = inner;
    outer["alfa"] = 0;
    return outer;
  };

  const buildB = () => {
    const inner: Record<string, number> = {};
    inner["alpha"] = 1;
    inner["beta"] = 2;
    const outer: Record<string, unknown> = {};
    outer["alfa"] = 0;
    outer["zulu"] = inner;
    return outer;
  };

  assert.equal(objectId(buildA()), objectId(buildB()));
});

test("objectId: different values produce different hashes", () => {
  const id1 = objectId({ a: 1 });
  const id2 = objectId({ a: 2 });
  assert.notEqual(id1, id2);
});

test("objectId: stable for primitives", () => {
  assert.equal(objectId(42), objectId(42));
  assert.equal(objectId("hello"), objectId("hello"));
  assert.notEqual(objectId(42), objectId("42"));
});

test("objectId: array order matters", () => {
  assert.notEqual(objectId([1, 2, 3]), objectId([3, 2, 1]));
});

test("objectId: matches manual SHA-256 of canonical output", async () => {
  // Construct the expected hash by hand.
  const { createHash } = await import("node:crypto");
  const canonical = canonicalStringify({ a: 1, b: 2 });
  const expected = createHash("sha256").update(canonical, "utf8").digest("hex");
  assert.equal(objectId({ a: 1, b: 2 }), expected);
  // Also prove the canonical form has the trailing newline baked in.
  assert.ok(canonical.endsWith("\n"));
});

test("objectId: large realistic structure is byte-stable", () => {
  const make = (order: "forward" | "reverse") => {
    const entries: [string, unknown][] = [
      ["path", "src/index.ts"],
      ["language", "typescript"],
      ["size", 12345],
      ["contentId", "abc123"],
      ["coverage", "ast-grep-structural"],
      [
        "definitions",
        [
          { symbol: "objectId", kind: "function", role: "definition" },
          { symbol: "canonicalStringify", kind: "function", role: "definition" },
        ],
      ],
      ["errors", []],
    ];
    if (order === "reverse") entries.reverse();
    return Object.fromEntries(entries);
  };

  assert.equal(objectId(make("forward")), objectId(make("reverse")));
});
