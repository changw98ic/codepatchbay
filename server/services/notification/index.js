import { loadConfig } from "./config.js";
import * as feishu from "./channel-feishu.js";
import * as dingtalk from "./channel-dingtalk.js";
import { getJob } from "../job-store.js";

const CHANNELS = { feishu, dingtalk };

const NOTIFY_STATUSES = new Set(["completed", "failed", "blocked", "cancelled"]);

const STATUS_TO_EVENT = {
  completed: "job_completed",
  failed: "job_failed",
  blocked: "job_blocked",
  cancelled: "job_cancelled",
};

export function initNotificationService(flowRoot) {
  let configCache = null;
  let configLoaded = false;
  const notified = new Set();

  async function getConfig() {
    if (!configLoaded) {
      configCache = await loadConfig(flowRoot);
      configLoaded = true;
    }
    return configCache;
  }

  async function notify(event) {
    if (!event || event.type !== "job:update") return;
    if (!event.project || !event.jobId) return;

    const config = await getConfig();
    if (!config || config.enabled === false) return;
    if (!config.channels || typeof config.channels !== "object") return;

    let jobState;
    try {
      jobState = await getJob(flowRoot, event.project, event.jobId);
    } catch (err) {
      console.error(`[notification] getJob error: ${err.message}`);
      return;
    }
    if (!jobState || !jobState.status) return;
    if (!NOTIFY_STATUSES.has(jobState.status)) return;

    const dedupKey = `${jobState.jobId}:${jobState.status}`;
    if (notified.has(dedupKey)) return;
    notified.add(dedupKey);

    const eventType = STATUS_TO_EVENT[jobState.status] ?? "job_failed";

    for (const [name, channel] of Object.entries(CHANNELS)) {
      const chConfig = config.channels[name];
      if (!chConfig || chConfig.enabled === false) continue;
      if (!chConfig.webhookUrl) continue;
      if (chConfig.events && !chConfig.events.includes(eventType)) continue;

      try {
        const message = channel.formatMessage(eventType, jobState);
        await channel.send({ webhookUrl: chConfig.webhookUrl, secret: chConfig.secret || "", message });
      } catch (err) {
        console.error(`[notification] ${name} send error: ${err.message}`);
      }
    }
  }

  function close() {
    configCache = null;
    configLoaded = false;
  }

  return { notify, close };
}
