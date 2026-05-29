/**
 * bridges/run-phase.mjs — thin shim for backward compat.
 *
 * All phase execution lives in core/engine/run-single-phase.js.
 * This shim injects server services (bridges can import server/core).
 * Old 36KB implementation backed up as run-phase.mjs.old.
 */

export { runSinglePhase as runPhase } from "./engine-bridge.js";
