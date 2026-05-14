## Handoff: claude -> codex

- **From**: claude
- **To**: codex
- **Project**: novel-writer
- **Phase**: execute
- **Task-Ref**: plan-002
- **Timestamp**: 2026-05-14T02:30:00+08:00

### Implemented
1. **scene_prose_generator.dart**: system prompt 追加英文对话占比约束（"The prose must include character dialogue accounting for at least 25% of the total text."）；user prompt 新增开篇场景钩子（当 `brief.chapterId == 'chapter-01' && brief.sceneId == 'scene-01'` 时追加中文钩子文案）；user prompt 末尾追加中文对话要求（"正文中角色对话占比不低于25%，用中文引号「」或包裹对白"）。
2. **scene_type_prompts.dart**: `_mysteryDirector` 更新为"必须是一个具体的问题或意外发现，不能只是省略号或氛围暗示"；`_mysteryReview` 增强为可验证版本，新增"悬念钩子是否具体？"和"读者是否会迫切想翻到下一页？钩子的'问题性'和'可追问性'是否足够强？"。
3. **real_novel_quality_benchmark_test.dart**: 全量上调 `targetLength`。章节级统一从 1000/1200 改为 2500（10 处）；场景级统一从 500/400 改为 1000（24 处）。`targetLength: scene.targetLength` 未被动，保持正确。

### Files Changed
- `lib/features/story_generation/data/scene_prose_generator.dart` — system prompt 追加 25% dialogue 英文约束；user prompt 追加开篇钩子判断 + 中文对话要求
- `lib/features/story_generation/data/scene_type_prompts.dart` — `_mysteryDirector` 悬念钩子具体化；`_mysteryReview` 增加"问题性/可追问性"检验要点
- `test/real_novel_quality_benchmark_test.dart` — 34 处 `targetLength` 数值上调（章节 2500、场景 1000）

### Evidence

**测试结果**:
```
$ dart analyze lib/features/story_generation/data/scene_prose_generator.dart lib/features/story_generation/data/scene_type_prompts.dart test/real_novel_quality_benchmark_test.dart
Analyzing scene_prose_generator.dart, scene_type_prompts.dart, real_novel_quality_benchmark_test.dart...
No issues found!
```

**关键代码片段**:

`scene_prose_generator.dart` system prompt:
```dart
'Return the finished scene prose in plain text. '
'The prose must include character dialogue accounting for at least 25% of the total text.',
```

`scene_prose_generator.dart` user prompt 追加:
```dart
if (brief.chapterId == 'chapter-01' && brief.sceneId == 'scene-01')
  '⚠️ 这是全书开篇场景。前50字必须包含一个悬念信号（异常事件、未解之谜、冲突暗示），绝对禁止用纯环境白描开场。',
'对话要求：正文中角色对话占比不低于25%，用中文引号「」或包裹对白。',
```

`scene_type_prompts.dart` `_mysteryDirector`:
```dart
'- 每个场景至少留下一个未解的悬念钩子——必须是一个具体的问题或意外发现，不能只是省略号或氛围暗示';
```

`scene_type_prompts.dart` `_mysteryReview`:
```dart
'- 悬念钩子是否具体？是一个可追问的问题或意外发现，而非仅省略号或氛围暗示？\n'
'- 读者是否会迫切想翻到下一页？钩子的"问题性"和"可追问性"是否足够强？';
```

### Unresolved
- 无

### Risks
- `chapterId`/`sceneId` 使用字符串匹配（`'chapter-01'`/`'scene-01'`）判断开篇场景。若未来 ID 格式变更（如改为数字索引），需要同步更新匹配逻辑。
- benchmark 长度上调后，LLM 调用 token 消耗和测试耗时会显著增加，但计划已确认接受该风险。

## Next-Action
验证实现是否满足 plan-002.md 中的 Acceptance-Criteria，给出 PASS/FAIL 判定。

## Acceptance-Criteria
- [ ] `dart analyze` 对修改的三个文件无新增错误
- [ ] `scene_prose_generator.dart` 的 system prompt 包含 25% 对话占比英文约束
- [ ] `scene_prose_generator.dart` 的 user prompt 在第一章第一场景下包含开篇钩子中文文案
- [ ] `scene_type_prompts.dart` 的悬疑钩子指引文本具体化，不再允许仅省略号/氛围暗示
- [ ] `scene_type_prompts.dart` 的复核问题文本增加"具体性/可追问性"检验要点
- [ ] `test/real_novel_quality_benchmark_test.dart` 中所有 `targetLength` 已按目标调到 2500（章节）和 1000（场景），无遗漏
