# Dashboard

> 项目状态看板。由 CPB/OMX 运行时更新。

## 状态

当前记录 1 个 wiki 项目；Hub 注册表当前仅启用 `flow`。

## 格式说明

每个项目在 `## 活跃项目
### variant-env-75072
- **status**: VERIFYING
- **phase**: execute
- **updated**: 2026-05-20T13:40:43Z
- **next**: cpb verify variant-env-75072 004

### acp-pipeline-56526
- **status**: DONE
- **phase**: verify
- **updated**: 2026-05-20T13:40:41Z
- **next**: completed

### acp-test-56526
- **status**: DONE
- **phase**: verify
- **updated**: 2026-05-20T13:40:14Z
- **next**: completed

### flow
- **status**: VERIFYING
- **phase**: execute
- **updated**: 2026-05-20T11:33:11Z
- **next**: cpb verify flow 009
` 下按以下格式记录：

```markdown
### {项目名}

- **状态**: PLANNING | EXECUTING | VERIFYING | DONE | BLOCKED | UNCLEAR
- **当前阶段**: plan | execute | verify | fix
- **负责人**: codex | claude | unknown
- **最近更新**: {ISO 8601 日期}
- **下一步**: {简要描述}
- **阻塞**: {无 | 阻塞原因}
```

## 活跃项目

- **状态**: VERIFYING
- **当前阶段**: execute
- **负责人**: claude
- **最近更新**: 2026-05-20T03:50:24Z
- **下一步**: `cpb verify flow 006`
- **阻塞**: 无
