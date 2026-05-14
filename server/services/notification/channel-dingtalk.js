import { createHmac } from "node:crypto";
import { request } from "node:https";

const EVENT_TITLES = {
  job_completed: "Job Completed",
  job_failed: "Job Failed",
  job_blocked: "Job Blocked",
  job_cancelled: "Job Cancelled",
  phase_failed: "Phase Failed",
};

export function formatMessage(eventType, jobState) {
  const title = EVENT_TITLES[eventType] ?? "Job Update";
  const status = (jobState.status ?? "unknown").toUpperCase();
  const timestamp = jobState.updatedAt ?? new Date().toISOString();

  const text = [
    `### Flow: ${title}`,
    "",
    `- **Project**: ${jobState.project ?? "-"}`,
    `- **Status**: ${status}`,
    `- **Task**: ${jobState.task ?? "-"}`,
    `- **Job ID**: ${jobState.jobId ?? "-"}`,
    `- **Time**: ${timestamp}`,
    "",
  ].join("\n");

  return {
    msgtype: "markdown",
    markdown: { title: `Flow: ${title}`, text },
  };
}

export function send({ webhookUrl, secret, message }) {
  return new Promise((resolve, reject) => {
    let url = new URL(webhookUrl);
    const ts = String(Date.now());

    if (secret) {
      const hmac = createHmac("sha256", secret);
      hmac.update(`${ts}\n${secret}`);
      const sign = encodeURIComponent(hmac.digest("base64"));
      url = new URL(`${url.href}&timestamp=${ts}&sign=${sign}`);
    }

    const body = JSON.stringify(message);
    const req = request(
      { hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search, method: "POST", headers: { "Content-Type": "application/json" }, timeout: 5000 },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
          else reject(new Error(`dingtalk webhook ${res.statusCode}: ${data}`));
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("dingtalk webhook timeout")); });
    req.write(body);
    req.end();
  });
}
