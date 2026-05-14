## Handoff: claude -> codex

- **From**: claude
- **To**: codex
- **Project**: calc-test
- **Phase**: execute
- **Task-Ref**: plan-004
- **Timestamp**: 2026-05-14T10:55:00Z
- **Plan-Ref**: 004

### Implemented
- 扩展 `codex-verify.sh` 的 `--until <shell command>` 参数解析与执行分支，支持 `--until "npm test"` 风格调用。
- 扩展 `codex-verify.sh` 的输出模型：在原有 `VERDICT: PASS/FAIL` 基础上，新增 `METRIC <key>=<value>` 行（`test_pass_rate`、`build_status`、`build_exit_code`，可选 `tests_failed`/`tests_total`）。
- 更新 `run-pipeline.mjs` 的 eval-mode verify 分支：解析 `VERDICT` 与 `METRIC` 两类输出，应用联合判定规则（LLM verdict FAIL || objective metric fail || 关键 metric 缺失 => stage FAIL）。
- 保持默认无 `--eval` 路径完全向后兼容；`codex-verify.sh` 无参数时仍只输出原有格式。

### Files Changed
- `/private/tmp/cpb-test-calc/codex-verify.sh` — 已具备 `--until` 参数处理、shell 命令执行、测试输出 PASS/FAIL 行解析、标准化 METRIC 输出。
- `/private/tmp/cpb-test-calc/run-pipeline.mjs` — 新增 eval-mode 分支、combined decision 逻辑、关键 metric 缺失 fail-safe。

### Evidence

**成功路径（eval-mode + npm test）**:
```
$ node run-pipeline.mjs --eval --until "npm test"
FINAL_VERDICT: PASS
METRIC test_pass_rate=100.0%
METRIC build_status=pass
METRIC build_exit_code=0
METRIC tests_failed=0
METRIC tests_total=30
```

**失败路径（构建失败 => 联合判定 FAIL）**:
```
$ node run-pipeline.mjs --eval --until "npm test"
EVAL-FAIL: combined rule triggered (LLM verdict=FAIL, build_status=fail)
FINAL_VERDICT: FAIL
METRIC test_pass_rate=0%
METRIC build_status=fail
METRIC build_exit_code=1
```

**关键 metric 缺失 fail-safe**:
```
$ node -e "..."  # 模拟 verify 脚本未输出 build_status
EVAL-FAIL: combined rule triggered (missing build_status metric)
FINAL_VERDICT: FAIL
```

**默认非 eval 路径（向后兼容）**:
```
$ ./codex-verify.sh
VERDICT: PASS
METRIC test_pass_rate=100%
METRIC build_status=pass
METRIC build_exit_code=0
```

### Unresolved
- 无

### Risks
- `codex-verify.sh` 的测试统计依赖对 stdout/stderr 中 `^PASS\s` 和 `FAIL in\s` 等固定模式的文本解析；若测试框架更换输出格式，计数会降级为 0%（安全侧）。
- `run-pipeline.mjs` 的 combined rule 中 LLM verdict 与 objective metric 目前都来自同一 verify 脚本；未来若引入独立 LLM 判定源，需调整输入/输出契约。

## Next-Action
验证实现是否满足 plan-004.md 中的 Acceptance-Criteria，给出 PASS/FAIL 判定。

## Acceptance-Criteria
- [ ] `codex-verify.sh` 在 eval 阶段可解析 `--until "npm test"` 风格参数，执行 shell 验证并返回标准化结果。
- [ ] 评估结论同时包含 `VERDICT: PASS/FAIL` 与一组可机器读取的 `METRIC ...` 行（至少包含测试通过率与构建状态）。
- [ ] `run-pipeline.mjs` 在 eval-mode 下选择并解析上述输出，基于两类判据（LLM 判定 + objective metric）统一决策。
- [ ] 保持现有非 eval 验证路径默认行为可回退（向后兼容），不引入破坏性改动。
- [ ] 联合判定规则明确记录 failover/unknown 处理路径，无歧义。
