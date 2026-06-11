// Merged from: project-index.ts + project-capability-map.ts + project-pollution.ts
// Re-exports all public symbols from the original modules.

// ── project-index.ts ──────────────────────────────────────────────────────
export { normalizeProjectIndex, readProjectIndex, writeProjectIndex, formatProjectIndexLine } from "../project-index.js";

// ── project-capability-map.ts ─────────────────────────────────────────────
export { projectCapabilityMapGate, generateProjectCapabilityMaps } from "../project-index.js";

// ── project-pollution.ts ──────────────────────────────────────────────────
export { isUnderTestPath, classifyProject, filterVisibleProjects, scanHubPollution } from "../project-index.js";
