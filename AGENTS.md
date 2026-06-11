# Repository Guidelines

## Project Structure & Module Organization
CodePatchBay is a Node ESM project with a CLI, Fastify server, runtime workers, and Vite web UI. The root `cpb` launcher and `cli/cpb.mjs` dispatch commands from `cli/commands/`. Core workflow contracts and engines live in `core/`; server routes and services in `server/`; worker helpers in `runtime/`; bridge entrypoints in `bridges/`; shared utilities in `shared/`. The React UI is in `web/src/`. Tests live in `tests/`, docs in `docs/` and `wiki/`, and support assets in `assets/`, `templates/`, and `skills/`.

## Build, Test, and Development Commands
- `npm ci`: install root and workspace dependencies.
- `npm test` or `npm run test:node`: run the custom Node test runner over `tests/**/*.test.mjs`.
- `cd web && npm test -- --run`: run Vitest web tests.
- `npm run build:web`: build the Vite UI; this also runs before packing.
- `cd server && npm run dev`: start the Fastify hub with `node --watch`.
- `node scripts/ci-smoke.mjs`: run the local setup/demo smoke path.
- `npx playwright install --with-deps chromium`: install browser dependencies for Playwright checks.

## Coding Style & Naming Conventions
Use ES modules throughout. `.editorconfig` enforces UTF-8, LF endings, final newlines, trimmed trailing whitespace, and two-space indentation. Root JS/MJS files generally use double quotes and semicolons; React/TSX files currently use single quotes. Use kebab-case for command and test files such as `release-selection.test.mjs`, camelCase for functions, and PascalCase for React components. Keep new CLI commands in `cli/commands/` and API routes in `server/routes/`.

## Testing Guidelines
Backend and CLI coverage uses Node’s built-in test runner via `*.test.mjs`; shell integration checks use `tests/cpb-*.test.sh`. Web tests use Vitest and Testing Library from `web`. Add focused regression tests for handoff, event, lease, supervisor, runtime, CLI, or review behavior. Do not edit fakes, fixtures, snapshots, or test doubles just to hide production behavior changes. No fixed coverage threshold is enforced; document untested risk in the PR.

## Commit & Pull Request Guidelines
History uses short imperative subjects with concrete scope, such as `Fix bridge import paths and add missing phase shell wrappers` or `Add dynamic workflow engine, bridges, and DW acceptance gates`. Keep diffs small and focused. Fill `.github/pull_request_template.md` with summary, change type, safety checklist, and verification. Do not include secrets, runtime state, logs, `.env` files, generated dependency folders, or unverified guarantees. Link issues when relevant and update docs for behavior changes.
