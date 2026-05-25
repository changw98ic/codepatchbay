import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  AcpClient,
  parseToolPolicy,
  resolveAgentCommand,
  resolveWriteAllowPaths,
} from "../runtime/acp-client-core.mjs";

function restoreEnv(snapshot) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    process.env[key] = value;
  }
}

describe("ACP client policy env snapshot", () => {
  it("parses tool policy from the provided env instead of live process.env", async () => {
    const saved = { ...process.env };
    try {
      process.env.CPB_ACP_DENY_TOOLS = "fs/delete";
      process.env.CPB_ACP_ALLOW_TOOLS = "";

      const policy = await parseToolPolicy({
        CPB_ACP_DENY_TOOLS: "terminal/create",
      });

      assert.equal(policy.get("terminal/create"), "deny");
      assert.equal(policy.get("fs/delete"), undefined);
    } finally {
      restoreEnv(saved);
    }
  });

  it("resolves write allow paths from the provided env", () => {
    const saved = { ...process.env };
    try {
      delete process.env.CPB_ACP_WRITE_ALLOW;
      const cwd = path.join(path.sep, "tmp", "project");

      const paths = resolveWriteAllowPaths(cwd, {
        CPB_ACP_WRITE_ALLOW: "src/*,/tmp/shared/file.txt",
      });

      assert.deepEqual(paths, [
        path.resolve(cwd, "src/*"),
        path.resolve("/tmp/shared/file.txt"),
      ]);
    } finally {
      restoreEnv(saved);
    }
  });

  it("answers permission requests from the client env snapshot", () => {
    const saved = { ...process.env };
    try {
      process.env.CPB_ACP_PERMISSION = "allow";
      const client = new AcpClient({
        agent: "codex",
        cwd: "/tmp/project",
        env: { CPB_ACP_PERMISSION: "reject" },
      });

      const response = client.permissionResponse({
        options: [
          { optionId: "allow-1", kind: "allow_once" },
          { optionId: "reject-1", kind: "reject_once" },
        ],
      });

      assert.equal(response.outcome.optionId, "reject-1");
    } finally {
      restoreEnv(saved);
    }
  });

  it("resolves agent commands without registry env override leakage", async () => {
    const saved = { ...process.env };
    try {
      process.env.CPB_ACP_CODEX_COMMAND = "/tmp/bad-global-codex";
      process.env.CPB_ACP_CODEX_ARGS = "--bad-global-arg";

      const resolved = await resolveAgentCommand("codex", {
        PATH: process.env.PATH || "",
      });

      assert.notEqual(resolved.command, "/tmp/bad-global-codex");
      assert.deepEqual(resolved.args.includes("--bad-global-arg"), false);
    } finally {
      restoreEnv(saved);
    }
  });
});
