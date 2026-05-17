# calc-test - Decisions

> 已确认的决策记录。防止反复摇摆。

## 决策格式

```markdown
### DEC-{id}: {决策标题}
- **状态**: [DRAFT] | [ACTIVE] | [LOCKED]
- **决定**: {选择了什么}
- **原因**: {为什么这样选}
- **否决**: {排除了什么及原因}
- **日期**: {ISO 8601}
```

## 决策列表

（由 Codex 在规划阶段添加，确认后标记 `[ACTIVE]`，不可逆后标记 `[LOCKED]`）

### DEC-001: Self-evolve worktree isolation approach
- **状态**: [DRAFT]
- **决定**: Split worktree isolation into two phases: (1) direct pipeline execution bypassing REST API, (2) worktree-based isolation
- **原因**: Review round identified 3 P1 blockers — pipeline execution is REST API-mediated (can't thread worktree cwd), health check runs at CPB_ROOT not worktree, --ff-only merge too aggressive without rebase
- **否决**: Original monolithic worktree plan — handwaved the hardest design problem (health check in worktree context)
- **日期**: 2026-05-14T18:40:00Z

### DEC-002: Self-evolve stash behavior
- **状态**: [ACTIVE]
- **决定**: Commit infrastructure patches before self-evolve runs, so git stash doesn't swallow them
- **原因**: self-evolve's stashRound() does `git stash push` at round start, which stashes uncommitted bridge changes. Process kill before stash pop = patches lost.
- **否决**: Excluding files from stash — too fragile, any new bridge file needs updating
- **日期**: 2026-05-14T18:30:00Z
