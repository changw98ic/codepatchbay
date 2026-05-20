# Handshake Protocol

> CodePatchbay role-to-role handoff format. All cross-phase communication must follow this protocol.

## 概述

CodePatchbay phases communicate through handoff files in the filesystem. Each handoff file is a directed transfer between roles, with sender, receiver, evidence, and acceptance criteria.

## Handoff 格式

```markdown
## Handoff: {source} -> {target}

- **From**: planner | executor | reviewer | verifier | repairer
- **To**: planner | executor | reviewer | verifier | repairer
- **Project**: {project-name}
- **Phase**: plan | execute | review | verify | repair
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

## 方向一：planner → executor（plan-to-execute）

Planner 完成规划后写入 `inbox/plan-{id}.md`，executor 读取并执行。

**Phase**: `plan`
**额外字段**:
- `Decided` 包含架构选择、技术选型
- `Acceptance-Criteria` 是 executor 实现后的验证清单
- `Next-Action` 描述 executor 应该实现什么

## 方向二：executor → verifier（execute-to-verify）

Executor 完成实现后写入 `outputs/deliverable-{id}.md`，verifier 读取并验证。

**Phase**: `execute`
**额外字段**:
- `Files` 列出所有变更文件
- `Evidence` 包含测试命令输出
- `Next-Action` 描述 verifier 应该验证什么

## 方向三：verifier/reviewer → executor（review-to-fix）

Verifier 或 reviewer 发现问题后写入 review/fix guidance，executor 读取并修复。

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
