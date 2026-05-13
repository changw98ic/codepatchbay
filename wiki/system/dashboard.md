# Dashboard

> 项目状态看板。由 Codex 规划阶段更新。

## 状态

当前无活跃项目。

## 格式说明

每个项目在 `## 活跃项目
### dogfood-runtime-45625
- **status**: DONE
- **phase**: verify
- **updated**: 2026-05-13T13:18:14Z
- **next**: completed

### dogfood-runtime-41276
- **status**: DONE
- **phase**: verify
- **updated**: 2026-05-13T13:17:22Z
- **next**: completed

### acp-pipeline-33697
- **status**: DONE
- **phase**: verify
- **updated**: 2026-05-13T13:16:35Z
- **next**: completed

### acp-test-33697
- **status**: DONE
- **phase**: verify
- **updated**: 2026-05-13T13:16:34Z
- **next**: completed

### dogfood-runtime-17100
- **status**: DONE
- **phase**: verify
- **updated**: 2026-05-13T13:13:20Z
- **next**: completed

### acp-pipeline-9596
- **status**: DONE
- **phase**: verify
- **updated**: 2026-05-13T13:12:31Z
- **next**: completed

### acp-test-9596
- **status**: DONE
- **phase**: verify
- **updated**: 2026-05-13T13:12:30Z
- **next**: completed

### acp-pipeline-60326
- **status**: DONE
- **phase**: verify
- **updated**: 2026-05-13T13:05:11Z
- **next**: completed

### acp-test-60326
- **status**: DONE
- **phase**: verify
- **updated**: 2026-05-13T13:05:10Z
- **next**: completed

### acp-pipeline-debug-56359
- **status**: VERIFYING
- **phase**: execute
- **updated**: 2026-05-13T13:04:56Z
- **next**: flow verify acp-pipeline-debug-56359 001

### acp-test-47727
- **status**: VERIFYING
- **phase**: execute
- **updated**: 2026-05-13T13:04:33Z
- **next**: flow verify acp-test-47727 001

### acp-pipeline-35923
- **status**: UNCLEAR
- **phase**: verify
- **updated**: 2026-05-13T13:03:30Z
- **next**: manual review needed

### acp-test-35923
- **status**: UNCLEAR
- **phase**: verify
- **updated**: 2026-05-13T13:03:30Z
- **next**: manual review needed

### acp-pipeline-debug-6947
- **status**: UNCLEAR
- **phase**: verify
- **updated**: 2026-05-13T12:58:50Z
- **next**: manual review needed

### acp-pipeline-4678
- **status**: UNCLEAR
- **phase**: verify
- **updated**: 2026-05-13T12:58:36Z
- **next**: manual review needed

### acp-test-4678
- **status**: UNCLEAR
- **phase**: verify
- **updated**: 2026-05-13T12:58:36Z
- **next**: manual review needed

### acp-pipeline-2848
- **status**: UNCLEAR
- **phase**: verify
- **updated**: 2026-05-13T12:58:27Z
- **next**: manual review needed

### acp-test-2848
- **status**: UNCLEAR
- **phase**: verify
- **updated**: 2026-05-13T12:58:26Z
- **next**: manual review needed

### acp-pipeline-debug-97861
- **status**: UNCLEAR
- **phase**: verify
- **updated**: 2026-05-13T12:57:59Z
- **next**: manual review needed

### acp-pipeline-92269
- **status**: UNCLEAR
- **phase**: verify
- **updated**: 2026-05-13T12:57:42Z
- **next**: manual review needed

### acp-test-92269
- **status**: UNCLEAR
- **phase**: verify
- **updated**: 2026-05-13T12:57:41Z
- **next**: manual review needed

### acp-pipeline-89929
- **status**: UNCLEAR
- **phase**: verify
- **updated**: 2026-05-13T12:57:32Z
- **next**: manual review needed

### acp-test-89929
- **status**: UNCLEAR
- **phase**: verify
- **updated**: 2026-05-13T12:57:31Z
- **next**: manual review needed

### fatecat
- **status**: VERIFYING
- **phase**: execute
- **updated**: 2026-05-13T12:47:19Z
- **next**: flow verify fatecat 002

### variant-env-5085
- **status**: VERIFYING
- **phase**: execute
- **updated**: 2026-05-13T10:29:58Z
- **next**: flow verify variant-env-5085 003

### acp-test-5084
- **status**: UNCLEAR
- **phase**: verify
- **updated**: 2026-05-13T10:29:58Z
- **next**: manual review needed

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
�充）
