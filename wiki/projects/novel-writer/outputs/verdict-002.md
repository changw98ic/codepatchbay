VERDICT: PARTIAL

Evidence-based verification against plan-002 Acceptance-Criteria:

1) PASS: `scene_prose_generator.dart` 的系统提示包含 25% 对话占比英文约束。
- Evidence: `/Users/chengwen/dev/novel-wirter/lib/features/story_generation/data/scene_prose_generator.dart:34` 包含
  `The prose must include character dialogue accounting for at least 25% of the total text.`

2) PARTIAL: `scene_prose_generator.dart` 的开篇钩子在第一章第一场景下追加。
- Evidence: `/Users/chengwen/dev/novel-wirter/lib/features/story_generation/data/scene_prose_generator.dart:50` 包含
  `brief.chapterId == 'chapter-01' && brief.sceneId == 'scene-01'` 条件分支，且追加中文钩子文案。
- Deviation: 计划 AC 指向 `brief.chapterId/sceneIndex`；当前仅有 `sceneId` 字段，不使用 `sceneIndex`。
- Note: 项目模型 `SceneBrief`（`scene_runtime_models.dart`）确实未定义 `sceneIndex`，但 AC 表述未完全一致。

3) PASS: `scene_type_prompts.dart` 的悬疑指引文本具体化。
- Evidence: `/Users/chengwen/dev/novel-wirter/lib/features/story_generation/data/scene_type_prompts.dart:84` 指引改为
  `必须是一个具体的问题或意外发现，不能只是省略号或氛围暗示`。

4) PASS: `scene_type_prompts.dart` 复核问题增加“具体性/可追问性”。
- Evidence: `/Users/chengwen/dev/novel-wirter/lib/features/story_generation/data/scene_type_prompts.dart:135-136` 新增可追问性问题项。

5) PASS: `test/real_novel_quality_benchmark_test.dart` 的 `targetLength` 覆盖数值为 2500 与 1000（外加 1 处 `scene.targetLength`）。
- Evidence: `grep` 统计（排除 `scene.targetLength`）仅见 `2500` 和 `1000`。
- Evidence lines: `.../real_novel_quality_benchmark_test.dart:297,368,430,501,571,653,727,788,870,931` 为 `2500`。
- Evidence lines: `...:302,332,373,403,...,957` 等为 `1000`。

6) PASS (by deliverable evidence only): 未新增静态检查错误。
- Evidence: 交付件 `deliverable-002.md` 记录命令 `dart analyze ...` 返回 `No issues found!`。
- No local `/outputs/test-report-002.md` artifact found, so this is based on handoff evidence.

Conclusion: 验收存在一项偏离（字段名/条件表达与计划 AC 文本不一致）。功能意图基本达成，但未严格按 AC 原文 `sceneIndex` 实施，故输出 `PARTIAL`。
