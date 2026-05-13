# Memory Routing

> 防污染路由规则：什么信息写到哪里。所有参与方必须遵守。

## 路由表

| 信息类型 | 写入位置 | 谁写 | 谁读 |
|----------|----------|------|------|
| 角色身份 | `profiles/{role}/soul.md` | 框架 | 所有 |
| 用户偏好 | `profiles/{role}/USER.md` | 框架 | 所有 |
| 角色经验 | `profiles/{role}/memory.md` | 框架 | 对应角色 |
| Wiki 宪法 | `wiki/schema.md` | 框架 | 所有（只读） |
| Handoff 格式 | `wiki/system/handshake-protocol.md` | 框架 | 所有（只读） |
| 项目说明书 | `wiki/projects/{name}/context.md` | 用户/Codex | 所有 |
| 架构决策 | `wiki/projects/{name}/decisions.md` | Codex | 所有 |
| 任务分类 | `wiki/projects/{name}/tasks/{task-id}/classification.yaml` | Coordinator | 所有 |
| 实现计划 | `wiki/projects/{name}/inbox/plan-{id}.md` | Codex | Claude |
| 代码审查 | `wiki/projects/{name}/inbox/review-{id}.md` | Codex | Claude |
| 实现产出 | `wiki/projects/{name}/outputs/deliverable-{id}.md` | Claude | Codex |
| 测试报告 | `wiki/projects/{name}/outputs/test-report-{id}.md` | Claude | Codex |
| 质量判定 | `wiki/projects/{name}/outputs/verdict-{id}.md` | Codex | 用户/Claude |
| 推进日志 | `wiki/projects/{name}/log.md` | Claude | 所有 |
| 任务池 | `wiki/projects/{name}/tasks.md` | Codex/Coordinator | 所有 |
| 看板状态 | `wiki/system/dashboard.md` | Codex | 所有 |
| 操作记录 | `wiki/system/agent-log.md` | 所有 | 所有 |
| 跨项目方法论 | `wiki/pages/` | 框架（经验证后） | 所有 |
| 原始资料 | `wiki/raw/` | 用户/Researcher | 所有（只读） |
| 归档 | `wiki/archive/` | 框架 | 所有 |

## 防污染原则

1. **项目状态 ≠ 角色身份** — 项目进度不写入 `soul.md`
2. **临时想法 ≠ 长期知识** — 草稿不写入 `pages/`
3. **角色经验 ≠ 项目规则** — 通用经验不写入 `agents.md`
4. **原始资料 ≠ 最终结论** — 未验证材料不写入 `outputs/`

## 进入 pages/ 的条件

一条知识必须同时满足三个条件才能写入 `wiki/pages/`：
1. 跨项目可复用
2. 不是临时判断
3. 经过验证或抽象
