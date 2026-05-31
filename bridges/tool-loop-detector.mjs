/**
 * Tool-loop detector for ACP agent sessions.
 *
 * Detects when an agent repeatedly calls the same tool with the same
 * parameters in the same working directory — a common failure mode
 * where the agent gets stuck in a repetitive loop.
 *
 * Default OFF. When enabled, only records risk — never blocks tool execution.
 *
 * Feature flag: CPB_TOOL_LOOP_DETECTOR=1
 */

const DEFAULT_WINDOW_SIZE = 10;
const DEFAULT_THRESHOLD = 3;

/**
 * Create a stable fingerprint from a tool request.
 * Uses: tool method name + stringified params + working directory.
 */
function fingerprint(method, params, cwd) {
  const args = params ? JSON.stringify(params) : "";
  return `${method}\0${args}\0${cwd || ""}`;
}

export class ToolLoopDetector {
  constructor({
    windowSize = DEFAULT_WINDOW_SIZE,
    threshold = DEFAULT_THRESHOLD,
    onAlert = null,
  } = {}) {
    this.windowSize = windowSize;
    this.threshold = threshold;
    this.onAlert = onAlert;
    this.buffer = [];
    this.alerts = [];
  }

  /**
   * Record a tool invocation and check for loops.
   * Returns the alert if triggered, or null.
   */
  record(method, params, cwd) {
    const fp = fingerprint(method, params, cwd);
    const entry = { fp, method, ts: Date.now() };

    this.buffer.push(entry);
    if (this.buffer.length > this.windowSize) {
      this.buffer.shift();
    }

    const alert = this.checkLoop(fp);
    if (alert && this.onAlert) {
      this.onAlert(alert);
    }
    return alert;
  }

  checkLoop(fp) {
    let consecutive = 0;
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      if (this.buffer[i].fp === fp) {
        consecutive++;
      } else {
        break;
      }
    }

    if (consecutive >= this.threshold) {
      const alert = {
        type: "tool_loop",
        method: this.buffer[this.buffer.length - 1].method,
        consecutiveCalls: consecutive,
        fingerprint: fp,
        ts: Date.now(),
      };
      this.alerts.push(alert);
      return alert;
    }

    return null;
  }

  getAlerts() {
    return [...this.alerts];
  }

  reset() {
    this.buffer = [];
    this.alerts = [];
  }
}

/**
 * Create a detector from environment config.
 * Returns null if the feature flag is not set.
 */
export function createDetectorFromEnv(env = process.env) {
  if (!env.CPB_TOOL_LOOP_DETECTOR || env.CPB_TOOL_LOOP_DETECTOR === "0") {
    return null;
  }

  const windowSize = parseInt(env.CPB_TOOL_LOOP_WINDOW || String(DEFAULT_WINDOW_SIZE), 10);
  const threshold = parseInt(env.CPB_TOOL_LOOP_THRESHOLD || String(DEFAULT_THRESHOLD), 10);

  return new ToolLoopDetector({
    windowSize: Number.isFinite(windowSize) ? windowSize : DEFAULT_WINDOW_SIZE,
    threshold: Number.isFinite(threshold) ? threshold : DEFAULT_THRESHOLD,
  });
}
