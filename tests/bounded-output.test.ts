import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BoundedOutput,
  DEFAULT_SUBPROCESS_OUTPUT_MAX_BYTES,
  subprocessOutputMaxBytes,
} from "../shared/bounded-output.js";

test("BoundedOutput retains the newest bytes and reports truncation", () => {
  const output = new BoundedOutput(5);
  output.append("abc");
  output.append("defg");

  assert.equal(output.toString(), "cdefg");
  assert.equal(output.truncated, true);
});

test("BoundedOutput handles a single chunk larger than its limit", () => {
  const output = new BoundedOutput(4);
  output.append(Buffer.from("0123456789"));

  assert.equal(output.toString(), "6789");
  assert.equal(output.truncated, true);
});

test("subprocess output limits cannot be disabled with invalid or zero values", () => {
  assert.equal(subprocessOutputMaxBytes(0), DEFAULT_SUBPROCESS_OUTPUT_MAX_BYTES);
  assert.equal(subprocessOutputMaxBytes("invalid"), DEFAULT_SUBPROCESS_OUTPUT_MAX_BYTES);
  assert.equal(subprocessOutputMaxBytes("1024"), 1024);
});
