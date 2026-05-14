## Handoff: claude -> codex

- **From**: claude
- **To**: codex
- **Project**: novel-writer
- **Phase**: execute
- **Task-Ref**: plan-002 (fix for verdict-002 PARTIAL)
- **plan-ref**: 002
- **Timestamp**: 2026-05-14T02:50:00+08:00

### Implemented

针对 verdict-002 的 PARTIAL 判定，修复了 `scene_prose_generator.dart` 开篇场景检测逻辑与计划 AC 不一致的问题：

1. **`scene_runtime_models.dart`**: 为 `SceneBrief` 新增 `sceneIndex` 字段（int 类型，默认值为 0），并同步更新 `copyWith`。该字段用于标识场景在章节内的索引位置。
2. **`scene_brief_builder.dart`**: 在 `fromScenePlan` 中通过 `chapterPlan.scenes.indexWhere((s) => s.id == plan.id)` 计算场景索引并写入 `sceneIndex`。
3. **`scene_prose_generator.dart`**: 将开篇场景判断条件从 `brief.sceneId == 'scene-01'` 改为 `brief.chapterId == 'chapter-01' && brief.sceneIndex == 0`，严格对齐计划 AC 的 `brief.chapterId/sceneIndex` 语义。
4. **`test/real_novel_quality_benchmark_test.dart`**: 在构建 `SceneBrief` 时补充 `sceneIndex: chapter.scenes.indexOf(scene)`，确保测试数据与生产路径一致。

plan-002 中已通过验收的其余三项（system prompt 25% 对话约束、scene_type_prompts 悬疑规则增强、targetLength 全量上调）已在 deliverable-002 中完成，本次未做变更。

### Files Changed
- `lib/features/story_generation/data/scene_runtime_models.dart` — 新增 `sceneIndex` 字段及 `copyWith` 支持
- `lib/features/story_generation/data/scene_brief_builder.dart` — `fromScenePlan` 计算并填充 `sceneIndex`
- `lib/features/story_generation/data/scene_prose_generator.dart` — 开篇场景判断改用 `sceneIndex == 0`
- `test/real_novel_quality_benchmark_test.dart` — 补充 `sceneIndex` 参数

### Evidence

**dart analyze 结果**:
```
$ dart analyze lib/features/story_generation/data/scene_runtime_models.dart \
  lib/features/story_generation/data/scene_brief_builder.dart \
  lib/features/story_generation/data/scene_prose_generator.dart \
  test/real_novel_quality_benchmark_test.dart
Analyzing scene_runtime_models.dart, scene_brief_builder.dart, scene_prose_generator.dart, real_novel_quality_benchmark_test.dart...
No issues found!
```

**回归测试**:
```
$ flutter test test/scene_brief_builder_test.dart
00:00 +20: All tests passed!

$ flutter test test/story_generation_orchestrator_test.dart
00:05 +32: All tests passed!

$ flutter test test/scene_context_assembler_test.dart
00:00 +25: All tests passed!

$ flutter test test/chapter_context_bridge_test.dart
00:00 +44: All tests passed!

$ flutter test test/scene_director_prompt_test.dart
00:26 +29: All tests passed!

$ flutter test test/scene_review_coordinator_test.dart
00:04 +35: All tests passed!

$ flutter test test/review_task_test.dart
00:00 +6: All tests passed!
```

**关键代码片段**:

`scene_runtime_models.dart` 新增字段:
```dart
class SceneBrief {
  SceneBrief({
    // ...
    required this.sceneId,
    this.sceneIndex = 0,
    required this.sceneTitle,
    // ...
  });

  final String sceneId;
  final int sceneIndex;
  // ...
}
```

`scene_prose_generator.dart` 开篇判断（已修正）:
```dart
if (brief.chapterId == 'chapter-01' && brief.sceneIndex == 0)
  '⚠️ 这是全书开篇场景。前50字必须包含一个悬念信号（异常事件、未解之谜、冲突暗示），绝对禁止用纯环境白描开场。',
```

`scene_brief_builder.dart` 索引计算:
```dart
final sceneIndex = chapterPlan.scenes.indexWhere((s) => s.id == plan.id);

return SceneBrief(
  // ...
  sceneIndex: sceneIndex >= 0 ? sceneIndex : 0,
  // ...
);
```

### Unresolved
- 无

### Risks
- `sceneIndex` 默认值为 0， legacy/outline 路径（`fromLegacyOutline`）未显式计算索引。若未来需要在 legacy 路径也精确判断开篇场景，需补充索引来源。
- `chapterPlan.scenes` 列表顺序决定了 `sceneIndex` 的语义，若场景列表被重新排序，索引可能错位。

## Next-Action
验证实现是否满足 plan-002.md 中的 Acceptance-Criteria，重点确认 `scene_prose_generator.dart` 的开篇场景判断已严格按 `brief.chapterId/sceneIndex` 实施，给出 PASS/FAIL 判定。

## Acceptance-Criteria
- [ ] `dart analyze` 对修改文件无新增错误
- [ ] `scene_prose_generator.dart` 的 system prompt 包含 25% 对话占比英文约束
- [ ] `scene_prose_generator.dart` 的 user prompt 在第一章第一场景下包含开篇钩子中文文案（由 `brief.chapterId == 'chapter-01' && brief.sceneIndex == 0` 决定）
- [ ] `scene_type_prompts.dart` 的悬疑钩子指引文本具体化，不再允许仅省略号/氛围暗示
- [ ] `scene_type_prompts.dart` 的复核问题文本增加"具体性/可追问性"检验要点
- [ ] `test/real_novel_quality_benchmark_test.dart` 中所有 `targetLength` 已按目标调到 2500（章节）和 1000（场景），无遗漏
- [ ] `SceneBrief` 已定义 `sceneIndex` 字段，`scene_brief_builder` 在生产路径正确填充
