# TypeScript Migration Inventory

Date: 2026-06-11

Scope command:

```bash
rg --files -g '*.js' -g '*.mjs' -g '*.cjs' cli core server runtime bridges shared scripts tests
```

Initial count: 379 Node-side JavaScript files.

Final count after migration:

```bash
rg --files -g '*.js' -g '*.mjs' -g '*.cjs' cli core server runtime bridges shared scripts tests | wc -l
```

Result: 0.

Final source-wide sweep after removing the remaining web test setup JavaScript and the ignored marketing/hyperframes source leftovers:

```bash
find . \( -path './.*' -o -path './cpb-task' -o -path './node_modules' -o -path './web/node_modules' -o -path './dist' -o -path './web/dist' -o -path './dist-tests' -o -path './marketing/codepatchbay-vibecoding-video/assets/gsap.min.js' \) -prune -o -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \) -print | sort
```

Result: no files.

By extension:

| Extension | Count |
| --- | ---: |
| `.js` | 269 |
| `.mjs` | 110 |
| `.cjs` | 0 |

By top-level directory:

| Directory | Count |
| --- | ---: |
| `server` | 154 |
| `tests` | 72 |
| `core` | 72 |
| `cli` | 49 |
| `scripts` | 13 |
| `runtime` | 8 |
| `bridges` | 7 |
| `shared` | 4 |

Migration strategy:

- Rename Node-side `.js` and `.mjs` sources to `.ts`.
- Rename ignored but source-owned marketing and hyperframes leftovers to `.ts`.
- Keep relative import specifiers as emitted `.js` paths for TypeScript `NodeNext`.
- Replace `.mjs` specifiers and executable path strings with `.js`.
- Build Node output into `dist/`.
- Keep root `cpb` launcher as the package bin and point it at `dist/cli/cpb.js`.
- Run Node tests from compiled `dist/tests/**/*.test.js`.
- Keep web TypeScript/Vite sources under `web/`; delete the obsolete `web/test-setup.js` once `web/test-setup.ts` is the configured Vitest setup file.
- Keep vendored browser bundles such as `marketing/codepatchbay-vibecoding-video/assets/gsap.min.js` as static assets; they are excluded from the source migration scan.

Implemented package shape:

- Root `cpb` remains the npm bin and imports `dist/cli/cpb.js`.
- `cpb-browser-agent-acp` and `cpb-test-acp-agent` point at compiled `dist/server/services/*.js`.
- `build:node` copies only required runtime assets into `dist/`: profiles, skills, templates, `wiki/schema.md`, `wiki/system`, `wiki/projects/_template`, and `web/dist`.
- `npm pack --dry-run --json --ignore-scripts` confirmed `dist/web/dist/index.html`, browser fixture HTML, no tests, no runtime `.omc` state, no local `.tgz` files, and no non-template project wiki runtime artifacts.

Verification:

- `npm run typecheck:node`: passed.
- `npm test`: passed.
- `npm run typecheck:web`: passed.
- `cd web && npm test -- --run`: passed.
- `legacy_js_count=0` for the source-wide scan excluding dependencies, generated output, runtime homes, and vendored browser bundles.

Residual typing risk:

- The migration is mechanical and uses `// @ts-nocheck` in migrated Node files. The current typecheck is an emit/module-resolution guard, not a strict semantic typing pass. Removing `ts-nocheck` should be handled incrementally by package boundary after this migration lands.
