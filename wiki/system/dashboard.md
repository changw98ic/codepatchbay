# Dashboard

> 项目状态看板。由 Codex 规划阶段更新。

## 状态

当前无活跃项目。

## 格式说明

每个项目在 `## 活跃项目
### variant-env-23510
- **status**: VERIFYING
- **phase**: execute
- **updated**: 2026-05-14T15:24:14Z
- **next**: cpb verify variant-env-23510 003

### acp-pipeline-22654
- **status**: DONE
- **phase**: verify
- **updated**: 2026-05-14T15:24:13Z
- **next**: completed

### acp-test-22654
- **status**: DONE
- **phase**: verify
- **updated**: 2026-05-14T15:24:12Z
- **next**: completed

### variant-env-12210
- **status**: VERIFYING
- **phase**: execute
- **updated**: 2026-05-14T15:23:16Z
- **next**: cpb verify variant-env-12210 003

### acp-pipeline-12843
- **status**: DONE
- **phase**: verify
- **updated**: 2026-05-14T15:23:15Z
- **next**: completed

### acp-test-12843
- **status**: DONE
- **phase**: verify
- **updated**: 2026-05-14T15:23:13Z
- **next**: completed

### variant-env-98319
- **status**: VERIFYING
- **phase**: execute
- **updated**: 2026-05-14T15:22:01Z
- **next**: cpb verify variant-env-98319 003

### acp-pipeline-98762
- **status**: DONE
- **phase**: verify
- **updated**: 2026-05-14T15:22:01Z
- **next**: completed

### acp-test-98762
- **status**: DONE
- **phase**: verify
- **updated**: 2026-05-14T15:21:59Z
- **next**: completed

### variant-env-94325
- **status**: VERIFYING
- **phase**: execute
- **updated**: 2026-05-14T15:21:25Z
- **next**: cpb verify variant-env-94325 003

### acp-pipeline-95242
- **status**: DONE
- **phase**: verify
- **updated**: 2026-05-14T15:21:24Z
- **next**: completed

### acp-test-95242
- **status**: DONE
- **phase**: verify
- **updated**: 2026-05-14T15:21:22Z
- **next**: completed

### acp-pipeline-79225
- **status**: DONE
- **phase**: verify
- **updated**: 2026-05-14T15:16:07Z
- **next**: completed

### acp-test-79225
- **status**: DONE
- **phase**: verify
- **updated**: 2026-05-14T15:16:05Z
- **next**: completed

### calc-test
- **status**: DONE
- **phase**: verify
- **updated**: 2026-05-14T14:39:24Z
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
