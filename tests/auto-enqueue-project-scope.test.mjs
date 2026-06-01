import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { autoEnqueueSyncedIssues } from "../server/services/auto-enqueue.js";
import { bindProjectGithub, registerProject, updateProject } from "../server/services/hub-registry.js";

describe("auto-enqueue GitHub issue project scope", () => {
  it("only considers synced issues for the requested Hub project", async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-auto-enqueue-"));
    const hubRoot = path.join(tmpRoot, "hub");
    const cpbRoot = path.join(tmpRoot, "cpb");
    const sourceOne = await mkdtemp(path.join(tmpRoot, "source-one-"));
    const sourceTwo = await mkdtemp(path.join(tmpRoot, "source-two-"));

    try {
      await registerProject(hubRoot, { id: "alpha", sourcePath: sourceOne });
      await registerProject(hubRoot, { id: "beta", sourcePath: sourceTwo });
      await bindProjectGithub(hubRoot, "alpha", "octo/alpha");
      await bindProjectGithub(hubRoot, "beta", "octo/beta");
      await updateProject(hubRoot, "alpha", {
        github: {
          fullName: "octo/alpha",
          automation: {
            enabled: true,
            rules: [{ name: "cpb", match: { labels: ["cpb"] }, action: { workflow: "standard" } }],
          },
        },
      });

      await mkdir(path.join(hubRoot, "github"), { recursive: true });
      await writeFile(
        path.join(hubRoot, "github", "issues.json"),
        `${JSON.stringify({
          version: 1,
          issues: [
            { repository: "octo/alpha", projectId: "alpha", number: 1, title: "Alpha", state: "OPEN", labels: ["cpb"] },
            { repository: "octo/beta", projectId: "beta", number: 1, title: "Beta", state: "OPEN", labels: ["cpb"] },
          ],
        }, null, 2)}\n`,
        "utf8",
      );

      const result = await autoEnqueueSyncedIssues(hubRoot, cpbRoot, "alpha", { dryRun: true });

      assert.equal(result.total, 1);
      assert.equal(result.enqueued, 1);
      assert.deepEqual(result.matched.map((issue) => issue.title), ["Alpha"]);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
