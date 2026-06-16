import fs from "node:fs";
import path from "node:path";
const IGNORED_NAMES = new Set([".DS_Store", ".tmp", ".lock"]);
const DEBOUNCE_MS = 100;
export function startWikiWatcher(options) {
    const { cpbRoot, onChange } = options;
    const wikiDir = path.join(cpbRoot, "wiki", "projects");
    let watcher = null;
    let debounceTimer = null;
    const pending = new Map();
    function flush() {
        debounceTimer = null;
        for (const [key, entry] of pending) {
            onChange({
                type: "wiki",
                project: entry.project,
                path: entry.filePath,
                action: entry.action,
                ts: new Date().toISOString(),
            });
        }
        pending.clear();
    }
    function scheduleFlush() {
        if (debounceTimer)
            clearTimeout(debounceTimer);
        debounceTimer = setTimeout(flush, DEBOUNCE_MS);
    }
    function shouldIgnore(filename) {
        for (const prefix of IGNORED_NAMES) {
            if (filename.startsWith(prefix))
                return true;
        }
        return false;
    }
    function extractProject(filePath) {
        // filePath is relative to wiki/projects/ — first segment is the project name
        const normalized = filePath.replace(/\\/g, "/");
        const slash = normalized.indexOf("/");
        return slash > 0 ? normalized.slice(0, slash) : null;
    }
    try {
        // Ensure the directory exists so fs.watch doesn't throw
        fs.mkdirSync(wikiDir, { recursive: true });
        watcher = fs.watch(wikiDir, { recursive: true }, (eventType, filename) => {
            if (!filename || shouldIgnore(filename))
                return;
            const project = extractProject(filename);
            if (!project)
                return;
            // Normalize: fs.watch reports relative to watched dir
            const relativePath = filename.replace(/\\/g, "/");
            const parts = relativePath.split("/");
            // Ignore lock directories (e.g. "foo.lock" in any position)
            if (parts.some((p) => p.endsWith(".lock") || shouldIgnore(p)))
                return;
            // Map rename to create/update; "rename" also fires on delete
            let action;
            if (eventType === "rename") {
                // Check if the file still exists to distinguish create vs delete
                const fullPath = path.join(wikiDir, filename);
                action = fs.existsSync(fullPath) ? "create" : "delete";
            }
            else {
                action = "update";
            }
            // Strip project prefix from path for the event
            const filePath = relativePath.slice(project.length + 1);
            if (!filePath)
                return; // Skip the project dir itself
            const key = `${project}:${filePath}:${action}`;
            pending.set(key, { project, filePath, action });
            scheduleFlush();
        });
    }
    catch (err) {
        // If watch fails (e.g. recursive not supported), log and return a no-op
        console.warn("[stream/wiki-watcher] fs.watch failed:", err.message);
    }
    return {
        close() {
            if (debounceTimer) {
                clearTimeout(debounceTimer);
                debounceTimer = null;
            }
            if (watcher) {
                watcher.close();
                watcher = null;
            }
            pending.clear();
        },
    };
}
