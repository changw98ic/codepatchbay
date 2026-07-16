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
import { spawn, spawnSync } from "node:child_process";

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
 * Return every current descendant before the root is signalled. ACP wrappers
 * launch providers in detached process groups, so a root process-group signal
 * alone is not a complete tree teardown.
 */
function descendantPids(rootPid: number) {
  if (process.platform === "win32" || !rootPid) return [];
  const result = spawnSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" });
  if (result.error || typeof result.stdout !== "string") return [];
  const children = new Map<number, number[]>();
  for (const line of result.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    const childPid = Number(match[1]);
    const parentPid = Number(match[2]);
    if (!Number.isInteger(childPid) || !Number.isInteger(parentPid) || childPid <= 0 || parentPid <= 0) continue;
    const entries = children.get(parentPid) || [];
    entries.push(childPid);
    children.set(parentPid, entries);
  }
  const descendants: number[] = [];
  const pending = [...(children.get(rootPid) || [])];
  const seen = new Set<number>();
  while (pending.length > 0) {
    const childPid = pending.shift();
    if (!childPid || seen.has(childPid)) continue;
    seen.add(childPid);
    descendants.push(childPid);
    pending.push(...(children.get(childPid) || []));
  }
  return descendants;
}

function signalPid(pid: number, signal: NodeJS.Signals) {
  try { process.kill(pid, signal); } catch { /* already dead */ }
}

/**
 * Kill an entire process tree: SIGTERM the root group and every captured
 * detached descendant, then SIGKILL after grace. The returned promise resolves
 * only after the force-kill pass, so short-lived callers cannot exit while an
 * unref'ed cleanup timer still owns the only remaining teardown action.
 */
export function killTree(pid: number, graceMs?: number): Promise<void> {
  if (!pid) return Promise.resolve();
  const grace = resolveGraceMs(graceMs);
  const useGroup = process.platform !== "win32";
  const descendants = descendantPids(pid);
  const term = () => {
    try { if (useGroup) process.kill(-pid, "SIGTERM"); } catch { /* no group */ }
    signalPid(pid, "SIGTERM");
    for (const childPid of [...descendants].reverse()) signalPid(childPid, "SIGTERM");
  };
  const force = () => {
    try { if (useGroup) process.kill(-pid, "SIGKILL"); } catch { /* no group */ }
    signalPid(pid, "SIGKILL");
    for (const childPid of [...descendants].reverse()) signalPid(childPid, "SIGKILL");
  };
  term();
  return new Promise((resolve) => {
    setTimeout(() => {
      force();
      resolve();
    }, grace);
  });
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
    let child: (import("node:child_process").ChildProcess & { detached?: boolean }) | null = null;
    let timedOut = false;
    let aborted = false;
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | null = null;
    let onSpawnDone: Promise<unknown> = Promise.resolve();
    let teardown: Promise<void> | null = null;
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
      Promise.all([onSpawnDone, onExitStep, teardown || Promise.resolve()]).then(done, done);
    };

    const onAbort = () => {
      if (settled || !child) return;
      aborted = true;
      teardown = killTree(child.pid, graceMs);
    };
    const onTimeout = () => {
      if (settled || !child) return;
      timedOut = true;
      teardown = killTree(child.pid, graceMs);
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
      // Narrow unknown catch value to Error; spawn failures are always Error
      // (ENOENT/EPERM/etc.), fallback preserves message for any non-Error throw.
      finish(1, null, err instanceof Error ? err : new Error(String(err)));
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
