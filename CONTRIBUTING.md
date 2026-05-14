# Contributing

Thanks for helping improve CodePatchbay.

CodePatchbay is source-available for personal and non-commercial use under the PolyForm Noncommercial License 1.0.0. By contributing, you agree that your contribution may be distributed under this license and under separate commercial licenses offered by the project owner.

## Project scope

CodePatchbay is currently focused on one narrow workflow:

```text
Codex plans -> Claude Code executes -> Codex checks
```

Please keep contributions aligned with that scope unless an issue or maintainer discussion explicitly widens it.

## Good first contribution areas

- documentation and quick-start corrections
- clean-machine setup notes
- safer defaults and clearer error messages
- ACP permission policy examples
- Web UI polish for existing screens
- tests for existing event, lease, supervisor, review, and notification behavior
- a stub/demo mode that does not require real agent credentials

## Before opening a pull request

- Keep diffs small and focused.
- Do not add new dependencies without a clear reason.
- Do not commit runtime state, logs, `.env` files, `channels.json`, or generated dependency folders.
- Do not describe unverified behavior as guaranteed.
- Document behavior changes in README or the relevant wiki docs.
- If you change handoff, event, lease, or supervisor behavior, include tests or explain why tests were not added.

## Local checks

The GitHub workflow runs Node and shell checks. Locally, the common commands are:

```bash
cd server && npm ci
cd ../web && npm ci
cd ..
node --test tests/*.mjs
bash tests/cpb-jobs.test.sh
bash tests/cpb-bridges.test.sh
bash tests/cpb-variant-env.test.sh
```

Do not run agents against repositories you do not control.
