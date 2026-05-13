# Skill Registry

> 技能分配表：每个能力只分配给特定角色，防止角色边界模糊。

## 角色技能映射

### Codex（规划 + 验证）

| 技能 | 使用的 Agent | 触发条件 |
|------|-------------|----------|
| 任务规划 | `omx planner` | 新任务需要拆解 |
| 架构决策 | `omx architect` | 涉及系统设计变更 |
| 代码审查 | `omx code-reviewer` | Claude 交付后验证 |
| 完成验证 | `omx verifier` | 检查实现是否达标 |
| 安全审查 | `omx security-reviewer` | 涉及认证/权限/数据 |

### Claude Code（执行）

| 技能 | 使用的 Agent | 触发条件 |
|------|-------------|----------|
| 代码实现 | `omc executor` | 有明确的实现计划 |
| 调试修复 | `omc debugger` | 测试失败或 bug 报告 |
| 测试编写 | `omc test-engineer` | 需要新增测试覆盖 |
| 前端实现 | `omc designer` | UI/界面相关任务 |
| 重构 | `omc refactoring-expert` | 代码质量改进 |

### 禁止分配

以下能力不得跨角色分配：
- Codex 不得有代码实现能力（它只规划不执行）
- Claude 不得有架构审批能力（它只执行不审批）
- 任何角色不得同时拥有规划和执行同一任务的能力
