# Add a hello.txt file with greeting

## Handshake (codex -> claude)

- Sender: `codex`
- Recipient: `claude`
- Phase: `plan`
- Task ID: `plan-007`
- Task: Add a `hello.txt` file with greeting
- Timestamp: `2026-05-14`

## Scope

- Write target directory: `__ABS_WORKSPACE_CPB_PATH__/wiki/projects/fatecat/inbox/`
- No other filesystem paths are modified in this plan.

## Plan

### 1) Create a single new file in inbox
- Action: add `__ABS_WORKSPACE_CPB_PATH__/wiki/projects/fatecat/inbox/hello.txt`.
- Acceptance criteria:
  - The file exists at the exact path above.
  - It is a newly created file and only this file is added for this task.

### 2) Add a clear greeting payload to `hello.txt`
- Action: write a greeting message in plain text (for example `Hello, FateCat!`).
- Acceptance criteria:
  - File content is non-empty and clearly expresses a greeting.
  - Content is human-readable and uses UTF-8 text.

### 3) Add minimal future-proof metadata to the file
- Action: include a single-line timestamp or short note that this file is task-generated.
- Acceptance criteria:
  - The note is optional but present.
  - It does not add any non-text complexity or extra formatting.

## Completion definition

- Complete when:
  - `hello.txt` is created under the inbox path.
  - Content contains at least one greeting sentence.
  - No files outside the inbox path are changed.

