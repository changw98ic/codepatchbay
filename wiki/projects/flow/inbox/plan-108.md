## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-108
- **Timestamp**: 2026-05-19T00:00:00+08:00

# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the authoritative specification before editing. Implement only the P0.1 doctor/report readiness slice described there and in this handoff.
- Extend the existing `cpb doctor` / readiness report implementation in place instead of adding a parallel checker or a new command family.
- Add `--json` output as a structured machine-readable report while preserving existing human-readable output and exit behavior unless the source plan explicitly says otherwise.
- Model each readiness check as a named result with stable fields: check id, status, severity, human summary, optional details, and remediation. Use the repo's existing result shape if one already exists.
- Redact secrets and sensitive paths/tokens from both human and JSON outputs before printing, snapshotting, logging, or returning diagnostic details.
- Cover the new behavior with focused tests for missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable when Rust runtime checks are enabled.

### Rejected
- Broad cleanup of the CLI, Hub, registry, worker, provider, or runtime layers | outside the P0.1 slice and increases regression risk.
- Introducing new runtime dependencies for diagnostics or JSON formatting | not requested and inconsistent with keeping the diff scoped.
- Replacing existing report formatting wholesale | risks behavior churn; add JSON and new checks around current behavior.
- Editing fixtures, mocks, snapshots, or fake responders only to force tests green | forbidden by project guidance unless the fake/test double itself is the intended coverage target.
- Treating every warning as fatal | readiness should distinguish blocking failures from warnings such as low disk space unless the source plan specifies a fatal threshold.

### Scope

**目标**: Expand `cpb doctor` / readiness report checks for the P0.1 promotion-readiness must-have slice, with redacted human and JSON output, targeted tests, and no unrelated cleanup.

**涉及文件**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read first and use as the source of truth; do not edit.
- `/Users/chengwen/dev/flow/package.json` — read scripts and test commands only if needed; do not edit unless the existing test command wiring must expose an already-present test file.
- `/Users/chengwen/dev/flow/src/**/doctor*` or `/Users/chengwen/dev/flow/src/**/report*` — locate the existing `cpb doctor` and readiness report implementation; extend these files in place.
- `/Users/chengwen/dev/flow/src/**/cli*` or `/Users/chengwen/dev/flow/src/**/commands*` — locate CLI option parsing for `cpb doctor`; add `--json` using the existing command framework.
- `/Users/chengwen/dev/flow/src/**/hub*` — locate Hub health/liveness/writability helpers; reuse them for Hub readiness checks.
- `/Users/chengwen/dev/flow/src/**/registry*` — locate registry metadata helpers; reuse them for registry consistency checks.
- `/Users/chengwen/dev/flow/src/**/worker*`, `/Users/chengwen/dev/flow/src/**/jobs*`, `/Users/chengwen/dev/flow/src/**/lease*` — locate existing job, worker, and lease state readers; reuse them for stale-state checks.
- `/Users/chengwen/dev/flow/src/**/provider*` or `/Users/chengwen/dev/flow/src/**/backoff*` — locate provider backoff/rate-limit state; expose readiness warnings without changing provider behavior.
- `/Users/chengwen/dev/flow/src/**/runtime*` or `/Users/chengwen/dev/flow/src/**/rust*` — locate Rust runtime enablement checks; report Rust runtime readiness only when enabled.
- `/Users/chengwen/dev/flow/test/**/doctor*`, `/Users/chengwen/dev/flow/tests/**/doctor*`, or the repo's existing CLI test location — add/adjust tests beside the existing doctor/report tests.

**实现步骤**:
1. Read the promotion readiness plan and extract only the P0.1 requirements, expected statuses, severity rules, thresholds, and naming conventions. If the plan conflicts with this handoff, follow the plan and record the conflict in the deliverable.
2. Locate the current `cpb doctor` command, readiness report builder, output renderer, and existing tests. Identify the narrowest extension points before editing.
3. Define or extend the readiness result model using existing local patterns. Ensure every check can render both human output and JSON without duplicating check logic.
4. Add `--json` parsing for `cpb doctor` / report readiness. JSON output must contain only redacted data, a deterministic top-level summary, an array/object of check results, and an overall status suitable for automation.
5. Add environment/tool checks for Node, npm, and Git by reusing existing command/path/version helpers where available. Report missing or unusable tools with actionable remediation and stable check ids.
6. Add ACP adapter readiness checks: presence, version discovery, and a smoke-readiness probe. Missing adapter must be a tested failure/warning according to the source plan.
7. Add Rust runtime readiness checks gated by the existing Rust-enabled configuration. When Rust is disabled, report skipped/not-applicable; when enabled but unavailable, report the tested unavailable state without changing runtime configuration.
8. Add Hub readiness checks for liveness and writability. The stale Hub test should simulate an unreachable, stale, or unwritable Hub state using existing test utilities rather than sleeping or depending on wall-clock flakiness.
9. Add registry consistency checks that compare expected registry records against actual state using existing registry APIs. Report mismatches without repairing registry state inside doctor.
10. Add stale jobs, workers, and leases checks. Use existing timestamp/TTL constants where available; if no constants exist, define narrowly scoped constants near the doctor check and document why. Include a stale worker test.
11. Add provider backoff/rate-limit readiness reporting. Surface current backoff/rate-limit state as a warning or degraded status, include remediation timing if available, and add a rate-limit/backoff test.
12. Add disk-space warnings for relevant project, Hub, cache, or runtime directories. Use existing filesystem helpers; make thresholds configurable only if the source plan already requires it.
13. Add a shared redaction pass for all doctor/report outputs. Cover tokens, credentials, authorization headers, provider keys, home-directory-sensitive paths if existing policy requires, and adapter/provider diagnostic payloads.
14. Add focused tests for: missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, Rust unavailable when enabled, `--json` schema/redaction, and preservation of existing human output behavior.
15. Run the repo's relevant test commands and the smallest available full verification command set. Do not update mocks, fixtures, or snapshots unless the test asset is explicitly part of the intended behavior change.
16. Write `deliverable-108.md` after implementation with changed files, verification output, behavior summary, risks, and any source-plan conflicts.

**注意事项**:
- Do not implement P0.2 or any other promotion-readiness item.
- Do not rename public commands, check ids, config keys, Hub state files, registry formats, or worker/job/lease schemas unless the source plan explicitly requires it.
- Preserve existing human-readable doctor/report behavior for callers that do not pass `--json`.
- Avoid slow, flaky, or network-dependent smoke checks. Prefer bounded local checks with short timeouts and injectable test doubles.
- Keep JSON stable and deterministic: no absolute temp paths, raw timestamps in unstable order, secret values, or environment-specific noise unless already redacted and required.
- If a check needs elevated permissions or destructive writes, replace it with a safe probe or skip/degraded status with remediation.

## Next-Action
Implement P0.1 exactly as scoped above. Start by reading `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`, then extend the existing `cpb doctor` / readiness report implementation, add the targeted tests, run verification, and write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-108.md`.

## Acceptance-Criteria
- [ ] `cpb doctor` or the existing readiness report command accepts `--json` and emits valid, deterministic, redacted JSON with an overall status and per-check results.
- [ ] Existing human-readable doctor/report output still works for non-JSON usage and preserves prior behavior except for the newly added P0.1 checks.
- [ ] Readiness checks cover Node, npm, Git, ACP adapter presence, ACP adapter version, ACP adapter smoke readiness, Rust runtime when enabled, Hub liveness, Hub writability, registry consistency, stale jobs, stale workers, stale leases, provider backoff/rate-limit state, and disk-space warnings.
- [ ] Rust runtime check is skipped/not-applicable when Rust is not enabled and reports unavailable/degraded when Rust is enabled but unavailable.
- [ ] Hub checks distinguish live/writable, stale/unreachable, and unwritable states without mutating production Hub state.
- [ ] Registry consistency checks report inconsistencies without auto-repairing registry data.
- [ ] Stale jobs, workers, and leases are detected using existing TTL/timestamp conventions or narrowly scoped constants aligned with the source plan.
- [ ] Provider backoff/rate-limit state is surfaced as a readiness warning/degraded result with useful remediation timing/details when available.
- [ ] Disk-space checks warn at the threshold required by the source plan or the existing repo convention, without making low-space warnings fatal unless specified.
- [ ] Redaction is applied to every human and JSON diagnostic path before output; tests prove secrets/tokens are not leaked.
- [ ] Tests cover missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, Rust unavailable when enabled, `--json` output shape, and redaction.
- [ ] Relevant lint/typecheck/test commands pass, or any failures are documented with exact command output and root cause in `deliverable-108.md`.
- [ ] Changed files are limited to the doctor/report implementation, narrow CLI option wiring, reusable readiness helpers if needed, and focused tests.
- [ ] No unrelated cleanup, formatting churn, dependency additions, or broad refactors are included.
