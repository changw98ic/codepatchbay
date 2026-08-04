## Local code index and repository checks

Use the repository-owned local index before relying on code-search results. The index lives outside the source tree and does not use an MCP server, daemon, PID file, socket, or `.codegraph` state.

```bash
cpb code-index status -s . --json
cpb code-index build -s . --json
cpb code-index query definitions --symbol runJob -s . --json
cpb code-index query references --symbol runJob -s . --json
cpb code-index query inventory -s . --json
```

Use indexed results only when status reports `available: true` and `fresh: true`. Rebuild a missing or stale index, then check status again. Read the source file directly for exact text. If status reports file-inventory-only coverage, describe only file-level coverage; do not claim a complete symbol or call graph.

The repository commands below are the supported development entry points:

- `npm ci` installs the locked dependencies.
- `npm run build:node` compiles the application to `dist/`.
- `npm run build:tests` compiles tests to `dist-tests/`.
- `npm run typecheck` checks the application and tests without emitting files.
- `npm test` runs the default Node test suites.
- `npm run test:main` runs the main-flow profile.
- `npm run test:integration` runs the real-process integration profile.
- `node dist-tests/scripts/run-node-tests.js --main --list` prints the current main-flow file set without running it; documentation must not copy a fixed file count.
- `npm run verify:release-contracts` runs the focused release-contract checks.
- `npm run verify:release-gate` runs the complete release gate and requires configured signing and external evidence.
