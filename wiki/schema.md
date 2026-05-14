# CodePatchbay Wiki Schema

> Wiki 宪法：所有参与模型和 Agent 必须遵守的规则。

## 文件命名规则

| 位置 | 格式 | 示例 |
|------|------|------|
| inbox | `{type}-{id}.md` | `plan-001.md`, `review-003.md` |
| outputs | `{type}-{id}.md` | `deliverable-001.md`, `verdict-002.md`, `test-report-001.md` |
| 项目文件 | `{name}.md` | `context.md`, `tasks.md`, `decisions.md`, `log.md` |

`id` 使用三位数字递增：`001`, `002`, `003`...

## 写入权限

| 模型 | 可写 | 可读 |
|------|------|------|
| Codex | `inbox/`, `decisions.md`, `outputs/verdict-*.md` | 全部 |
| Claude | `outputs/` (除 `verdict-*.md`), `log.md` | 全部 |

## 不可变规则

1. 文件头标记 `<!-- VERIFIED -->` 的文件进入只读状态，任何角色不得修改
2. `decisions.md` 中的条目一旦标记 `[LOCKED]` 不可撤销
3. `raw/` 目录下所有文件只读不改

## 原子性

- Handoff 文件必须写完整后才视为有效
- 不完整的文件（写入中途崩溃）应被检测并丢弃
- 检测方式：有效的 handoff 文件必须包含 `## Handoff` 头和 `## Acceptance-Criteria` 尾

## 页面状态标记

| 标记 | 含义 |
|------|------|
| `[DRAFT]` | 草稿，可修改 |
| `[ACTIVE]` | 生效中，可追加不可删除 |
| `[LOCKED]` | 已锁定，只读 |
| `[ARCHIVED]` | 已归档，移入 archive/ |

## 禁止事项

1. 不在 `inbox/` 中写最终产出
2. 不在 `outputs/` 中写未验证材料
3. 不在项目空间中写角色身份（那是 Profile 层的事）
4. 不在 `soul.md` 中写项目状态（那是 Wiki 层的事）
5. 不删除有 `[ACTIVE]` 或 `[LOCKED]` 标记的文件
