// Merged from: event-source.ts + experience-extractor.ts
// Re-exports all public symbols from the original modules.

// ── event-source.ts ───────────────────────────────────────────────────────
export {
  ingestEvent,
  enqueueSddTaskEntries,
  enqueueSddTaskEntriesForApprovedParent,
  createGithubIssueQueueJob,
  createChannelQueueJob,
  listCandidates,
  updateCandidate,
  githubIssueToCandidate,
  ciFailureToCandidate,
} from "../event-source.js";

// ── experience-extractor.ts ───────────────────────────────────────────────
export {
  categorizeVerdictEnvelope,
  writeExperience,
  extractExperienceFromVerdict,
  extractExperienceFromTerminalState,
  extractExperienceForJob,
  rebuildExperienceIndex,
} from "../event-source.js";
