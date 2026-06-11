// @ts-nocheck
export async function startTrace(context, tracePath) {
  await context.tracing.start({ screenshots: true, snapshots: true })
  return tracePath
}

export async function stopTrace(context, tracePath) {
  await context.tracing.stop({ path: tracePath })
  return tracePath
}
