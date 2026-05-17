import { appendEvent as appendEventJs, readEvents as readEventsJs } from "./event-store.js";
import {
  appendEvent as appendEventRust,
  readEvents as readEventsRust,
  shouldUseRustRuntime,
} from "./runtime-cli.js";

export async function appendEvent(cpbRoot, project, jobId, event) {
  if (shouldUseRustRuntime()) {
    return await appendEventRust(cpbRoot, project, jobId, event);
  }
  return await appendEventJs(cpbRoot, project, jobId, event);
}

export async function readEvents(cpbRoot, project, jobId) {
  if (shouldUseRustRuntime()) {
    return await readEventsRust(cpbRoot, project, jobId);
  }
  return await readEventsJs(cpbRoot, project, jobId);
}
