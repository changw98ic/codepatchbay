---
name: lint
description: Static analysis of code style and patterns (read-only, no commands executed)
---

## Instructions
**This is a READ-ONLY analysis. Do NOT execute any lint or build commands.**

1. Read the target source files
2. Analyze for code style and pattern issues:
   - Naming conventions (camelCase, snake_case consistency)
   - Function length (>50 lines = warning)
   - Nesting depth (>3 levels = warning)
   - Magic numbers and hardcoded strings
   - Missing error handling
   - Unused imports/variables
   - Inconsistent patterns across files
3. Check for common anti-patterns:
   - God objects/functions
   - Circular dependencies
   - Tight coupling
   - Missing abstractions at boundaries

## Output Format
### Style Analysis
- **Files Analyzed**: {n}
- **Issues Found**: {n}

### Issues by Category
- **Naming**: {n} issues
- **Complexity**: {n} issues
- **Error Handling**: {n} issues
- **Patterns**: {n} issues

### Details
- `{file}:{line}` — **{category}**: {description}
  - **Suggestion**: {improvement}
