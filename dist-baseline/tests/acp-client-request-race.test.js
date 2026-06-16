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
        toolPolicy: "deny",
        env: {},
    });
    const timeout = Symbol("timeout");
    client.write = (message) => {
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
