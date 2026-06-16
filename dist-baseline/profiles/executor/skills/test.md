---
name: test
description: Auto-run project tests and report results
---

## Instructions
1. Detect test framework (package.json scripts, Makefile, pytest.ini, go.mod, etc.)
2. Run the appropriate test command in the project directory
3. Capture stdout/stderr
4. Report: pass count, fail count, failures detail
5. If failures: analyze root cause, suggest fixes

## Output Format
### Test Results
- **Framework**: {detected}
- **Passed**: {n}
- **Failed**: {n}
- **Duration**: {time}

### Failures (if any)
- {file}:{line} — {error}
- **Root Cause**: {analysis}
- **Suggested Fix**: {fix}
