const LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL = LEVELS[String(process.env.CPB_LOG_LEVEL || "debug").toLowerCase()] ?? 0;

export function createLogger(component: string, { traceId = "" }: { traceId?: string } = {}) {
  function write(level: string, args: unknown[]) {
    if (LEVELS[level] < MIN_LEVEL) return;
    const ts = new Date().toISOString();
    const tid = ` [${traceId || "-"}]`;
    const msg = args.length === 1 ? String(args[0]) : args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    process.stderr.write(`${ts} [${level}] [${component}]${tid} ${msg}\n`);
  }

  return {
    debug: (...args: unknown[]) => write("debug", args),
    info: (...args: unknown[]) => write("info", args),
    warn: (...args: unknown[]) => write("warn", args),
    error: (...args: unknown[]) => write("error", args),
    child: (opts: { traceId?: string } = {}) => createLogger(component, { traceId: opts.traceId ?? traceId }),
  };
}
