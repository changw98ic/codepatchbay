import type { LooseRecord } from "../../../shared/types.js";
import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";
import { onEventWritten, readEvents, materializeJob } from "../event/event-store.js";
import { listJobs } from "../job/job-store.js";
import { jobToQueueRow } from "../job/job-projection.js";
import { resolveProjectDataRoot } from "../runtime.js";
import { startWikiWatcher, type WikiChangeEvent } from "./wiki-watcher.js";
import {
  assertExplicitInsecureHttpOptIn,
  isLoopbackHost,
  normalizeBearerToken,
} from "../../../shared/network.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface StreamServerOptions {
  port?: number;
  host?: string;
  cpbRoot: string;
  hubRoot: string;
  maxClients?: number;
  bearerToken?: string;
  allowedOrigins?: string[];
  allowInsecureHttp?: boolean | string;
  allowAnonymousDev?: boolean | string;
}

type SseClient = {
  res: http.ServerResponse;
  projects: Set<string>; // empty = all projects
};

const VERSION = "cpb-stream/v1";
const PING_INTERVAL_MS = 15_000;
type ResponseHeaders = Record<string, string>;

// ── Helpers ────────────────────────────────────────────────────────────────────

function sendSse(res: http.ServerResponse, data: LooseRecord) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function safeProjectName(value: string | null): string | null {
  if (!value) return null;
  return /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(value) ? value : null;
}

function requestHeader(req: http.IncomingMessage, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : null;
  return typeof value === "string" ? value : null;
}

function normalizeAllowedOrigins(origins: string[] | undefined): Set<string> {
  const normalized = new Set<string>();
  for (const value of Array.isArray(origins) ? origins : []) {
    const candidate = String(value || "").trim();
    if (!candidate) continue;
    if (candidate === "*") throw new Error("CPB stream CORS wildcard origin is not allowed");

    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error(`invalid CPB stream allowed origin: ${candidate}`);
    }
    if (
      !["http:", "https:"].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
    ) {
      throw new Error(`invalid CPB stream allowed origin: ${candidate}`);
    }
    normalized.add(parsed.origin);
  }
  return normalized;
}

function corsHeaders(origin: string | null, allowedOrigins: Set<string>): ResponseHeaders {
  if (!origin || !allowedOrigins.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
  };
}

function bearerTokenMatches(authorization: string | null, expectedToken: string): boolean {
  if (!authorization) return false;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const provided = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown, headers: ResponseHeaders = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...headers,
  });
  res.end(payload);
}

function textResponse(res: http.ServerResponse, status: number, body: string, contentType = "text/markdown", headers: ResponseHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": contentType,
    ...headers,
  });
  res.end(body);
}

function isRecord(value: unknown): value is LooseRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): LooseRecord {
  return isRecord(value) ? value : {};
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function htmlEscape(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stringList(value: unknown, limit = 8): string[] {
  const raw = Array.isArray(value) ? value : (text(value) ? [value] : []);
  return [...new Set(raw.map(text).filter(Boolean))].slice(0, limit);
}

function listText(value: unknown, limit = 8) {
  const list = stringList(value, limit);
  return list.length > 0 ? list.join(", ") : "unavailable";
}

function row(label: string, value: unknown) {
  return `<tr><th>${htmlEscape(label)}</th><td>${htmlEscape(value || "unavailable")}</td></tr>`;
}

function phaseBudgetTable(policy: LooseRecord) {
  const phases = recordValue(policy.phases);
  const rows = Object.entries(phases)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([phase, raw]) => {
      const budget = recordValue(raw);
      return `<tr><td>${htmlEscape(phase)}</td><td>${htmlEscape(budget.toolCallBudget ?? "-")}</td><td>${htmlEscape(budget.toolEventBudget ?? "-")}</td><td>${htmlEscape(budget.idleTimeoutMs ?? "-")}</td><td>${htmlEscape(budget.noEditToolLimit ?? "-")}</td></tr>`;
    });
  if (rows.length === 0) return "<p class=\"muted\">No phase budget policy recorded.</p>";
  return `<table><thead><tr><th>Phase</th><th>Tool calls</th><th>Tool events</th><th>Idle ms</th><th>No-edit reads</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

async function jobReadOptions(cpbRoot: string, hubRoot: string, project: string) {
  try {
    return {
      dataRoot: await resolveProjectDataRoot(cpbRoot, project, { hubRoot }),
      includeLegacyFallback: true,
    };
  } catch {
    return { includeLegacyFallback: true };
  }
}

function jobPanelHtml(stateInput: unknown) {
  const state = recordValue(stateInput);
  const rowState = recordValue(jobToQueueRow(state));
  const completion = recordValue(rowState.completionReport || state.completionReport);
  const residualRisk = recordValue(completion.residualRisk);
  const evidenceCounts = recordValue(completion.evidenceCounts);
  const policy = recordValue(rowState.phaseBudgetPolicy || state.phaseBudgetPolicy);
  const evidenceRequirements = stringList(rowState.evidenceRequirements || state.evidenceRequirements, 12);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CPB Job ${htmlEscape(rowState.jobId || state.jobId || "")}</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; padding: 24px; line-height: 1.45; background: Canvas; color: CanvasText; }
    main { max-width: 1120px; margin: 0 auto; }
    h1 { font-size: 24px; margin: 0 0 4px; }
    h2 { font-size: 17px; margin: 24px 0 8px; }
    table { width: 100%; border-collapse: collapse; margin: 8px 0 0; }
    th, td { text-align: left; border-bottom: 1px solid color-mix(in srgb, CanvasText 18%, transparent); padding: 8px; vertical-align: top; }
    th { width: 190px; font-weight: 650; }
    .summary { color: color-mix(in srgb, CanvasText 70%, transparent); margin: 0 0 16px; }
    .panel { border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 8px; padding: 16px; margin-top: 16px; }
    .muted { color: color-mix(in srgb, CanvasText 62%, transparent); }
  </style>
</head>
<body>
<main>
  <h1>Job Visibility Panel</h1>
  <p class="summary">${htmlEscape(rowState.project || state.project || "-")} / ${htmlEscape(rowState.jobId || state.jobId || "-")} · ${htmlEscape(rowState.status || state.status || "-")}</p>
  <section class="panel">
    <h2>Completion Report</h2>
    ${Object.keys(completion).length === 0 ? "<p class=\"muted\">No completion report recorded.</p>" : `<table><tbody>
      ${row("Changed files", `${completion.changedFileCount ?? stringList(completion.changedFiles, 100).length} (${listText(completion.changedFiles)})`)}
      ${row("Real actors", listText(completion.realActors))}
      ${row("Real entrypoints", listText(completion.realEntrypoints))}
      ${row("Bypass candidates", listText(completion.bypassCandidates))}
      ${row("Evidence classes", listText(completion.evidenceClasses))}
      ${row("Evidence origins", listText(completion.evidenceOrigins))}
      ${row("Commands", listText(completion.commands, 6))}
      ${row("Evidence counts", `${evidenceCounts.passed ?? "-"} passed / ${evidenceCounts.failed ?? "-"} failed / ${evidenceCounts.total ?? "-"} total`)}
      ${row("Residual risk", listText(residualRisk.notes))}
    </tbody></table>`}
  </section>
  <section class="panel">
    <h2>Runtime Policy</h2>
    <table><tbody>
      ${row("Risk level", policy.riskLevel || rowState.riskLevel || state.riskLevel)}
      ${row("Verification depth", policy.verificationDepth || rowState.verificationDepth || state.verificationDepth)}
      ${row("Adversarial required", policy.adversarialRequired === true || rowState.adversarialRequired === true || state.adversarialRequired === true ? "yes" : "no")}
      ${row("Evidence requirements", evidenceRequirements.length > 0 ? evidenceRequirements.join(", ") : listText(policy.evidenceRequirements, 12))}
      ${row("Reasons", listText(policy.reasons, 8))}
    </tbody></table>
    ${phaseBudgetTable(policy)}
  </section>
</main>
</body>
</html>`;
}

// ── Main server ────────────────────────────────────────────────────────────────

export async function startStreamServer(options: StreamServerOptions) {
  const {
    port = 9741,
    host = "127.0.0.1",
    cpbRoot,
    hubRoot,
    maxClients = 100,
    bearerToken: bearerTokenInput,
    allowedOrigins: allowedOriginsInput,
    allowInsecureHttp,
    allowAnonymousDev: allowAnonymousDevInput,
  } = options;
  const bearerToken = normalizeBearerToken(bearerTokenInput, "CPB stream bearer token");
  const allowAnonymousDev = [true, "1", "true", "yes"].includes(allowAnonymousDevInput ?? false);
  if (allowAnonymousDev && !isLoopbackHost(host)) {
    throw new Error("anonymous CPB stream development mode is restricted to loopback binds");
  }
  if (!bearerToken && !allowAnonymousDev) {
    throw new Error("CPB stream bearer token is required; anonymous access needs explicit loopback development opt-in");
  }
  assertExplicitInsecureHttpOptIn(
    host,
    allowInsecureHttp,
    "CPB_STREAM_ALLOW_INSECURE_HTTP",
    "CPB stream server",
  );
  const allowedOrigins = normalizeAllowedOrigins(allowedOriginsInput);
  const clients = new Set<SseClient>();
  const startedAt = new Date().toISOString();
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribeEvents: (() => void) | null = null;

  const server = http.createServer(async (req, res) => {
    const origin = requestHeader(req, "origin");
    const responseCorsHeaders = corsHeaders(origin, allowedOrigins);
    if (origin && Object.keys(responseCorsHeaders).length === 0) {
      return jsonResponse(res, 403, { error: "origin not allowed" });
    }

    // Browser preflight cannot carry the actual Authorization header.
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...responseCorsHeaders,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      });
      return res.end();
    }

    if (!allowAnonymousDev && !bearerTokenMatches(requestHeader(req, "authorization"), bearerToken)) {
      return jsonResponse(res, 401, { error: "unauthorized" }, {
        ...responseCorsHeaders,
        "WWW-Authenticate": "Bearer",
      });
    }

    const parsed = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = parsed.pathname;

    // ── GET / ──────────────────────────────────────────────────────────────
    if (pathname === "/" || pathname === "") {
      return jsonResponse(res, 200, {
        version: VERSION,
        clients: clients.size,
        uptime: Date.now() - new Date(startedAt).getTime(),
      }, responseCorsHeaders);
    }

    // ── GET /stream ────────────────────────────────────────────────────────
    if (pathname === "/stream") {
      const projectFilter = parsed.searchParams.get("project");
      const projects = new Set<string>();
      if (projectFilter) {
        for (const p of projectFilter.split(",")) {
          const safe = safeProjectName(p.trim());
          if (safe) projects.add(safe);
        }
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...responseCorsHeaders,
        "X-Accel-Buffering": "no", // disable nginx buffering
      });

      // Reject if at connection limit
      if (clients.size >= maxClients) {
        sendSse(res, { type: "error", ts: new Date().toISOString(), message: "max clients reached" });
        res.end();
        return;
      }

      const client: SseClient = { res, projects };
      clients.add(client);

      // Send initial state: all active jobs
      try {
        const jobs = await listJobs(cpbRoot, { hubRoot });
        for (const job of jobs) {
          if (projects.size > 0 && !projects.has(job.project)) continue;
          sendSse(res, { type: "state", ts: new Date().toISOString(), project: job.project, jobId: job.jobId, state: job });
        }
      } catch { /* best effort */ }

      // Flush headers
      if (!res.writableEnded) res.write("\n");

      req.on("close", () => {
        clients.delete(client);
      });
      return;
    }

    // ── GET /jobs ──────────────────────────────────────────────────────────
    if (pathname === "/jobs") {
      try {
        const jobs = await listJobs(cpbRoot, { hubRoot });
        return jsonResponse(res, 200, jobs, responseCorsHeaders);
      } catch (err) {
        return jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) }, responseCorsHeaders);
      }
    }

    // ── GET /jobs/:project/:jobId/panel ────────────────────────────────────
    const jobPanelMatch = pathname.match(/^\/jobs\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9][A-Za-z0-9-]+)\/panel$/);
    if (jobPanelMatch) {
      const [, project, jobId] = jobPanelMatch;
      try {
        const events = await readEvents(cpbRoot, project, jobId, await jobReadOptions(cpbRoot, hubRoot, project));
        if (events.length === 0) return jsonResponse(res, 404, { error: "job not found" }, responseCorsHeaders);
        const state = materializeJob(events);
        return textResponse(res, 200, jobPanelHtml(state), "text/html; charset=utf-8", responseCorsHeaders);
      } catch (err) {
        return jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) }, responseCorsHeaders);
      }
    }

    // ── GET /jobs/:project/:jobId ──────────────────────────────────────────
    const jobMatch = pathname.match(/^\/jobs\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9][A-Za-z0-9-]+)$/);
    if (jobMatch) {
      const [, project, jobId] = jobMatch;
      try {
        const events = await readEvents(cpbRoot, project, jobId, await jobReadOptions(cpbRoot, hubRoot, project));
        if (events.length === 0) return jsonResponse(res, 404, { error: "job not found" }, responseCorsHeaders);
        const state = materializeJob(events);
        return jsonResponse(res, 200, state, responseCorsHeaders);
      } catch (err) {
        return jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) }, responseCorsHeaders);
      }
    }

    // ── GET /wiki/:project/* ───────────────────────────────────────────────
    const wikiMatch = pathname.match(/^\/wiki\/([A-Za-z0-9][A-Za-z0-9-]*)\/(.+)$/);
    if (wikiMatch) {
      const [, project, filePath] = wikiMatch;
      // Prevent path traversal
      const resolved = path.resolve(cpbRoot, "wiki", "projects", project, filePath);
      const wikiBase = path.resolve(cpbRoot, "wiki", "projects", project);
      if (!resolved.startsWith(wikiBase + path.sep) && resolved !== wikiBase) {
        return jsonResponse(res, 403, { error: "path traversal blocked" }, responseCorsHeaders);
      }
      try {
        const content = await fs.readFile(resolved, "utf8");
        return textResponse(res, 200, content, "text/markdown", responseCorsHeaders);
      } catch (err) {
        if (err.code === "ENOENT") return jsonResponse(res, 404, { error: "file not found" }, responseCorsHeaders);
        return jsonResponse(res, 500, { error: err.message }, responseCorsHeaders);
      }
    }

    // ── Fallback ───────────────────────────────────────────────────────────
    return jsonResponse(res, 404, { error: "not found" }, responseCorsHeaders);
  });

  // ── Broadcast: event-store subscription ─────────────────────────────────
  unsubscribeEvents = onEventWritten((payload) => {
    const { project, jobId, event } = payload;
    const ts = new Date().toISOString();
    const msg = { type: "event", ts, project, jobId, event };

    for (const client of clients) {
      if (client.projects.size > 0 && !client.projects.has(project)) continue;
      sendSse(client.res, msg);
    }
  });

  // ── Broadcast: wiki watcher ──────────────────────────────────────────────
  const wikiWatcher = startWikiWatcher({
    cpbRoot,
    hubRoot,
    onChange(evt: WikiChangeEvent) {
      const msg = { type: "wiki", ...evt };
      for (const client of clients) {
        if (client.projects.size > 0 && !client.projects.has(evt.project)) continue;
        sendSse(client.res, msg);
      }
    },
  });

  // ── Ping interval ───────────────────────────────────────────────────────
  pingTimer = setInterval(() => {
    const ts = new Date().toISOString();
    for (const client of clients) {
      sendSse(client.res, { type: "ping", ts });
    }
  }, PING_INTERVAL_MS);

  // ── Graceful shutdown ────────────────────────────────────────────────────
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (unsubscribeEvents) { unsubscribeEvents(); unsubscribeEvents = null; }
    wikiWatcher.close();
    for (const client of clients) {
      try { client.res.end(); } catch { /* ignore */ }
    }
    clients.clear();
    server.close();
  }

  // ── Start listening ──────────────────────────────────────────────────────
  return new Promise<{ server: http.Server; close: () => void }>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve({ server, close });
    });
  });
}
