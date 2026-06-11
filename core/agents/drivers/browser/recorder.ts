type TraceContext = {
  tracing: {
    start(options: Record<string, unknown>): Promise<void>;
    stop(options: { path: string }): Promise<void>;
  };
};

export async function startTrace(context: TraceContext, tracePath: string) {
  await context.tracing.start({ screenshots: true, snapshots: true })
  return tracePath
}

export async function stopTrace(context: TraceContext, tracePath: string) {
  await context.tracing.stop({ path: tracePath })
  return tracePath
}
