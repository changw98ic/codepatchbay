import fs from "node:fs";
import path from "node:path";

export interface WikiChangeEvent {
  type: "wiki";
  project: string;
  path: string;
  action: "create" | "update" | "delete";
  ts: string;
}

export interface WikiWatcherOptions {
  hubRoot: string;
  onChange: (event: WikiChangeEvent) => void;
}

const IGNORED_NAMES = new Set([".DS_Store", ".tmp", ".lock"]);
const DEBOUNCE_MS = 100;

export function startWikiWatcher(options: WikiWatcherOptions): { close: () => void } {
  const { hubRoot, onChange } = options;
  const projectsDir = path.join(path.resolve(hubRoot), "projects");
  let watcher: fs.FSWatcher | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Map<string, { project: string; filePath: string; action: "create" | "update" | "delete" }>();

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
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flush, DEBOUNCE_MS);
  }

  function shouldIgnore(filename: string): boolean {
    for (const prefix of IGNORED_NAMES) {
      if (filename.startsWith(prefix)) return true;
    }
    return false;
  }

  function extractProject(filePath: string): string | null {
    // filePath is relative to Hub projects/ — first segment is the project name.
    const normalized = filePath.replace(/\\/g, "/");
    const parts = normalized.split("/");
    return parts.length > 2 && parts[1] === "wiki" ? parts[0] : null;
  }

  try {
    // Watch all Hub-managed project runtime roots. Changes outside each
    // project's wiki namespace are ignored below.
    fs.mkdirSync(projectsDir, { recursive: true });

    watcher = fs.watch(projectsDir, { recursive: true }, (eventType, filename) => {
      if (!filename || shouldIgnore(filename)) return;

      const project = extractProject(filename);
      if (!project) return;

      // Normalize: fs.watch reports relative to watched dir
      const relativePath = filename.replace(/\\/g, "/");
      const parts = relativePath.split("/");

      // Ignore lock directories (e.g. "foo.lock" in any position)
      if (parts.some((p) => p.endsWith(".lock") || shouldIgnore(p))) return;

      // Map rename to create/update; "rename" also fires on delete
      let action: "create" | "update" | "delete";
      if (eventType === "rename") {
        // Check if the file still exists to distinguish create vs delete
        const fullPath = path.join(projectsDir, filename);
        action = fs.existsSync(fullPath) ? "create" : "delete";
      } else {
        action = "update";
      }

      // Strip project and wiki prefixes from path for the event
      const filePath = relativePath.split("/").slice(2).join("/");
      if (!filePath) return; // Skip the project dir itself

      const key = `${project}:${filePath}:${action}`;
      pending.set(key, { project, filePath, action });
      scheduleFlush();
    });
  } catch (err) {
    // If watch fails (e.g. recursive not supported), log and return a no-op
    console.warn("[stream/wiki-watcher] fs.watch failed:", err instanceof Error ? err.message : String(err));
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
