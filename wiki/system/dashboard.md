# Dashboard

> 项目状态看板。由 Codex 规划阶段更新。

## 状态

当前无活跃项目。

## 格式说明

每个项目在 `## 活跃项目
### variant-env-80979
- **status**: VERIFYING
- **phase**: execute
- **updated**: 2026-05-13T10:26:30Z
- **next**: flow verify variant-env-80979 003

### variant-env-74610
- **status**: VERIFYING
- **phase**: execute
- **updated**: 2026-05-13T10:25:38Z
- **next**: flow verify variant-env-74610 003

### variant-env-55692
- **status**: VERIFYING
- **phase**: execute
- **updated**: 2026-05-13T10:24:22Z
- **next**: flow verify variant-env-55692 001

### acp-test-39028
- **status**: UNCLEAR
- **phase**: verify
- **updated**: 2026-05-13T08:52:56Z
- **next**: manual review needed

### acp-test-24185
- **status**: UNCLEAR
- **phase**: verify
- **updated**: 2026-05-13T08:51:05Z
- **next**: manual review needed

### acp-test-9415
- **status**: UNCLEAR
- **phase**: verify
- **updated**: 2026-05-13T08:47:01Z
- **next**: manual review needed

### acp-test-97563
- **status**: UNCLEAR
- **phase**: verify
- **updated**: 2026-05-13T08:45:05Z
- **next**: manual review needed

### fatecat
- **status**: EXECUTING
- **phase**: plan
- **updated**: 2026-05-13T08:44:46Z
- **next**: flow execute fatecat 001

### acp-test-92077
- **status**: UNCLEAR
- **phase**: verify
- **updated**: 2026-05-13T08:44:26Z
- **next**: manual review needed

### acp-debug-89322
- **status**: EXECUTING
- **phase**: plan
- **updated**: 2026-05-13T08:43:43Z
- **next**: flow execute acp-debug-89322 001

### acp-test-87717
- **status**: EXECUTING
- **phase**: plan
- **updated**: 2026-05-13T08:43:18Z
- **next**: flow execute acp-test-87717 001

### acp-test-85689
- **status**: EXECUTING
- **phase**: plan
- **updated**: 2026-05-13T08:42:55Z
- **next**: flow execute acp-test-85689 001
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
