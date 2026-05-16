# Dashboard

> 项目状态看板。由 Codex 规划阶段更新。

## 状态

当前无活跃项目。

## 格式说明

每个项目在 `## 活跃项目
### calc-test
- **status**: DONE
- **phase**: verify
- **updated**: 2026-05-16T23:25:23Z
- **next**: completed

### novel-writer
- **status**: EXECUTING
- **phase**: plan
- **updated**: 2026-05-14T02:27:31Z
- **next**: cpb execute novel-writer 003

### empty-test
- **status**: EXECUTING
- **phase**: plan
- **updated**: 2026-05-13T17:59:08Z
- **next**: cpb execute empty-test 002

### hello-test
- **status**: EXECUTING
- **phase**: plan
- **updated**: 2026-05-13T17:57:53Z
- **next**: cpb execute hello-test 004

### colors-test
- **status**: EXECUTING
- **phase**: plan
- **updated**: 2026-05-13T17:57:48Z
- **next**: cpb execute colors-test 003

### fatecat
- **status**: DONE
- **phase**: verify
- **updated**: 2026-05-13T17:36:33Z
- **next**: completed
` 下按以下格式记录：

```markdown
### {项目名}

- **状态**: PLANNING | EXECUTING | VERIFYING | DONE | BLOCKED
- **当前阶段**: plan | execute | verify | fix
- **负责人**: codex | claude
- **最近更新**: {ISO 8601 日期}
- **下一步**: {简要描述}
- **阻塞**: {无 | 阻塞原因}
```

## 活跃项目

（初始化后自动填充）
