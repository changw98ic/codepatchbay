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

export interface CommandTreeOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Per-command timeout (ms). On elapse the process group is killed and timedOut set. */
  timeoutMs?: number;
  /** Abort → killTree. If already aborted at spawn, killed immediately. */
  signal?: AbortSignal;
  /** Grace between SIGTERM and SIGKILL (ms). Default 2000; env CPB_KILL_GRACE_MS overrides. */
  graceMs?: number;
  /** Registry injection: called with the child pid right after spawn. Best-effort. */
  onSpawn?: (pid: number) => void | Promise<void>;
  /** Registry injection: called with pid/code/signal as the child settles. Best-effort. */
  onExit?: (pid: number, code: number | null, signal: NodeJS.Signals | null) => void | Promise<void>;
  /** Stream callback for stdout chunks (flow-through to caller). */
  onStdout?: (chunk: string) => void;
  /** Stream callback for stderr chunks. */
  onStderr?: (chunk: string) => void;
}

export interface CommandTreeResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  error?: Error;
}

const DEFAULT_GRACE_MS = 2000;

function resolveGraceMs(graceMs?: number): number {
  const fromEnv = Number.parseInt(process.env.CPB_KILL_GRACE_MS || "", 10);
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv;
  return graceMs ?? DEFAULT_GRACE_MS;
}

/**
 * Kill an entire process group: SIGTERM the group (-pid) then SIGKILL after grace.
 * Safe on a bare pid (no group) — falls back to a direct signal. Mirrors
 * bridges/job-runner.ts killChildProcess, with a tunable grace.
 */
export function killTree(pid: number, graceMs?: number): void {
  if (!pid) return;
  const grace = resolveGraceMs(graceMs);
  const useGroup = process.platform !== "win32";
  const term = () => {
    try { if (useGroup) process.kill(-pid, "SIGTERM"); } catch { /* no group */ }
    try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
  };
  const force = () => {
    try { if (useGroup) process.kill(-pid, "SIGKILL"); } catch { /* no group */ }
    try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
  };
  term();
  const t = setTimeout(force, grace);
  t.unref?.();
}

/**
 * Spawn a command as its own process group, killable on timeout/abort.
 * Never rejects — failures are reported via exitCode/error in the result.
 */
export async function runCommandTree(
  command: string,
  args: string[],
  opts: CommandTreeOptions,
): Promise<CommandTreeResult> {
  const { cwd, env, timeoutMs, signal, onSpawn, onExit, onStdout, onStderr } = opts;
  const graceMs = resolveGraceMs(opts.graceMs);

  return new Promise((resolve) => {
    let settled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let child: any = null;
    let timedOut = false;
    let aborted = false;
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | null = null;
    let onSpawnDone: Promise<unknown> = Promise.resolve();
    const detached = Boolean(signal || timeoutMs) && process.platform !== "win32";

    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (signal && child) signal.removeEventListener("abort", onAbort);
    };

    const finish = (exitCode: number | null, signalOut: NodeJS.Signals | null, error?: Error) => {
      if (settled) return;
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
      if (settled || !child) return;
      aborted = true;
      killTree(child.pid, graceMs);
    };
    const onTimeout = () => {
      if (settled || !child) return;
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
    } catch (err) {
      finish(1, null, err as Error);
      return;
    }
    child.detached = detached;

    // registry injection (best-effort; never blocks settle on failure)
    try {
      const maybe = onSpawn?.(child.pid);
      if (maybe && typeof maybe.then === "function") {
        onSpawnDone = maybe.catch(() => undefined);
      }
    } catch {
      /* registry best-effort */
    }

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(onTimeout, timeoutMs);
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      stdout += s;
      onStdout?.(s);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      stderr += s;
      onStderr?.(s);
    });
    child.on("error", (err: Error) => finish(1, null, err));
    child.on("close", (code: number | null, sig: NodeJS.Signals | null) => finish(code, sig));
  });
}
