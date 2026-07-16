import assert from "node:assert/strict";
import test from "node:test";

import { AcpClient } from "../server/services/acp/acp-client.js";

test("AcpClient.request registers pending response before writing to stdio", async () => {
  const client = new AcpClient({
    agent: "codex",
    cwd: process.cwd(),
    prompt: "",
    writeAllowPaths: [],
    terminalPolicy: "deny",
    toolPolicy: "deny" as unknown as Map<string, string>,
    env: {},
  });

  const timeout = Symbol("timeout");
  client.write = (message: any) => {
    void client.handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: { ok: true },
    }));
  };

  const result = await Promise.race([
    client.request("initialize", {}),
    new Promise((resolve) => setTimeout(() => resolve(timeout), 50)),
  ]);

  assert.deepEqual(result, { ok: true });
});

test("AcpClient usability rejects ended stdin before persistent reuse", () => {
  const client = new AcpClient({
    agent: "codex",
    cwd: process.cwd(),
    prompt: "",
    env: {},
  });
  const stdin = {
    writable: true,
    writableEnded: false,
    destroyed: false,
  };
  client.child = { stdin } as unknown as NonNullable<AcpClient["child"]>;

  assert.equal(client.isUsable(), true);
  stdin.writableEnded = true;
  assert.equal(client.isUsable(), false);
});
