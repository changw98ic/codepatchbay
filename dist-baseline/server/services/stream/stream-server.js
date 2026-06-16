import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";
import { onEventWritten, readEvents, materializeJob } from "../event/event-store.js";
import { listJobs } from "../job/job-store.js";
import { startWikiWatcher } from "./wiki-watcher.js";
const VERSION = "cpb-stream/v1";
const PING_INTERVAL_MS = 15_000;
// ── Helpers ────────────────────────────────────────────────────────────────────
function sendSse(res, data) {
    if (res.writableEnded || res.destroyed)
        return;
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}
function safeProjectName(value) {
    if (!value)
        return null;
    return /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(value) ? value : null;
}
function jsonResponse(res, status, body) {
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
    });
    res.end(payload);
}
function textResponse(res, status, body, contentType = "text/markdown") {
    res.writeHead(status, {
        "Content-Type": contentType,
        "Access-Control-Allow-Origin": "*",
    });
    res.end(body);
}
// ── Main server ────────────────────────────────────────────────────────────────
export async function startStreamServer(options) {
    const { port = 9741, host = "127.0.0.1", cpbRoot, hubRoot, maxClients = 100 } = options;
    const clients = new Set();
    const startedAt = new Date().toISOString();
    let pingTimer = null;
    let unsubscribeEvents = null;
    const server = http.createServer(async (req, res) => {
        const parsed = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
        const pathname = parsed.pathname;
        // CORS preflight
        if (req.method === "OPTIONS") {
            res.writeHead(204, {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type",
            });
            return res.end();
        }
        // ── GET / ──────────────────────────────────────────────────────────────
        if (pathname === "/" || pathname === "") {
            return jsonResponse(res, 200, {
                version: VERSION,
                clients: clients.size,
                uptime: Date.now() - new Date(startedAt).getTime(),
            });
        }
        // ── GET /stream ────────────────────────────────────────────────────────
        if (pathname === "/stream") {
            const projectFilter = parsed.searchParams.get("project");
            const projects = new Set();
            if (projectFilter) {
                for (const p of projectFilter.split(",")) {
                    const safe = safeProjectName(p.trim());
                    if (safe)
                        projects.add(safe);
                }
            }
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
                "Access-Control-Allow-Origin": "*",
                "X-Accel-Buffering": "no", // disable nginx buffering
            });
            // Reject if at connection limit
            if (clients.size >= maxClients) {
                sendSse(res, { type: "error", ts: new Date().toISOString(), message: "max clients reached" });
                res.end();
                return;
            }
            const client = { res, projects };
            clients.add(client);
            // Send initial state: all active jobs
            try {
                const jobs = await listJobs(cpbRoot);
                for (const job of jobs) {
                    if (projects.size > 0 && !projects.has(job.project))
                        continue;
                    sendSse(res, { type: "state", ts: new Date().toISOString(), project: job.project, jobId: job.jobId, state: job });
                }
            }
            catch { /* best effort */ }
            // Flush headers
            if (!res.writableEnded)
                res.write("\n");
            req.on("close", () => {
                clients.delete(client);
            });
            return;
        }
        // ── GET /jobs ──────────────────────────────────────────────────────────
        if (pathname === "/jobs") {
            try {
                const jobs = await listJobs(cpbRoot);
                return jsonResponse(res, 200, jobs);
            }
            catch (err) {
                return jsonResponse(res, 500, { error: err.message });
            }
        }
        // ── GET /jobs/:project/:jobId ──────────────────────────────────────────
        const jobMatch = pathname.match(/^\/jobs\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9][A-Za-z0-9-]+)$/);
        if (jobMatch) {
            const [, project, jobId] = jobMatch;
            try {
                const events = await readEvents(cpbRoot, project, jobId, { includeLegacyFallback: true });
                if (events.length === 0)
                    return jsonResponse(res, 404, { error: "job not found" });
                const state = materializeJob(events);
                return jsonResponse(res, 200, state);
            }
            catch (err) {
                return jsonResponse(res, 500, { error: err.message });
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
                return jsonResponse(res, 403, { error: "path traversal blocked" });
            }
            try {
                const content = await fs.readFile(resolved, "utf8");
                return textResponse(res, 200, content);
            }
            catch (err) {
                if (err.code === "ENOENT")
                    return jsonResponse(res, 404, { error: "file not found" });
                return jsonResponse(res, 500, { error: err.message });
            }
        }
        // ── Fallback ───────────────────────────────────────────────────────────
        return jsonResponse(res, 404, { error: "not found" });
    });
    // ── Broadcast: event-store subscription ─────────────────────────────────
    unsubscribeEvents = onEventWritten((payload) => {
        const { project, jobId, event } = payload;
        const ts = new Date().toISOString();
        const msg = { type: "event", ts, project, jobId, event };
        for (const client of clients) {
            if (client.projects.size > 0 && !client.projects.has(project))
                continue;
            sendSse(client.res, msg);
        }
    });
    // ── Broadcast: wiki watcher ──────────────────────────────────────────────
    const wikiWatcher = startWikiWatcher({
        cpbRoot,
        hubRoot,
        onChange(evt) {
            const msg = { type: "wiki", ...evt };
            for (const client of clients) {
                if (client.projects.size > 0 && !client.projects.has(evt.project))
                    continue;
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
        if (closed)
            return;
        closed = true;
        if (pingTimer) {
            clearInterval(pingTimer);
            pingTimer = null;
        }
        if (unsubscribeEvents) {
            unsubscribeEvents();
            unsubscribeEvents = null;
        }
        wikiWatcher.close();
        for (const client of clients) {
            try {
                client.res.end();
            }
            catch { /* ignore */ }
        }
        clients.clear();
        server.close();
    }
    // ── Start listening ──────────────────────────────────────────────────────
    return new Promise((resolve, reject) => {
        server.on("error", reject);
        server.listen(port, host, () => {
            server.removeListener("error", reject);
            resolve({ server, close });
        });
    });
}
