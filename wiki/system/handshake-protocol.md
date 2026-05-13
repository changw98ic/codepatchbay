# Handshake Protocol

> Codex ↔ Claude 的标准交接格式。所有跨模型通信必须遵循此协议。

## 概述

Codex 和 Claude Code 没有共享的 API 或 team 基础设施。它们通过文件系统中的 handoff 文件通信。每个 handoff 文件是一次有向信息传递，包含发送方、接收方、内容和验收标准。

## Handoff 格式

```markdown
## Handoff: {source} -> {target}

- **From**: codex | claude
- **To**: codex | claude
- **Project**: {project-name}
- **Phase**: plan | execute | review | fix
- **Task-Ref**: {task-id 或简述}
- **Timestamp**: {ISO 8601}

### Decided
- {已确定的关键决策，每条一行}

### Rejected
- {已否决的方案及原因}

### Files
- {涉及的文件路径列表}

### Evidence
- {命令输出、测试结果、diff 摘要等支撑材料}

### Risks
- {已知风险和不确定性}

## Next-Action
{接收方应执行的具体操作}

## Acceptance-Criteria
- {可验证的验收条件，至少一条}
```

## 方向一：Codex → Claude（plan-to-execute）

Codex 完成规划后写入 `inbox/plan-{id}.md`，Claude 读取并执行。

**Phase**: `plan`
**额外字段**:
- `Decided` 包含架构选择、技术选型
- `Acceptance-Criteria` 是 Claude 实现后的验证清单
- `Next-Action` 描述 Claude 应该实现什么

## 方向二：Claude → Codex（execute-to-review）

Claude 完成实现后写入 `outputs/deliverable-{id}.md`，Codex 读取并验证。

**Phase**: `execute`
**额外字段**:
- `Files` 列出所有变更文件
- `Evidence` 包含测试命令输出
- `Next-Action` 描述 Codex 应该验证什么

## 方向三：Codex → Claude（review-to-fix）

Codex 验证发现问题后写入 `inbox/review-{id}.md`，Claude 读取并修复。

**Phase**: `review`
**额外字段**:
- `Risks` 列出发现的问题，按严重性排序
- `Next-Action` 描述需要修复的具体问题

## 验证规则

有效的 handoff 文件必须满足：
1. 包含 `## Handoff:` 头
2. 包含 `## Next-Action` 节
3. 包含 `## Acceptance-Criteria` 节
4. `From` 和 `To` 字段为有效值
5. `Phase` 字段为有效值

不满足以上条件的文件视为无效，接收方应报告错误而非尝试执行。
