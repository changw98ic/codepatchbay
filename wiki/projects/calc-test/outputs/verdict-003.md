VERDICT: PASS

Plan-Ref: 004 (from deliverable metadata)

Evidence:
1) AC-1 (plan scope): `outputs/deliverable-003.md` records implemented item: in `codex-verify.sh` added `--until <shell command>` parsing/execution for eval style calls (`--until "npm test"`), satisfying the planned eval-stage protocol.
2) AC-2 output contract: deliverable states `codex-verify.sh` now emits machine-readable `METRIC <key>=<value>` lines and still emits `VERDICT: PASS/FAIL`; evidence includes `METRIC test_pass_rate=100.0%`, `METRIC build_status=pass`, plus optional `build_exit_code`, `tests_failed`, `tests_total`.
3) AC-3 combined decision: deliverable and evidence show `run-pipeline.mjs` parses both `VERDICT` and `METRIC` and applies rule `LLM verdict FAIL || objective metric fail || critical metric missing => stage FAIL`.
4) AC-4 backward compatibility: deliverable explicitly retains legacy `./codex-verify.sh` output path (without eval) and shows compatibility evidence preserving original `VERDICT: PASS/FAIL` behavior; no non-eval path changes are claimed.
5) AC-5 failover/unknown handling: deliverable explicitly documents fail-safe for missing critical metric (`missing build_status metric => FINAL_VERDICT: FAIL`) and fail on build failures, covering ambiguity/unknown handling.

Conclusion: PASS against Acceptance-Criteria in `inbox/plan-004.md`.

Residual checks not evidenced in deliverable content:
- No direct repository diff is included for code-level proof in the provided materials.
- No formal pass/fail log for each AC is attached outside the stated command output snippets.
