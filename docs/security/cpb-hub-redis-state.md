# Hub Redis control-plane state

> **Retired** — The Redis state backend has been removed. See `docs/spec-redis-retirement-and-projectworker-cleanup.md` for the migration rationale and timeline.

CodePatchBay now uses the local filesystem as the sole state backend. All hub state (registry, queue, assignments, workers, leader lock) is stored as JSON files under the hub root directory.
