#!/usr/bin/env node
/**
 * Stop all legacy worker processes from the Hub worker registry.
 * Reads PID files from hub registry and sends SIGTERM.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
const hubRoot = process.env.CPB_HUB_ROOT || path.join(homedir(), ".cpb");
async function stopLegacyWorkers() {
    const registryDir = path.join(hubRoot, "workers", "registry");
    let files;
    try {
        files = await readdir(registryDir);
    }
    catch {
        console.log("No worker registry found — nothing to stop");
        return;
    }
    let stopped = 0;
    for (const file of files) {
        if (!file.startsWith("worker-") || !file.endsWith(".json"))
            continue;
        try {
            const worker = JSON.parse(await readFile(path.join(registryDir, file), "utf8"));
            if (worker.pid && worker.status !== "exited") {
                try {
                    process.kill(worker.pid, "SIGTERM");
                    console.log(`Stopped worker ${worker.workerId} (pid ${worker.pid})`);
                    stopped++;
                }
                catch {
                    console.log(`Worker ${worker.workerId} (pid ${worker.pid}) already stopped`);
                }
            }
        }
        catch { /* skip malformed */ }
    }
    console.log(`Stopped ${stopped} worker(s)`);
}
stopLegacyWorkers().catch((err) => {
    console.error(`Failed: ${err.message}`);
    process.exit(1);
});
