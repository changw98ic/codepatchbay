import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { enqueue } from "../server/services/hub-queue.js";

describe("hub queue project agent config", () => {
  it("resolves project agents from Hub config scope instead of task source cwd", async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-hub-queue-config-"));
    const hubRoot = path.join(tmpRoot, "hub");
    const sourcePath = path.join(tmpRoot, "daily-source");

    try {
      await mkdir(path.join(hubRoot, "wiki", "projects", "daily"), { recursive: true });
      await mkdir(sourcePath, { recursive: true });
      await writeFile(
        path.join(hubRoot, "config.json"),
        `${JSON.stringify({
          agents: {
            default: "claude",
            phases: { plan: "browser-agent", verify: "claude" },
            variants: { plan: "none", verify: "mimo" },
          },
        }, null, 2)}\n`,
        "utf8",
      );
      await writeFile(
        path.join(hubRoot, "wiki", "projects", "daily", "project.json"),
        `${JSON.stringify({
          agents: {
            default: "claude",
            phases: { plan: "claude", execute: "claude", verify: "codex", review: "codex" },
            variants: { plan: "mimo", execute: "none", verify: "none", review: "none" },
          },
        }, null, 2)}\n`,
        "utf8",
      );

      const entry = await enqueue(hubRoot, {
        projectId: "daily",
        sourcePath,
        description: "daily task",
        metadata: { source: "test" },
      });

      assert.deepEqual(entry.metadata.agents, {
        planner: { agent: "claude", variant: "mimo" },
        executor: { agent: "claude", variant: "none" },
        verifier: { agent: "codex", variant: "none" },
        reviewer: { agent: "codex", variant: "none" },
      });
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
