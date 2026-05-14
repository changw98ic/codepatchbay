#!/usr/bin/env node

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { formatMessage as feishuFormat } from "../server/services/notification/channel-feishu.js";
import { formatMessage as dingtalkFormat } from "../server/services/notification/channel-dingtalk.js";

const mockJob = {
  jobId: "job-20260514-abcd",
  project: "demo",
  task: "Add dark mode",
  status: "completed",
  updatedAt: "2026-05-14T12:00:00.000Z",
};

describe("Feishu channel formatter", () => {
  it("produces interactive card for job_completed", () => {
    const msg = feishuFormat("job_completed", mockJob);
    assert.equal(msg.msg_type, "interactive");
    assert.equal(msg.card.header.template, "turquoise");
    assert.equal(msg.card.header.title.content, "Flow: Job Completed");
    const fields = msg.card.elements[0].fields;
    assert.equal(fields.length, 4);
    assert.ok(fields.some(f => f.text.content.includes("demo")));
    assert.ok(fields.some(f => f.text.content.includes("COMPLETED")));
  });

  it("uses red header for job_failed", () => {
    const msg = feishuFormat("job_failed", { ...mockJob, status: "failed" });
    assert.equal(msg.card.header.template, "red");
  });

  it("uses orange header for job_blocked", () => {
    const msg = feishuFormat("job_blocked", { ...mockJob, status: "blocked" });
    assert.equal(msg.card.header.template, "orange");
  });

  it("uses grey header for job_cancelled", () => {
    const msg = feishuFormat("job_cancelled", { ...mockJob, status: "cancelled" });
    assert.equal(msg.card.header.template, "grey");
  });

  it("handles missing fields gracefully", () => {
    const msg = feishuFormat("job_completed", {});
    assert.equal(msg.msg_type, "interactive");
    assert.ok(msg.card.elements[0].fields[0].text.content.includes("-"));
  });
});

describe("DingTalk channel formatter", () => {
  it("produces markdown message for job_completed", () => {
    const msg = dingtalkFormat("job_completed", mockJob);
    assert.equal(msg.msgtype, "markdown");
    assert.equal(msg.markdown.title, "Flow: Job Completed");
    assert.ok(msg.markdown.text.includes("demo"));
    assert.ok(msg.markdown.text.includes("COMPLETED"));
    assert.ok(msg.markdown.text.includes("Add dark mode"));
  });

  it("produces correct title for job_failed", () => {
    const msg = dingtalkFormat("job_failed", { ...mockJob, status: "failed" });
    assert.equal(msg.markdown.title, "Flow: Job Failed");
    assert.ok(msg.markdown.text.includes("FAILED"));
  });

  it("handles missing fields gracefully", () => {
    const msg = dingtalkFormat("job_completed", {});
    assert.equal(msg.msgtype, "markdown");
    assert.ok(msg.markdown.text.includes("-"));
  });
});
