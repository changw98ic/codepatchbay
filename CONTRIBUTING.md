# Contributing

Thanks for helping improve CodePatchbay.

CodePatchBay is free software licensed under `AGPL-3.0-only`. Unless you and
the project owner sign a separate written agreement, contributions are
submitted under the same AGPL license. Do not contribute code you do not have
the right to license or code under terms incompatible with the AGPL.

## Project scope

CodePatchBay is focused on one local delivery workflow:

```text
plan -> execute -> verify -> review or deliver
```

Agents connect through ACP or a supported CLI gateway. Please keep contributions aligned with the existing CLI, Hub, worker, evidence, and release paths unless an issue or maintainer discussion explicitly widens the product scope.

## Good first contribution areas

- documentation and quick-start updates
- clean-machine setup notes
- safer defaults and clearer error messages
- ACP permission policy examples
- CLI, Hub API, and stream-service usability
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
npm ci
npm run typecheck
npm run test:main
npm run test:integration
```

Run `npm run test:integration` when changing process, ACP, worker, reconciliation, or authority boundaries.

Do not run agents against repositories you do not control.
