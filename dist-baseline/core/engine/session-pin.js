// Session Pin — crash-safe session metadata saved at spawn time.
// Writes sessionPin into the process registry file so that orphan recovery
// can pass session context to retry jobs.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
/**
 * Pin session metadata into the process registry file for a job.
 * Best-effort: if the process file does not exist yet or the write fails,
 * the error is swallowed — session pinning must never block the spawn path.
 */
export async function pinSessionToJob(cpbRoot, project, jobId, { phase, sessionId, agentPid, dataRoot }) {
    try {
        const processesDir = path.join(path.resolve(dataRoot), "processes");
        const file = path.join(processesDir, `${jobId}.json`);
        let entry = null;
        try {
            entry = JSON.parse(await readFile(file, "utf8"));
        }
        catch {
            // Process file not created yet — nothing to pin to.
            return;
        }
        if (!entry)
            return;
        const sessionPin = {
            phase,
            sessionId,
            agentPid,
            pinnedAt: new Date().toISOString(),
        };
        entry.sessionPin = sessionPin;
        // Atomic write via tmp + rename
        await mkdir(processesDir, { recursive: true });
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(tmp, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
        await rename(tmp, file);
    }
    catch {
        // Best-effort — never throw.
    }
}
