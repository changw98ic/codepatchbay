# Add a 'config' file with key="value" pairs & comments

## Handshake
- from: codex
- to: claude
- phase: plan

## Context
- Task: Add a `config` file containing `key="value"` pairs and inline/comments.
- Scope constraints:
  - Read only from:
    - `/Users/chengwen/dev/flow/wiki/projects/hello-test/context.md`
    - `/Users/chengwen/dev/flow/wiki/projects/hello-test/decisions.md`
    - `/Users/chengwen/dev/flow/profiles/codex/soul.md`
    - `/Users/chengwen/dev/flow/wiki/system/handshake-protocol.md`
    - `/Users/chengwen/dev/flow/templates/handoff/plan-to-execute.md`
  - Write only under: `/Users/chengwen/dev/flow/wiki/projects/hello-test/inbox/`
  - No terminal/test/build execution in planning phase.

## Objectives
1. Deliver a deterministic `config` file format with documented comments and quoted key-values.
2. Keep the artifact narrowly scoped to one file and ready for direct handoff.
3. Ensure future execution can merge it without ambiguity.

## Plan (5 steps)
1. Confirm required key list and defaults from project context/decisions  
   - Acceptance criteria:
     - List of required keys is explicit.
     - No undefined/duplicate keys are planned.
     - Any dependency on existing conventions is captured.

2. Define `config` syntax and comment style in plan form before writing  
   - Acceptance criteria:
     - Uses exact pattern `key="value"` for each setting.
     - Uses one comment style consistently (e.g., `# comment`).
     - Includes file header explaining purpose and expected parser behavior.

3. Author `config` file structure with grouped sections  
   - Acceptance criteria:
     - Contains at least one grouping/comment block.
     - Each line is either a comment or a `key="value"` entry.
     - No non-comment blank-line policy violations (no ambiguous syntax).

4. Validate content and edge-case behavior at a human-readable level  
   - Acceptance criteria:
     - Keys include safe defaults.
     - Commented examples cover optional/advanced values.
     - No sensitive data or environment-specific secrets included.

5. Prepare handoff-ready execution note  
   - Acceptance criteria:
     - Plan includes exact file path for output artifact.
     - Includes concrete pass/fail criteria for implementation verification.
     - States any pending follow-up tasks as explicit next actions.

## Deliverable
- Create `/Users/chengwen/dev/flow/wiki/projects/hello-test/inbox/config` (or agreed filename in the execution handoff).
- Populate with:
  - A brief header comment.
  - At least 5 commented and commented-gated `key="value"` lines.
  - Optional/advanced keys annotated in comments.
- Keep the format parseable by simple line-by-line readers.
