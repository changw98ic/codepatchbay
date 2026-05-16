# novel-writer - Decisions

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

### DEC-001: Skip Codex verify phase for novel-writer
- **状态**: [ACTIVE]
- **决定**: 在 novel-writer 项目中跳过 CodePatchbay pipeline 的 Codex verify 阶段，由人工 review 替代
- **原因**: Codex ACP adapter (`codex-acp`) 在 verify 阶段两次卡住（P0 和 P1），lease 过期后进程僵死不退出。两次 execute 阶段均成功完成且 dart analyze 通过，问题仅在 Codex ACP 的响应超时处理上
- **否决**: 修复 Codex ACP——超出 novel-writer 项目范围，应作为 CodePatchbay 框架的 bug 处理
- **日期**: 2026-05-14
