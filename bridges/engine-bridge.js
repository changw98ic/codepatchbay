/**
 * Engine Bridge — runtime-facing engine boundary.
 *
 * Runtime code imports this bridge instead of importing server services.
 * Server-owned dependency wiring lives in server/services/engine-runner.js.
 */

import {
  buildServices as buildServerServices,
  runJobWithServices as runJobWithServerServices,
} from "../server/services/engine-runner.js";

export function buildServices(cpbRoot, opts = {}) {
  return buildServerServices(cpbRoot, opts);
}

export async function runJobWithServices(opts) {
  return runJobWithServerServices(opts);
}
