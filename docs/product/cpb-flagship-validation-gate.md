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

- command output for `npm run verify:stabilization`, the aggregate gate for the
  release, patch-integrity, type, and product validation checks
- JSON output from `npm run report:release-readiness`, showing `ready: true`
  only after patch integrity and product validation both pass
- command output for `npm run verify:release-gate`
- command output for `npm run typecheck`
- command output for `npm run typecheck:strict:engine`
- command output for `npm run typecheck:type-debt:engine`
- command output for `npm run verify:patch-integrity`, showing every new source,
  test, script, or documentation file is included in the reviewed patch or
  explicitly excluded with a reason
- command output for `npm run verify:product-gate`, backed by at least 3 real
  product validation records from unfamiliar maintainers or teams, or from
  SWE-bench Verified external benchmark samples
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
npm run verify:stabilization
npm run verify:release-gate
```

`verify:stabilization` is the end-of-cycle gate. It intentionally includes
`verify:product-gate`, so it must fail until product validation records exist
and pass.

`report:release-readiness` emits a machine-readable summary of the same remaining
conditions. It is for audit/reporting, not a substitute for the gate commands.

The runner must fail if `CPB_CHECKLIST_DECOMPOSE=0` is present. It must not use
`scripts/run-node-tests.js`, because that deterministic test runner intentionally
disables production-default checklist decomposition for fake-agent suites.

The current automated gate covers:

- checklist decomposition parser/validation with production-default env posture
- managed-worker flagship E2E without an injected acceptance checklist:
  production-default checklist decomposition, isolated worktree execution,
  checklist evidence, completion gate, and draft PR dry-run preview in one run
- checklist artifact index and completion-gate contract behavior
- assignment finalizer default dry-run mode and live opt-in protection
- GitHub draft PR helper default dry-run mode and explicit live opt-in at the
  lower-level PR boundary
- auto-finalizer PR request dry-run construction from materialized PASS evidence
- auto-finalizer blocking when completion-gate or verdict evidence is missing or
  not PASS
- managed-worker execution through isolated worktree, fake ACP plan/execute/verify,
  checklist evidence, completion gate, assignment finalizer, and dry-run draft
  PR preview in the same flagship run
- managed-worker dry-run finalization without pre-finalizer `git commit`, so the
  preview can inspect uncommitted worktree changes without mutating Git history
- PR body rendering of completion-gate evidence so the preview is inspectable
  without reconstructing runtime artifacts by hand

`verify:release-gate` is the flagship product-path gate. It does not replace the
separate TypeScript strictness and type-debt gates listed in required evidence.

## Patch Integrity Gate

Before a stabilization PR is considered review-ready, the author must run:

```sh
npm run verify:patch-integrity
git status --short --untracked-files=all
git diff --check
```

There must be no untracked implementation files left outside the patch. In
particular, new files under `core/`, `runtime/`, `server/`, `cli/`, `bridges/`,
`shared/`, `scripts/`, `tests/`, or `docs/` must be part of the reviewed change.
This protects refactors that extract modules from passing local builds while
silently omitting the extracted files from the submitted patch.

## Product Validation Gate

Before declaring the stabilization cycle complete, record at least 3 real
product validation records in
`docs/product/cpb-flagship-product-validation.json` using
`docs/product/cpb-flagship-product-validation.template.json` as the format
guide, then run:

```sh
npm run verify:product-gate
```

The template file is not product evidence. Do not count template rows,
maintainer self-review, or synthetic fake-agent runs as product validation.

Accepted modes:

- `maintainer-dry-run` records: run the dry-run flagship path with unfamiliar
  maintainers or teams on representative repositories and record their feedback
- `swe-bench-verified` records: use real issue/PR samples from the official
  `SWE-bench/SWE-bench_Verified` test split and record CPB dry-run safety
  evidence for those samples

For maintainer/team records, record:

- `validatedAt`, the ISO timestamp when the dry-run was reviewed
- `evidenceBundleRef`, a unique path or URL to the dry-run evidence bundle,
  audit export, or release-readiness artifact the reviewer inspected
- whether they understood the evidence bundle without maintainer walkthrough
- trust objections before enabling live draft PR creation
- whether any dry-run PR body required manual reconstruction
- blocked finalizer reason categories they encountered
- whether they would opt into live draft PR creation after the dry-run

For SWE-bench Verified records, record:

- `validationMode: "swe-bench-verified"`
- `benchmarkDataset: "SWE-bench/SWE-bench_Verified"` and `benchmarkSplit:
  "test"`
- the unique `benchmarkInstanceId`, representative repository, base commit, and
  URL for the dataset row
- a SHA-256 hash of the problem statement, plus fail-to-pass and pass-to-pass
  test counts from the dataset row
- `officialBenchmarkHumanValidated: true` and
  `benchmarkIssuePullRequestPair: true`
- the CPB dry-run evidence bundle showing dry-run finalizer status, draft PR
  preview, no live side effects, and no manual PR body reconstruction

SWE-bench Verified evidence is external real-sample product validation. It does
not claim that CPB solved the benchmark instance or executed the benchmark test
suite unless the evidence bundle explicitly includes that separate run.

Local `evidenceBundleRef` values must resolve to existing files under the
repository root when `npm run verify:product-gate` or
`npm run report:release-readiness` runs. Use URL refs only for externally hosted
audit bundles that cannot be committed with the validation evidence.

## Live Mode Rule

Live draft PR creation is opt-in only. Dry-run is the default. This flagship
gate covers draft PR mode, not legacy `local` or `remote` finalizers. Do not
claim merge, comment, or issue-close behavior as validated by this gate without
a separate destructive-mode validation path.
