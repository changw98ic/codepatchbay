# Verify stage eval loops: extend verdict to support objective metrics alongside LLM judgment. Add `--until "npm test"` style shell verification to `codex-verify.sh`, so verdict includes both `VERDICT: PASS/FAIL` and `METRIC` lines (e.g. test pass rate, build status). Update `run-pipeline.mjs` to support eval-mode verify.

codex->claude  
Phase: plan

## Scope boundary
- 目标范围仅限：`codex-verify.sh` 的评估输出扩展、`run-pipeline.mjs` 的 eval-mode 验证流程接入、以及两者之间的判定契约对齐。
- 不改动：验证脚本之外的评分模型、平台侧指标存储、CI/CD 基础设施配置、非 eval/非验证模式行为。
- 输出必须保持兼容：现有 `VERDICT: PASS/FAIL` 行为不变，同时新增 `METRIC` 行。
- 写文件边界遵循你给定约束，仅产出本计划文件；不执行终端命令。

## 可交付目标（Acceptance）
1. `codex-verify.sh` 在 eval 阶段可解析 `--until "npm test"` 风格参数，执行 shell 验证并返回标准化结果。
2. 评估结论同时包含：
   - `VERDICT: PASS` 或 `VERDICT: FAIL`
   - 一组可机器读取的 `METRIC ...` 行（至少包含测试通过率与构建状态）。
3. `run-pipeline.mjs` 在 eval-mode 下选择并解析上述输出，确保基于两类判据（LLM 判定 + objective metric）统一决策。
4. 保持现有非 eval 验证路径默认行为可回退（向后兼容），不引入破坏性改动。

## 工作计划（按顺序）

### 1) 对齐需求与当前契约
- 产物：
  - 明确 `codex-verify.sh` 与 `run-pipeline.mjs` 之间的输入/输出契约（字段、优先级、异常语义）。
  - 列出指标最小集合：`test_pass_rate`, `build_status`（可扩展）。
- 验收条件：
  - 在计划内定义单一来源的字段命名和状态码约束（`PASS`/`FAIL`/`UNKNOWN`）。

### 2) 设计 `--until` 执行协议
- 产物：
  - 协议定义：`--until <shell command>` 表示在 eval-run 中按顺序执行 shell 校验命令，命令成功即继续。
  - 明确命令失败/超时/空输出时的判定策略与容错默认值。
- 验收条件：
  - 命令执行结果明确映射到 `VERDICT` 与 `METRIC build_status`（至少 `pass`/`fail`）。

3) 扩展 `codex-verify.sh` 的输出模型
- 产物：
  - `VERDICT: PASS/FAIL` 行保持单例。
  - 新增 `METRIC` 行格式（建议 `METRIC <key>=<value>`，如 `METRIC test_pass_rate=87.5%`、`METRIC build_status=pass`）。
  - 将 LLM 主观结果与客观指标解耦并最终聚合。
- 验收条件：
  - 同一次运行可同时产出 verdict + 2+ metrics；指标行可独立 grep 解析。

### 4) 在 `codex-verify.sh` 中加入 `--until` 分支
- 产物：
  - 在命令行参数处理加入 `--until`；
  - 对 `npm test` 场景产生 `test_pass_rate`，并将失败测试计入 `build_status`。
- 验收条件：
  - `--until "npm test"` 能执行且不影响默认无参数路径。

### 5) 更新 `run-pipeline.mjs` 的 eval-mode verify
- 产物：
  - 新增 eval 模式分支，调用 `codex-verify.sh --until ...`（以约定命令）
  - 解析 `VERDICT` 与 `METRIC` 两类输出并作为最终 verdict 输入。
- 验收条件：
  - 在 eval 模式下，最终判定必须参考 objective metrics 与 LLM verdict 的联合规则（任一 FAIL -> 阶段 FAIL）。

### 6) 联合判定规则与降级策略
- 产物：
  - 定义组合规则（推荐）：`verdict` 初始为 PASS；若 LLM FAIL 或任何关键 METRIC fail -> FAIL；若关键 METRIC 缺失且非可选则 fail/警告（待定）。
- 验收条件：
  - 明确记录 failover/unknown 处理路径，无歧义。

### 7) 回归与交付门槛
- 产物：
- 本文件即计划交付给下游执行者；执行阶段需补齐最小验证样例（含成功/失败测试与构建失败路径）。
- 验收条件：
  - 在 eval-mode 下，运行日志可读到 `VERDICT` 与 `METRIC`，并用于 pipeline 决策。

## 目标输出格式（推荐）
- `VERDICT: PASS` 或 `VERDICT: FAIL`
- `METRIC test_pass_rate=82.0%`
- `METRIC build_status=pass`
- `METRIC build_exit_code=1`（可选）
- `METRIC tests_failed=3`（可选）
- `METRIC tests_total=17`（可选）

## 风险与缓解
- 风险：文本解析脆弱 -> 用稳定前缀与行规范，必要时 JSON 备选段落。
- 风险：`npm test` 非确定性（超时/环境差异）-> 设定超时与重试上限，并将状态记录为指标。
- 风险：LLM 判定与 objective 指标冲突 -> 采用“任一 fail 即 fail，且记录原因”规则，避免隐性放宽。

## 里程碑与依赖
- Milestone 1（契约定义）：完成步骤 1~2。
- Milestone 2（实现）：完成步骤 3~5。
- Milestone 3（决策闭环）：完成步骤 6。
- Milestone 4（执行交付）：完成步骤 7。
