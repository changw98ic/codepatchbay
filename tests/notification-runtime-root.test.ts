import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initNotificationService } from "../server/services/notification/index.js";
import { createJob, completeJob } from "../server/services/job/job-store.js";
import { registerProject } from "../server/services/hub/hub-registry.js";

async function withTempRoot(name: string, fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), `${name}-`));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeNotificationConfig(cpbRoot: string) {
  await writeFile(
    path.join(cpbRoot, "channels.json"),
    `${JSON.stringify({
      enabled: true,
      channels: {
        dingtalk: {
          enabled: true,
          webhookUrl: "",
          events: ["job_completed"],
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );
}

async function captureConsoleErrors(fn: () => Promise<void>) {
  const original = console.error;
  const errors: string[] = [];
  console.error = (...args: any[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return errors;
}

test("notification job updates read jobs from event dataRoot", async () => {
  await withTempRoot("cpb-notification-data-root", async (cpbRoot) => {
    const project = "flow";
    const dataRoot = path.join(cpbRoot, "runtime");
    await writeNotificationConfig(cpbRoot);

    const job = await createJob(cpbRoot, { project, task: "notify with dataRoot", dataRoot });
    await completeJob(cpbRoot, project, job.jobId, { dataRoot });

    const service = initNotificationService(cpbRoot);
    const errors = await captureConsoleErrors(async () => {
      await service.notify({ type: "job:update", project, jobId: job.jobId, dataRoot });
    });
    service.close();

    assert.equal(errors.some((line) => line.includes("dataRoot is required")), false);
    assert.equal(errors.some((line) => line.includes("[notification] getJob error")), false);
  });
});

test("notification job updates resolve projectRuntimeRoot from hub registry", async () => {
  await withTempRoot("cpb-notification-registry-root", async (root) => {
    const cpbRoot = path.join(root, "source");
    const hubRoot = path.join(root, "hub");
    const project = "flow";
    await mkdir(cpbRoot, { recursive: true });
    await writeNotificationConfig(cpbRoot);

    const previousHubRoot = process.env.CPB_HUB_ROOT;
    process.env.CPB_HUB_ROOT = hubRoot;
    try {
      const registration = await registerProject(hubRoot, {
        id: project,
        sourcePath: cpbRoot,
        cpbRoot,
        skipCodeGraphGate: true,
      });
      const dataRoot = registration.projectRuntimeRoot;

      const job = await createJob(cpbRoot, { project, task: "notify via registry", dataRoot });
      await completeJob(cpbRoot, project, job.jobId, { dataRoot });

      const service = initNotificationService(cpbRoot);
      const errors = await captureConsoleErrors(async () => {
        await service.notify({ type: "job:update", project, jobId: job.jobId });
      });
      service.close();

      assert.equal(errors.some((line) => line.includes("dataRoot is required")), false);
      assert.equal(errors.some((line) => line.includes("[notification] getJob error")), false);
    } finally {
      if (previousHubRoot === undefined) {
        delete process.env.CPB_HUB_ROOT;
      } else {
        process.env.CPB_HUB_ROOT = previousHubRoot;
      }
    }
  });
});
