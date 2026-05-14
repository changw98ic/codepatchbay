import { createHmac } from "node:crypto";
import { request } from "node:https";

const HEADER_COLORS = {
  job_completed: "turquoise",
  job_failed: "red",
  job_blocked: "orange",
  job_cancelled: "grey",
  phase_failed: "red",
};

const EVENT_TITLES = {
  job_completed: "Job Completed",
  job_failed: "Job Failed",
  job_blocked: "Job Blocked",
  job_cancelled: "Job Cancelled",
  phase_failed: "Phase Failed",
};

export function formatMessage(eventType, jobState) {
  const title = EVENT_TITLES[eventType] ?? "Job Update";
  const color = HEADER_COLORS[eventType] ?? "blue";
  const status = (jobState.status ?? "unknown").toUpperCase();
  const timestamp = jobState.updatedAt ?? new Date().toISOString();

  return {
    msg_type: "interactive",
    card: {
      header: {
        title: { tag: "plain_text", content: `Flow: ${title}` },
        template: color,
      },
      elements: [
        {
          tag: "div",
          fields: [
            { is_short: true, text: { tag: "lark_md", content: `**Project**\n${jobState.project ?? "-"}` } },
            { is_short: true, text: { tag: "lark_md", content: `**Status**\n${status}` } },
            { is_short: true, text: { tag: "lark_md", content: `**Task**\n${jobState.task ?? "-"}` } },
            { is_short: true, text: { tag: "lark_md", content: `**Job ID**\n${jobState.jobId ?? "-"}` } },
          ],
        },
        { tag: "hr" },
        {
          tag: "note",
          elements: [{ tag: "plain_text", content: timestamp }],
        },
      ],
    },
  };
}

export function send({ webhookUrl, secret, message }) {
  return new Promise((resolve, reject) => {
    const url = new URL(webhookUrl);
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify(message);

    const headers = { "Content-Type": "application/json" };
    if (secret) {
      const hmac = createHmac("sha256", Buffer.from(secret, "utf8"));
      hmac.update(`${ts}\n${secret}`);
      headers["X-Lark-Signature"] = Buffer.from(hmac.digest()).toString("base64");
      headers["X-Lark-Request-Timestamp"] = ts;
      headers["X-Lark-Request-Nonce"] = ts;
    }

    const req = request(
      { hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search, method: "POST", headers, timeout: 5000 },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
          else reject(new Error(`feishu webhook ${res.statusCode}: ${data}`));
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("feishu webhook timeout")); });
    req.write(body);
    req.end();
  });
}
