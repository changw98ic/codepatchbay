# Plan: Create a LICENSE file with MIT license text

## Handshake
- from: codex
- to: claude
- phase: plan
- task: Create a LICENSE file with MIT license text
- project: __ABS_WORKSPACE_CPB_PATH__/wiki/projects/hello-test
- scope: __ABS_WORKSPACE_CPB_PATH__/wiki/projects/hello-test/inbox/plan-004.md

## Objective
Produce a deterministic implementation plan so Claude can create `LICENSE` with the canonical MIT license text in the project `hello-test`.

## Constraints
- Only write under `__ABS_WORKSPACE_CPB_PATH__/wiki/projects/hello-test/inbox/`.
- Only read from:
  - `__ABS_WORKSPACE_CPB_PATH__/wiki/projects/hello-test/`
  - `__ABS_WORKSPACE_CPB_PATH__/profiles/`
  - `__ABS_WORKSPACE_CPB_PATH__/wiki/system/`
  - `__ABS_WORKSPACE_CPB_PATH__/templates/`
- No terminal command execution in this phase.
- Keep scope strictly to the license task only.

## Scope-matched plan steps

1. Gather project and policy context before drafting
   - Collect and reconcile constraints from role/project/decision/handshake/template files.
   - Acceptance criteria:
     - Confirms the output path and permitted read/write boundaries.
     - Confirms no ancillary tasks are included in the plan.
     - Confirms the plan title includes exactly the required task phrase.

2. Define the exact LICENSE payload
   - Prepare the full MIT license body (including placeholders only as required and with placeholder year/holder values explicitly called out for final insertion).
   - Acceptance criteria:
     - License text is the MIT license and is complete.
     - Required metadata fields are identified (`[year]`, `[fullname]`).
     - No extra repository-specific policy text is introduced.

3. Execute file creation with precise scope
   - Create/update `LICENSE` in the project deliverable location per project policy.
   - Preserve only one source-of-truth LICENSE file and no duplicate license files in conflicting paths.
   - Acceptance criteria:
     - `LICENSE` file exists at the agreed project path.
     - File content matches the MIT template exactly except for expected placeholders/insertion values.
     - No files outside `__ABS_WORKSPACE_CPB_PATH__/wiki/projects/hello-test/` are modified.

## Definition of done
- `LICENSE` contains valid MIT license text.
- Scope and constraints above are fully respected.
- Ready for handoff to implementation/execute with zero follow-up items in this plan.
