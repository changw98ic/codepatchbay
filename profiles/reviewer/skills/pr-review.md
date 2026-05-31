# PR Review Skill

Performs a read-only code review of a GitHub pull request diff.

## Input

- `repo`: GitHub repository in `owner/repo` format
- `prNumber`: Pull request number
- `focus`: Optional review focus area (e.g., "security", "performance")

## Behavior

1. Fetch PR diff and metadata via `gh` CLI
2. Send diff to reviewer agent for analysis
3. Produce structured review with severity-tagged findings
4. Optionally post review as PR comment on GitHub

## Constraints

- **Read-only**: Never modifies code or creates commits
- Only reads PR diff and metadata
- Posts review comment only when explicitly requested (`--post`)

## Output Format

```
VERDICT: <approved|changes_requested|needs_discussion>

## Summary
<one paragraph overview>

## Issues
- [P0-P3] tagged findings with file:line references

## Recommendation
<clear advice>
```

## Usage

```bash
cpb review --pr owner/repo 123
cpb review --pr owner/repo 123 --post --focus "security review"
```

Or via API:

```bash
curl -X POST /api/review/pr \
  -H "Content-Type: application/json" \
  -d '{"repo":"owner/repo","prNumber":123,"postComment":true}'
```
