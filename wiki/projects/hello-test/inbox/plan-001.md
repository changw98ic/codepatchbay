## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: hello-test
- **Phase**: plan
- **Task-Ref**: TASK-001
- **Timestamp**: 2026-05-14T00:00:00+08:00

### Decided
- 以最小可交付且完整的文档质量交付 `README.md`，内容覆盖项目描述、用途、特性、安装运行、开发流程和贡献说明（当前目录缺少项目说明信息时以“待补充”字段占位并标注待确认项）。
- 只在一次实现中完成单一文档产物，不同步修改示例代码或配置文件。
- 使用 `wiki/projects/hello-test/README.md` 作为输出目标（与项目仓库语义一致，位于项目根目录）。
- 交付按 `wiki/system/handshake-protocol.md` 的 `Phase: plan` 约定输出给 Claude 继续执行。

### Rejected
- 拒绝直接修改代码实现：本任务仅为项目说明文档创建，不是功能性改动。
- 拒绝引入外部模板或复杂格式生成流程：当前目标是可读且完整的静态 README，避免额外依赖。
- 拒绝在此阶段添加复杂测试与 CI 流程：README 文档任务不需要新增验证流水线。

### Files
- `__ABS_WORKSPACE_CPB_PATH__/wiki/projects/hello-test/README.md` — 交付文件：项目说明与使用文档。

## Scope

### 目标
创建一个 `README.md` 文件，用于清晰说明 hello-test 项目是什么、如何安装与运行、基本开发约定及当前关键约束。

### 约束
- 仅聚焦任务：**Create a README.md with project description**。
- 遵循现有项目上下文与决策文档，不编造不存在的技术栈与实现细节。
- 输出采用中文或中英混合均可，但结构需清晰、可执行。

## 实现步骤
1. 阅读并整理上下文
   - 使用 `wiki/projects/hello-test/context.md` 中的“概述/技术栈/约束/依赖”补齐 README 主体内容框架。
   - 检查 `wiki/projects/hello-test/decisions.md` 以补充已有决策引用（若无可用条目则记录待确认项）。
2. 草拟 README 结构
   - 制定以下必含章节：项目介绍、快速开始、运行要求与安装、基本使用、目录结构、约束与注意事项、许可（如适用）与贡献指引。
3. 编写 README.md
   - 在 `wiki/projects/hello-test/README.md` 写入完整内容。
   - 对于缺失项（如 `context.md` 留空模板），用明确标记（如“待补充：xx”）避免猜测。
4. 自检内容完整性
   - 逐章核对是否覆盖项目描述的最小闭环：什么项目、目标用户、如何运行、如何开发。
   - 提交给后续 Claude 流程前仅保留一份可执行阅读文档，不引入冗余噪音文本。

## 注意事项
- 避免使用无法验证的信息；若上下文中缺失准确版本号、依赖项或脚本命令，需在 README 中标注 `TODO` 并给出待确认项清单。
- 使用清晰标题层级，避免单段落堆砌式说明。
- 保持描述与项目实际结构一致，宁缺毋滥。

## Next-Action
请按上述 4 步完成 `README.md` 交付，并在交付文件中补齐可验证信息；必要时返回 `inbox/review-xxx.md` 标注待确认项后请 Claude 补充。

## Acceptance-Criteria
- [ ] 已创建 `wiki/projects/hello-test/README.md` 文件，且文件包含项目描述核心章节（项目介绍、安装/运行、使用/开发说明）。
- [ ] 所有章节内容均有对应来源或明确标注待确认，不出现无依据的推断性细节。
- [ ] README 文档对非技术读者可读：从项目定位到运行步骤形成闭环。
- [ ] 与任务标题一致，且无实现代码改动。
