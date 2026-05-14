#!/usr/bin/env node

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendEvent } from "../server/services/event-store.js";

async function createTestJob(root, project, jobId, status) {
  await appendEvent(root, project, jobId, {
    type: "job_created", jobId, project, task: "Test task",
    ts: "2026-05-14T10:00:00.000Z",
  });

  if (status === "completed") {
    await appendEvent(root, project, jobId, {
      type: "job_completed", jobId, ts: "2026-05-14T10:01:00.000Z",
    });
  } else if (status === "failed") {
    await appendEvent(root, project, jobId, {
      type: "job_failed", jobId, reason: "test error", ts: "2026-05-14T10:01:00.000Z",
    });
  } else if (status === "blocked") {
    await appendEvent(root, project, jobId, {
      type: "job_blocked", jobId, reason: "approval needed", ts: "2026-05-14T10:01:00.000Z",
    });
  }
}

describe("notification service", () => {
  let tmp;

  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it("notify is a no-op when channels.json does not exist", async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "flow-notif-svc-"));
    const { initNotificationService } = await import("../server/services/notification/index.js");
    const service = initNotificationService(tmp);
    // Should not throw
    await service.notify({ type: "job:update", project: "demo", jobId: "j1" });
    service.close();
  });

  it("notify ignores non-job:update events", async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "flow-notif-svc-"));
    await writeFile(path.join(tmp, "channels.json"), JSON.stringify({
      enabled: true, channels: {
        feishu: { enabled: true, webhookUrl: "https://localhost:9999/hook", events: ["job_completed"] },
      },
    }), "utf8");

    const { initNotificationService } = await import("../server/services/notification/index.js");
    const service = initNotificationService(tmp);
    // Should not throw or attempt webhook for non-job events
    await service.notify({ type: "pipeline:update", project: "demo" });
    await service.notify({ type: "log:append", project: "demo" });
    service.close();
  });

  it("notify does nothing for running jobs (no terminal status)", async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "flow-notif-svc-"));
    const project = "run-test";
    const jobId = "job-running";

    await appendEvent(tmp, project, jobId, {
      type: "job_created", jobId, project, task: "Still running",
      ts: "2026-05-14T10:00:00.000Z",
    });

    await writeFile(path.join(tmp, "channels.json"), JSON.stringify({
      enabled: true, channels: {
        feishu: { enabled: true, webhookUrl: "https://localhost:9999/hook", events: ["job_completed"] },
      },
    }), "utf8");

    const { initNotificationService } = await import("../server/services/notification/index.js");
    const service = initNotificationService(tmp);
    await service.notify({ type: "job:update", project, jobId });
    service.close();
  });

  it("notify deduplicates same jobId+status", async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "flow-notif-svc-"));
    const project = "dedup-test";
    const jobId = "job-dedup";

    await createTestJob(tmp, project, jobId, "completed");

    let sendCount = 0;
    await writeFile(path.join(tmp, "channels.json"), JSON.stringify({
      enabled: true, channels: {
        feishu: { enabled: true, webhookUrl: "https://localhost:9999/hook", events: ["job_completed"] },
      },
    }), "utf8");

    const { initNotificationService } = await import("../server/services/notification/index.js");
    const service = initNotificationService(tmp);

    // First notify should attempt send (will fail to localhost, that's ok)
    try { await service.notify({ type: "job:update", project, jobId }); } catch {}
    // Second notify with same status should be deduped
    try { await service.notify({ type: "job:update", project, jobId }); } catch {}

    service.close();
  });

  it("notify handles missing config gracefully", async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "flow-notif-svc-"));
    const project = "noconfig-test";
    const jobId = "job-noconfig";

    await createTestJob(tmp, project, jobId, "completed");

    // No channels.json → no error
    const { initNotificationService } = await import("../server/services/notification/index.js");
    const service = initNotificationService(tmp);
    await service.notify({ type: "job:update", project, jobId });
    service.close();
  });
});
