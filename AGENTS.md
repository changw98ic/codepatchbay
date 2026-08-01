# Repository Guidelines

## Project Structure & Module Organization
CodePatchBay is a pure Node.js ESM CLI tool with runtime workers. The root `cpb` launcher and `cli/cpb.ts` dispatch commands from `cli/commands/`. Core workflow contracts and engines live in `core/`; orchestration services in `server/`; worker helpers in `runtime/`; bridge entrypoints in `bridges/`; shared utilities in `shared/`. The only HTTP endpoint is `cpb stream` (Node native `http` + SSE). Tests live in `tests/`, docs in `docs/` and `wiki/`, and support assets in `assets/`, `templates/`, and `skills/`.

## Local Code Index & Repository Lookup
For repository understanding tasks, use `cpb code-index` and the repository-owned local index. The index is stored outside the source tree; it does not use MCP, a daemon, a PID file, a socket, or source-tree index state.

Before relying on indexed results, run `cpb code-index status -s .`. If it does not report `available: true` and `fresh: true`, run `cpb code-index build -s .`, then check status again. Use `cpb code-index query definitions --symbol <name>` for symbol definitions, `cpb code-index query references --symbol <name>` for references, `cpb code-index query inventory` for file listings, and direct file reads for exact source text. If the index tool is unavailable, the index may explicitly fall back to a Git/file inventory; report that limitation and do not claim symbol or call-graph coverage. Never treat the mere presence of an index file as proof that it is fresh.

## Build, Test, and Development Commands
- `npm ci`: install dependencies.
- `npm test` or `npm run test:node`: run the custom Node test runner over all `tests/**/*.test.ts`.
- `npm run test:main`: run the 222-file main-flow contract/unit profile plus shell checks; real-process integration suites are excluded from PR CI.
- `npm run test:integration`: run the remaining integration suites manually when changing process, ACP, worker, reconciliation, or authority boundaries.
- `npm run test:specialized`: run benchmark, evaluation, release-rehearsal, and packaging-specific tests excluded from the main-flow profile.
- `node dist-tests/scripts/run-node-tests.js --main --list`: list the main-flow profile without executing it.
- `npm run build:node`: compile TypeScript to `dist/`.
- `npm run build:tests`: compile tests to `dist-tests/`.
- `npm run build:node && node dist/scripts/ci-smoke.js`: run the local setup/demo smoke path.
- `npm run verify:stabilization`: run the release-only evidence gate manually; it is intentionally not part of every PR CI job.

## Coding Style & Naming Conventions
Use ES modules throughout. `.editorconfig` enforces UTF-8, LF endings, final newlines, trimmed trailing whitespace, and two-space indentation. TypeScript strict mode. Use kebab-case for command and test files, camelCase for functions. Keep new CLI commands in `cli/commands/`.

## Testing Guidelines
Backend and CLI coverage uses Node’s built-in test runner via `*.test.ts`; shell integration checks use `tests/cpb-*.test.sh`. Add focused regression tests for handoff, event, phase, runtime, CLI, or review behavior. Do not edit fakes, fixtures, snapshots, or test doubles just to hide production behavior changes. No fixed coverage threshold is enforced; document untested risk in the PR.

## Commit & Pull Request Guidelines
History uses short imperative subjects with concrete scope, such as `Fix bridge import paths and add missing phase shell wrappers` or `Add dynamic workflow engine, bridges, and DW acceptance gates`. Keep diffs small and focused. Fill `.github/pull_request_template.md` with summary, change type, safety checklist, and verification. Do not include secrets, runtime state, logs, `.env` files, generated dependency folders, or unverified guarantees. Link issues when relevant and update docs for behavior changes.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
