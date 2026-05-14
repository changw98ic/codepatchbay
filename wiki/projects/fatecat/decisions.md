# fatecat - Decisions

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

### DEC-001: Direct ACP Claude Execution With Codex PRD Ledger
- **状态**: [ACTIVE]
- **决定**: 后续 FateCat PRD 推进采用 ACP 直连 Claude Code 执行；Codex 不再通过 `cpb execute` 包装 Claude，而是负责创建/修正 PRD plan、读取执行结果、补充 deliverable/verdict、运行验证并向用户汇报。
- **原因**: `cpb execute` 已多次出现 Claude ACP 完成或部分完成代码修改后卡在 handoff 写入阶段；direct ACP 保留 Claude Code 执行能力，同时减少 CodePatchbay 包装层的占位文件和收尾卡点。
- **否决**: 继续默认使用 `cpb execute` 调度 Claude | 易重复产生空 deliverable，占用进程并阻塞 PRD 节奏。
- **否决**: 让 Codex 直接承担所有实现 | 用户指定 Claude 通过 ACP 执行，Codex 保持记录、验证和汇报职责。
- **日期**: 2026-05-13T12:55:52Z
