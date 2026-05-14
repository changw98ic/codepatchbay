# hello-test - Tasks

> 任务池。所有任务在此跟踪状态。

## 任务格式

```markdown
### TASK-{id}: {任务标题}
- **状态**: PENDING | IN_PROGRESS | DONE | BLOCKED
- **负责人**: codex | claude
- **阶段**: plan | execute | verify
- **关联 Plan**: plan-{id}.md（如有）
- **关联 Deliverable**: deliverable-{id}.md（如有）
- **描述**: {简要描述}
```

## 任务列表

（由 Codex 规划阶段创建，Claude 执行阶段更新）
