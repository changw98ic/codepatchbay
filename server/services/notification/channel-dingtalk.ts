import { createHmac } from "node:crypto";
import { request } from "node:https";

const EVENT_TITLES = {
  job_completed: "Job Completed",
  job_failed: "Job Failed",
  job_blocked: "Job Blocked",
  job_cancelled: "Job Cancelled",
  phase_failed: "Phase Failed",
  review_ready: "Review Ready",
  review_dispatched: "Review Approved",
  review_expired: "Review Expired",
};

export function formatMessage(eventType, jobState) {
  const title = EVENT_TITLES[eventType] ?? "Job Update";

  if (eventType.startsWith("review_")) {
    return formatReviewMessage(eventType, title, jobState);
  }

  const status = (jobState.status ?? "unknown").toUpperCase();
  const timestamp = jobState.updatedAt ?? new Date().toISOString();

  const text = [
    `### CodePatchbay: ${title}`,
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
    markdown: { title: `CodePatchbay: ${title}`, text },
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

function formatReviewMessage(eventType, title, session) {
  const lines = [
    `### CodePatchbay: ${title}`,
    "",
    `- **Project**: ${session.project ?? "-"}`,
    `- **Session**: ${session.sessionId ?? "-"}`,
    `- **Intent**: ${session.intent ?? "-"}`,
  ];

  if (eventType === "review_ready") {
    lines.push("", "> Reply \`review approve ${session.sessionId}\` to approve");
  }
  if (eventType === "review_dispatched" && session.jobId) {
    lines.push(`- **Job ID**: ${session.jobId}`);
  }

  lines.push("", `- **Time**: ${session.updatedAt ?? new Date().toISOString()}`);

  return {
    msgtype: "markdown",
    markdown: { title: `CodePatchbay: ${title}`, text: lines.join("\n") },
  };
}
