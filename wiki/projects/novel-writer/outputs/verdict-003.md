VERDICT: PASS

目标计划：__ABS_WORKSPACE_CPB_PATH__/wiki/projects/novel-writer/inbox/plan-002.md

验收结果（plan-002 Acceptance-Criteria）：

1) PASS — `dart analyze` 无新增错误。
- 依据：`__ABS_WORKSPACE_CPB_PATH__/wiki/projects/novel-writer/outputs/deliverable-003.md` 记录 `dart analyze` 覆盖 `scene_runtime_models.dart`、`scene_brief_builder.dart`、`scene_prose_generator.dart`、`test/real_novel_quality_benchmark_test.dart` 并返回 `No issues found!`。

2) PASS — system prompt 包含英文 25% 对话约束。
- 依据：`__ABS_WORKSPACE_CPB_PATH__/wiki/projects/novel-writer/outputs/deliverable-002.md` 关键代码片段：
  `The prose must include character dialogue accounting for at least 25% of the total text.`

3) PASS — 第一章第一场景的开篇钩子文案由 `brief.chapterId/brief.sceneIndex` 决定。
- 依据：`__ABS_WORKSPACE_CPB_PATH__/wiki/projects/novel-writer/outputs/deliverable-003.md` 明确将判断改为 `brief.chapterId == 'chapter-01' && brief.sceneIndex == 0`；并提供 `SceneBrief.sceneIndex` 与 `fromScenePlan` 填充逻辑（`indexWhere`）。

4) PASS — `scene_type_prompts.dart` 悬疑钩子指引具体化。
- 依据：`__ABS_WORKSPACE_CPB_PATH__/wiki/projects/novel-writer/outputs/deliverable-002.md` 片段：
  `每个场景至少留下一个未解的悬念钩子——必须是一个具体的问题或意外发现，不能只是省略号或氛围暗示`

5) PASS — `scene_type_prompts.dart` 复核问题增加“具体性/可追问性”。
- 依据：同上文件片段包含：
  `悬念钩子是否具体？...可追问...` 与 `问题性` / `可追问性` 检验项。

6) PASS — `targetLength` 全量上调完成。
- 依据：`__ABS_WORKSPACE_CPB_PATH__/wiki/projects/novel-writer/outputs/deliverable-002.md` 标注章节级共 10 处改为 `2500`，场景级共 24 处改为 `1000`。

补充核查：
- `deliverable-003` 增加了 `SceneBrief.sceneIndex` 字段、`scene_brief_builder` 生产路径填充、及基于该字段的开篇场景判断，修复了 `verdict-002` 中提到的原始偏差。
- `verdict-002` 的问题点在此交付中已针对性修复，无新增未决问题被记录在 `deliverable-003` 的 AC 之外。

结论：`plan-002` 的 Acceptance-Criteria 已满足，输出 `PASS`。
