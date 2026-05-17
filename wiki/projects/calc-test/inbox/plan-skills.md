# Plan: CodePatchbay Agent Skills System

## Context
CodePatchbay 的 3 个 profile（Claude/Codex/Reviewer）目前只有 soul.md（角色定义）+ config.json（权限配置），没有 skill 系统。需要给每个角色添加专用 skills，让 ACP agent 在执行过程中可以调用结构化的指令模板。

## 设计原则
- Skills = 静态 markdown 指令文件，不是可执行脚本
- Catalog-in-prompt, body-on-demand：prompt 只注入 skill 目录（name + description + 路径），agent 需要时通过 fs/read_text_file 读取完整内容
- 向后兼容：skills/ 目录不存在时优雅降级
- **单一数据源**：目录扫描是唯一 source of truth，config.json 不重复维护
- **Prompt 大小保护**：catalog 最多注入 10 个 skill，超出截断

## Skill 文件格式（简化版，无 trigger 字段）

```markdown
---
name: test
description: Auto-run project tests and report results
---

## Instructions
1. Detect test framework (package.json scripts, Makefile, etc.)
2. Run tests in project directory
3. Capture stdout/stderr
4. Report: pass count, fail count, failures detail
5. If failures: analyze root cause, suggest fixes

## Output Format
### Test Results
- Framework: {detected}
- Passed: {n}
- Failed: {n}
- Duration: {time}

### Failures (if any)
- {file}:{line} — {error}
```

## 新建文件（6 个 skill）

### Claude (Builder-Executor) — 可执行命令
| File | Skill | 说明 |
|------|-------|------|
| profiles/claude/skills/test.md | /test | 运行项目测试（npm test / pytest / go test 等） |
| profiles/claude/skills/lint.md | /lint | 运行 lint + typecheck（eslint / tsc / flake8 等） |

### Codex (Planner-Verifier) — 只读分析
| File | Skill | 说明 |
|------|-------|------|
| profiles/codex/skills/review.md | /review | 结构化代码审查模板（严重程度分级） |
| profiles/codex/skills/audit.md | /audit | 安全审计清单（OWASP Top 10） |

### Reviewer (Code Reviewer) — 只读分析（不执行命令）
| File | Skill | 说明 |
|------|-------|------|
| profiles/reviewer/skills/lint.md | /lint | 代码风格/模式静态分析（读代码，不运行 lint 命令） |
| profiles/reviewer/skills/check.md | /check | deliverable vs plan 验证矩阵 |

## 修改文件（4 个，不再改 config.json）

### 1. server/services/profile-loader.js
- 添加 parseSkill(filePath) 函数：解析 YAML frontmatter（name + description）+ body
- **容错处理**：空文件、缺少 frontmatter、BOM、非 map YAML → 跳过 + console.warn，不中断加载
- loadProfile() 中扫描 profiles/<role>/skills/*.md，**排序后截断**（`files.sort()` 保证确定性）
- 返回 { ..., skills: [{ name, description, path }] }
- 缺少 skills/ 目录时返回空数组
- **最多加载 10 个 skill**，排序后取前 10，超出截断 + warn

### 2. bridges/common.sh
- 添加 build_skills_section(role) 函数：
  ```bash
  build_skills_section() {
    local role="$1" skills_dir="$CPB_ROOT/profiles/$role/skills"
    [ -d "$skills_dir" ] || return
    local count=0
    echo "## Available Skills (read via fs/read_text_file)"
    for f in $(ls "$skills_dir"/*.md 2>/dev/null | sort); do
      [ -f "$f" ] || continue
      [ $count -ge 10 ] && { echo "- ... (truncated, max 10)"; break; }
      local name desc
      # Only parse frontmatter (between first pair of ---)
      local fm
      fm=$(awk 'BEGIN{n=0} /^---$/{n++; if(n==2) exit} n==1 && !/^---$/{print}' "$f")
      name=$(echo "$fm" | sed -n 's/^name: *//p' | head -1)
      desc=$(echo "$fm" | sed -n 's/^description: *//p' | head -1)
      if [ -n "$name" ]; then
        echo "- /$name: $desc → $f"
        count=$((count + 1))
      fi
    done
  }
  ```
- 注入到 rtk_codex_plan, rtk_claude_execute, rtk_codex_verify 的 prompt 中
- **修复 rtk_claude_execute 约束**：添加 `$CPB_ROOT/profiles/` 到允许读取路径

### 3. bridges/reviewer-review.sh
- 注入 skill catalog 到 reviewer prompt

### 4. bridges/review-dispatch.mjs
- 在 prompt builders 中添加一行 skill 目录引用

## 不再修改
- config.json — 不添加 skills 数组，避免双数据源漂移

## 实现顺序
1. 创建 6 个 skill markdown 文件
2. 修改 profile-loader.js 添加 skill 加载（含容错）
3. 修改 common.sh 添加 skill catalog 注入 + 修复 claude execute 约束
4. 修改 reviewer-review.sh 添加 skill 注入
5. 修改 review-dispatch.mjs 添加 skill 引用

## Acceptance Criteria
- profile-loader.js 能加载 skills/ 目录下的 markdown 文件，malformed 文件跳过不报错
- common.sh 的 RTK prompt 包含 skill catalog（最多 10 个）
- rtk_claude_execute 约束允许读取 profiles/ 目录
- Reviewer 的 /lint skill 明确是只读分析，不执行命令
- 缺少 skills/ 目录时不报错，返回空数组
- 现有 pipeline 流程不受影响
- catalog 超过 10 个 skill 时截断
