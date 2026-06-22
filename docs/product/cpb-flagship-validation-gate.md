# CodePatchBay Flagship Validation Gate

This gate protects the flagship path:

```text
GitHub Issue -> isolated worktree -> checklist evidence -> completion gate -> draft PR dry-run preview
```

It is a release-blocking stabilization gate. Passing unit tests alone is not
enough to claim product maturity for this path.

## Required Evidence

Each stabilization PR that touches queue intake, worker execution, checklist
decomposition, completion gates, finalization, GitHub transport, or release
verification must include:

- command output for `npm run verify:release-gate`
- command output for `npm run typecheck`
- command output for `npm run typecheck:strict:engine`
- command output for `npm run typecheck:type-debt:engine`
- the dry-run finalizer result showing `status: "dry-run"`
- the draft PR request preview with `repo`, `head`, `base`, `draft`, and body
- completion-gate evidence with `outcome: "complete"`
- materialized verdict evidence with status `pass`
- changed-file evidence or diff summary for the isolated worktree
- an explicit statement that no live push, PR creation, merge, comment, or issue
  close was performed

## Automated Gate

Run:

```sh
npm run verify:release-gate
```

The runner must fail if `CPB_CHECKLIST_DECOMPOSE=0` is present. It must not use
`scripts/run-node-tests.js`, because that deterministic test runner intentionally
disables production-default checklist decomposition for fake-agent suites.

The current automated gate covers:

- checklist decomposition parser/validation with production-default env posture
- managed-worker default checklist decomposition E2E without an injected
  acceptance checklist
- checklist artifact index and completion-gate contract behavior
- assignment finalizer default dry-run mode and live opt-in protection
- GitHub draft PR helper default dry-run mode and explicit live opt-in at the
  lower-level PR boundary
- auto-finalizer PR request dry-run construction from materialized PASS evidence
- auto-finalizer blocking when completion-gate or verdict evidence is missing or
  not PASS
- managed-worker execution through isolated worktree, fake ACP plan/execute/verify,
  checklist evidence, completion gate, assignment finalizer, and dry-run draft
  PR preview
- managed-worker dry-run draft PR preview E2E after materialized checklist
  evidence
- managed-worker dry-run finalization without pre-finalizer `git commit`, so the
  preview can inspect uncommitted worktree changes without mutating Git history
- PR body rendering of completion-gate evidence so the preview is inspectable
  without reconstructing runtime artifacts by hand

`verify:release-gate` is the flagship product-path gate. It does not replace the
separate TypeScript strictness and type-debt gates listed in required evidence.

## Manual Product Gate

Before declaring the stabilization cycle complete, run the dry-run flagship path
with at least 3 unfamiliar maintainers or teams on representative repositories.
Record:

- whether they understood the evidence bundle without maintainer walkthrough
- trust objections before enabling live draft PR creation
- whether any dry-run PR body required manual reconstruction
- blocked finalizer reason categories they encountered
- whether they would opt into live draft PR creation after the dry-run

## Live Mode Rule

Live draft PR creation is opt-in only. Dry-run is the default. This flagship
gate covers draft PR mode, not legacy `local` or `remote` finalizers. Do not
claim merge, comment, or issue-close behavior as validated by this gate without
a separate destructive-mode validation path.
