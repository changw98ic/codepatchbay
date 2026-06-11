// @ts-nocheck
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL = LEVELS[String(process.env.CPB_LOG_LEVEL || "debug").toLowerCase()] ?? 0;

export function createLogger(component, { traceId = "" } = {}) {
  function write(level, args) {
    if (LEVELS[level] < MIN_LEVEL) return;
    const ts = new Date().toISOString();
    const tid = ` [${traceId || "-"}]`;
    const msg = args.length === 1 ? String(args[0]) : args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    process.stderr.write(`${ts} [${level}] [${component}]${tid} ${msg}\n`);
  }

  return {
    debug: (...args) => write("debug", args),
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args),
    child: (opts = {}) => createLogger(component, { traceId: opts.traceId ?? traceId }),
  };
}
