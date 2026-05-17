---
name: lint
description: Run lint and typecheck, report issues with severity
---

## Instructions
1. Detect lint/typecheck tools (eslint, tsc, flake8, pylint, golangci-lint, etc.)
2. Run lint + typecheck commands in the project directory
3. Capture stdout/stderr
4. Categorize issues by severity: error, warning, info
5. For each error: file, line, rule, message
6. If auto-fixable: suggest running the fix command

## Output Format
### Lint Results
- **Tool**: {detected}
- **Errors**: {n}
- **Warnings**: {n}
- **Auto-fixable**: {n}

### Issues
- **ERROR** {file}:{line} — {rule}: {message}
- **WARN** {file}:{line} — {rule}: {message}

### Auto-fix Command
```bash
{fix_command}
```
