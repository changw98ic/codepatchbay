# Create a CONTRIBUTING.md with contribution guidelines

Handshake: codex -> claude  
Phase: plan

## Objective
Create the project contribution guideline document `CONTRIBUTING.md` for `hello-test` with clear, enforceable instructions that match existing project decisions and role expectations.

## Scope
- Write target: `/Users/chengwen/dev/cpb/wiki/projects/hello-test/inbox/plan-002.md` (this plan file)
- Final output target (for follow-up implementation): `/Users/chengwen/dev/cpb/wiki/projects/hello-test/inbox/CONTRIBUTING.md`
- Read-only reference scope:  
  - `/Users/chengwen/dev/cpb/profiles/codex/soul.md`
  - `/Users/chengwen/dev/cpb/wiki/projects/hello-test/context.md`
  - `/Users/chengwen/dev/cpb/wiki/projects/hello-test/decisions.md`
  - `/Users/chengwen/dev/cpb/wiki/system/handshake-protocol.md`
  - `/Users/chengwen/dev/cpb/templates/handoff/plan-to-execute.md`

## Plan (scope-matched: 6 steps)

1. Confirm directive and constraints
   - Re-read the role definition and project context/decisions to capture required contribution expectations, communication style, and any mandatory process gates.
   - Acceptance:
     - No instruction conflicts remain between `soul.md`, `context.md`, and `decisions.md`.
     - The plan explicitly cites at least these three source files as constraints.

2. Extract required document sections
   - Build a section map for `CONTRIBUTING.md` from project norms: setup, branch/commit policy, coding standards, testing checks, review workflow, security/behavior requirements, release notes, and escalation path.
   - Acceptance:
     - At least one section each for: Environment setup, change workflow, PR review, testing/lint validation, and issue/bug report handling.

3. Draft the contribution guide skeleton
   - Create a concrete outline with stable heading order and short rationale statements for each section.
   - Acceptance:
     - Outline includes exact markdown heading hierarchy (`#`/`##`/`###`) and no ambiguous or placeholder-only entries.

4. Draft full content with concrete commands/invariants
   - Fill each section with actionable instructions and required artifacts (e.g., mandatory commands to run, labels, checklists).
   - Acceptance:
     - Every required action has explicit owner/expected result format (e.g., “must run”, “must pass”, “must include”).
     - No policy statement is unresolved (“TBD”/“to be decided”) unless explicitly justified by missing project data.

5. Validate against source conventions and finalize
   - Cross-check draft language and section set against `decisions.md` and handshake conventions; include a short "Consistency notes" block for any deliberate deviations.
   - Acceptance:
     - The plan declares zero unresolved policy conflicts.
     - A short glossary or terminology section is included if role/protocol terms are project-specific.

6. Deliver and hand over
   - Write `/Users/chengwen/dev/cpb/wiki/projects/hello-test/inbox/CONTRIBUTING.md` using the approved content and report back completion markers.
   - Acceptance:
     - File created at required location with the title phrase: **Create a CONTRIBUTING.md with contribution guidelines** present in the plan handoff.
     - Document is self-contained and directly executable by contributors without external dependency on this plan file.

## Execution constraints for Claude
- Do not execute terminal commands.
- Only write under `/Users/chengwen/dev/cpb/wiki/projects/hello-test/inbox/`.
- Any assumptions beyond source files must be explicitly marked and justified.
