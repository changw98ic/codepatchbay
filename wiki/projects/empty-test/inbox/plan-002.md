# 在 inbox 目录下创建一个 config.json 配置文件

**From:** codex  
**To:** claude  
**Phase:** plan  
**Scope:** `__ABS_WORKSPACE_CPB_PATH__/wiki/projects/empty-test/inbox/`（仅此目录写入）

## 目标
在目标项目中，于 `inbox` 目录生成 `config.json`，作为后续配置基线文件；不修改其他目录与文件。

## 前置约束（执行边界）
1. 仅写入：`__ABS_WORKSPACE_CPB_PATH__/wiki/projects/empty-test/inbox/`
2. 仅读取：  
   - `__ABS_WORKSPACE_CPB_PATH__/wiki/projects/empty-test/context.md`
   - `__ABS_WORKSPACE_CPB_PATH__/wiki/projects/empty-test/decisions.md`
   - `__ABS_WORKSPACE_CPB_PATH__/profiles/codex/soul.md`
   - `__ABS_WORKSPACE_CPB_PATH__/wiki/system/handshake-protocol.md`
   - `__ABS_WORKSPACE_CPB_PATH__/templates/handoff/plan-to-execute.md`
3. 不执行终端命令，仅产出计划文件。
4. 产物命名遵循用户指定：`plan-002.md`

## 范围匹配计划步骤（4 步）

### Step 1：对齐任务与边界（输入核对）
- 依据上述上下文文件确认“config.json”在项目中的语义与最小必需字段。
- 明确目标目录为 `inbox/`，并与现有决策保持一致（不得引入与当前任务无关项）。

**验收标准**
- 能清楚写出 `config.json` 的用途边界：用于 `empty-test` 的配置基线文件。
- 未扩展到其他目录的修改要求。

### Step 2：定义 `config.json` 内容规范
- 从上下文抽取项目元数据：项目标识、任务名称、计划来源、创建时间或版本字段。
- 仅保留本任务必须项，避免冗余配置项。
- 使用 JSON 对象根结构，字段命名与风格与既有项目约定一致（若已定义则复用）。

**验收标准**
- 生成字段清单包含：`project_id`、`task`、`created_by`、`phase`、`scope`、`status`。
- JSON 语义完整可解释，无未定义占位符。

### Step 3：制定创建文件的具体动作
- 计划目标文件路径：`__ABS_WORKSPACE_CPB_PATH__/wiki/projects/empty-test/inbox/config.json`
- 文件应采用 UTF-8 编码、`json` 格式，无注释，含最小可用配置。
- 预定义可执行动作：创建文件并写入最终配置内容。

**验收标准**
- 文件存在且仅位于 `inbox/` 下。
- JSON 可被标准解析器正确解析。
- 未包含 trailing comma、单引号键名或其他非法 JSON 语法。

### Step 4：产出与交付校验
- 在 `inbox/` 目录下确认仅产出本次计划文件（`plan-002.md`）作为规划交付；不提交真实 `config.json`。
- 输出执行说明，供后续执行者按 plan 落地实际 `config.json`。

**验收标准**
- 本计划文件完整且符合本节所示结构。
- 未出现越权写路径或额外文件改动。
- 规划中含明确的 `Phase: plan` 握手信息与目标标题。

## 交付说明
- 本文件即为当前 `Phase: plan` 的执行计划。  
- 执行层面（实际创建 `inbox/config.json`）按以上步骤 2~3 的字段与规则实施。
