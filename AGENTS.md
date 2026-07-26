# Repository Guidelines

## Project Structure & Module Organization
CodePatchBay is a pure Node.js ESM CLI tool with runtime workers. The root `cpb` launcher and `cli/cpb.ts` dispatch commands from `cli/commands/`. Core workflow contracts and engines live in `core/`; orchestration services in `server/`; worker helpers in `runtime/`; bridge entrypoints in `bridges/`; shared utilities in `shared/`. The only HTTP endpoint is `cpb stream` (Node native `http` + SSE). Tests live in `tests/`, docs in `docs/` and `wiki/`, and support assets in `assets/`, `templates/`, and `skills/`.

## Codegraph & Repository Lookup
For repository understanding tasks, prefer Codegraph before shell/file fallback. Use Codegraph first for symbol lookup, call graphs, architecture tracing, impact analysis, and "where/how does this work" questions. Use direct file reads or shell search only to confirm a specific detail Codegraph does not cover, to inspect files reported stale, or when Codegraph is unavailable.

Before every Codegraph-backed lookup, run the currently available Codegraph sync step first, then verify index status. If the index reports pending or stale files, wait for sync or rerun the sync step before trusting Codegraph results. If sync is unavailable or still stale, say so briefly and read the affected files directly instead of presenting stale index results as authoritative.

## Build, Test, and Development Commands
- `npm ci`: install dependencies.
- `npm test` or `npm run test:node`: run the custom Node test runner over all `tests/**/*.test.ts`.
- `npm run test:main`: run the 232-file HubOrchestrator → ManagedWorker main-flow profile plus shell checks.
- `npm run test:specialized`: run benchmark, evaluation, release-rehearsal, and packaging-specific tests excluded from the main-flow profile.
- `node dist-tests/scripts/run-node-tests.js --main --list`: list a profile without executing it.
- `npm run build:node`: compile TypeScript to `dist/`.
- `npm run build:tests`: compile tests to `dist-tests/`.
- `npm run build:node && node dist/scripts/ci-smoke.js`: run the local setup/demo smoke path.

## Coding Style & Naming Conventions
Use ES modules throughout. `.editorconfig` enforces UTF-8, LF endings, final newlines, trimmed trailing whitespace, and two-space indentation. TypeScript strict mode. Use kebab-case for command and test files, camelCase for functions. Keep new CLI commands in `cli/commands/`.

## Testing Guidelines
Backend and CLI coverage uses Node’s built-in test runner via `*.test.ts`; shell integration checks use `tests/cpb-*.test.sh`. Add focused regression tests for handoff, event, phase, runtime, CLI, or review behavior. Do not edit fakes, fixtures, snapshots, or test doubles just to hide production behavior changes. No fixed coverage threshold is enforced; document untested risk in the PR.

## Commit & Pull Request Guidelines
History uses short imperative subjects with concrete scope, such as `Fix bridge import paths and add missing phase shell wrappers` or `Add dynamic workflow engine, bridges, and DW acceptance gates`. Keep diffs small and focused. Fill `.github/pull_request_template.md` with summary, change type, safety checklist, and verification. Do not include secrets, runtime state, logs, `.env` files, generated dependency folders, or unverified guarantees. Link issues when relevant and update docs for behavior changes.
