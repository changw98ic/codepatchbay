/**
 * Process-tree command runner.
 *
 * Spawns a command in its own detached process group so the entire tree
 * (the command + any grandchildren it spawns) can be torn down together on
 * timeout or abort. Extracted from bridges/job-runner.ts runChild/killChildProcess
 * so core/ — which cannot import server/ or bridges/ (layering invariant) — gains
 * the same process-tree control that verify hard gates need.
 *
 * Contract:
 *   - detached process group on non-win32 when signal/timeout present
 *   - AbortSignal.aborted  → killTree (SIGTERM group → grace → SIGKILL group)
 *   - timeoutMs elapse     → same, with timedOut flag set
 *   - onSpawn(pid) / onExit(pid, code, signal) hooks for registry injection
 *
 * This module MUST NOT import server/ or bridges/. Pure node:child_process.
 */
import { spawn } from "node:child_process";
const DEFAULT_GRACE_MS = 2000;
function resolveGraceMs(graceMs) {
    const fromEnv = Number.parseInt(process.env.CPB_KILL_GRACE_MS || "", 10);
    if (Number.isFinite(fromEnv) && fromEnv >= 0)
        return fromEnv;
    return graceMs ?? DEFAULT_GRACE_MS;
}
/**
 * Kill an entire process group: SIGTERM the group (-pid) then SIGKILL after grace.
 * Safe on a bare pid (no group) — falls back to a direct signal. Mirrors
 * bridges/job-runner.ts killChildProcess, with a tunable grace.
 */
export function killTree(pid, graceMs) {
    if (!pid)
        return;
    const grace = resolveGraceMs(graceMs);
    const useGroup = process.platform !== "win32";
    const term = () => {
        try {
            if (useGroup)
                process.kill(-pid, "SIGTERM");
        }
        catch { /* no group */ }
        try {
            process.kill(pid, "SIGTERM");
        }
        catch { /* already dead */ }
    };
    const force = () => {
        try {
            if (useGroup)
                process.kill(-pid, "SIGKILL");
        }
        catch { /* no group */ }
        try {
            process.kill(pid, "SIGKILL");
        }
        catch { /* already dead */ }
    };
    term();
    const t = setTimeout(force, grace);
    t.unref?.();
}
/**
 * Spawn a command as its own process group, killable on timeout/abort.
 * Never rejects — failures are reported via exitCode/error in the result.
 */
export async function runCommandTree(command, args, opts) {
    const { cwd, env, timeoutMs, signal, onSpawn, onExit, onStdout, onStderr } = opts;
    const graceMs = resolveGraceMs(opts.graceMs);
    return new Promise((resolve) => {
        let settled = false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let child = null;
        let timedOut = false;
        let aborted = false;
        let stdout = "";
        let stderr = "";
        let timer = null;
        let onSpawnDone = Promise.resolve();
        const detached = Boolean(signal || timeoutMs) && process.platform !== "win32";
        const cleanup = () => {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            if (signal && child)
                signal.removeEventListener("abort", onAbort);
        };
        const finish = (exitCode, signalOut, error) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            const code = exitCode ?? 1;
            const onExitStep = onExit && child?.pid != null
                ? Promise.resolve(onExit(child.pid, code, signalOut)).catch(() => undefined)
                : Promise.resolve();
            const done = () => resolve({ exitCode: code, signal: signalOut, stdout, stderr, timedOut, aborted, error });
            onSpawnDone.then(() => onExitStep.then(done, done), done);
        };
        const onAbort = () => {
            if (settled || !child)
                return;
            aborted = true;
            killTree(child.pid, graceMs);
        };
        const onTimeout = () => {
            if (settled || !child)
                return;
            timedOut = true;
            killTree(child.pid, graceMs);
        };
        try {
            child = spawn(command, args, {
                cwd,
                env: env || process.env,
                detached,
                shell: false,
                stdio: ["ignore", "pipe", "pipe"],
            });
        }
        catch (err) {
            finish(1, null, err);
            return;
        }
        child.detached = detached;
        // registry injection (best-effort; never blocks settle on failure)
        try {
            const maybe = onSpawn?.(child.pid);
            if (maybe && typeof maybe.then === "function") {
                onSpawnDone = maybe.catch(() => undefined);
            }
        }
        catch {
            /* registry best-effort */
        }
        if (signal) {
            if (signal.aborted)
                onAbort();
            else
                signal.addEventListener("abort", onAbort, { once: true });
        }
        if (timeoutMs && timeoutMs > 0) {
            timer = setTimeout(onTimeout, timeoutMs);
        }
        child.stdout?.on("data", (chunk) => {
            const s = chunk.toString("utf8");
            stdout += s;
            onStdout?.(s);
        });
        child.stderr?.on("data", (chunk) => {
            const s = chunk.toString("utf8");
            stderr += s;
            onStderr?.(s);
        });
        child.on("error", (err) => finish(1, null, err));
        child.on("close", (code, sig) => finish(code, sig));
    });
}
