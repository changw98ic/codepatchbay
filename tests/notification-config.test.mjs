#!/usr/bin/env node

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../server/services/notification/config.js";

describe("notification config", () => {
  let tmp;

  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it("returns null when channels.json does not exist", async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "flow-notif-cfg-"));
    const config = await loadConfig(tmp);
    assert.equal(config, null);
  });

  it("returns parsed config from valid JSON", async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "flow-notif-cfg-"));
    await writeFile(path.join(tmp, "channels.json"), JSON.stringify({
      enabled: true,
      channels: {
        feishu: { enabled: true, webhookUrl: "https://example.com", secret: "", events: ["job_completed"] },
      },
    }), "utf8");

    const config = await loadConfig(tmp);
    assert.equal(config.enabled, true);
    assert.equal(config.channels.feishu.webhookUrl, "https://example.com");
  });

  it("returns null for malformed JSON", async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "flow-notif-cfg-"));
    await writeFile(path.join(tmp, "channels.json"), "{bad json", "utf8");
    const config = await loadConfig(tmp);
    assert.equal(config, null);
  });

  it("returns null for JSON that is not an object", async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "flow-notif-cfg-"));
    await writeFile(path.join(tmp, "channels.json"), "42", "utf8");
    const config = await loadConfig(tmp);
    assert.equal(config, null);
  });
});
