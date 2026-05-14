# P1 生成质量改进（4项）：开头钩子、章末钩子、对话密度、字数目标改造计划

## Phase: plan（codex->claude）

### 目标
完成以下 4 个质量改进并可复核验收：

1. `scene_prose_generator.dart` 开篇场景专用钩子增强（仅第一章第一场景）。
2. `scene_prose_generator.dart` 对话密度约束写入系统提示与用户提示。
3. `scene_type_prompts.dart` 章末/悬念钩子规则增强为可量化、具体问题导向。
4. `real_novel_quality_benchmark_test.dart` 的 `targetLength` 全量上调（章级 2500、场景级 1000）。

### 文件清单（本次计划范围）
- `lib/features/story_generation/data/scene_prose_generator.dart`
- `lib/features/story_generation/data/scene_type_prompts.dart`
- `test/real_novel_quality_benchmark_test.dart`

### 实施步骤（按顺序）
1. 明确既有提示词结构与 `brief` 字段语义（`chapterId`、`sceneIndex` 的计数基线），避免误判开篇场景边界；确认“第一章第一场景”在项目中对齐 1-based 或 0-based。
2. 在 `SceneProseGenerator.generate()` 中：
   - 在 `systemPrompt` 的原文 `"Synthesize the director plan and character role-play outputs into polished scene prose. Return the finished scene prose in plain text."` 后追加英文对话占比约束句。
   - 在 user prompt 生成处新增开篇场景判断逻辑：
     - 当 `brief.chapterId` 与 `brief.sceneIndex` 表示第一章第一场景时，追加固定中文钩子文案：  
       `⚠️ 这是全书开篇场景。前50字必须包含一个悬念信号（异常事件、未解之谜、冲突暗示），绝对禁止用纯环境白描开场。`
     - 无法满足时不追加该段落，保持常规提示。
   - 在 user prompt 末尾追加：
     `对话要求：正文中角色对话占比不低于25%，用中文引号「」或包裹对白。`
3. 在 `lib/features/story_generation/data/scene_type_prompts.dart` 修改悬念规则：
   - 将 `_mysteryDirector` 条目更新为：  
     `每个场景至少留下一个未解的悬念钩子——必须是一个具体的问题或意外发现，不能只是省略号或氛围暗示`
   - 将 `_mysteryReview` 对应条目增强为可验证版本（含“问题性/可追问性”指标），确保与“是否会迫切想翻到下一页”联动，不允许仅给抽象氛围评价。
4. 在 `test/real_novel_quality_benchmark_test.dart` 搜索所有 `targetLength` 设置并统一更新：
   - 章节级目标从 `1000` 改 `2500`。
   - 场景级目标从 `500` 改 `1000`。
   - 遍历并补齐所有命中点，避免漏改。
5. 结果自检与验收：
   - 运行静态检查与最小回归命令，确认无新增编译/类型错误。
   - 复核文本内容包含上述三处新增约束与文案。

### 具体验收标准（与任务一致）
- `dart analyze` 无新增错误。
- `scene_prose_generator.dart` 的 system prompt 包含 25% 对话占比英文约束。
- `scene_prose_generator.dart` 的 user prompt 在第一章第一场景下包含开篇钩子中文文案（由 `brief.chapterId/sceneIndex` 决定）。
- `scene_type_prompts.dart` 的悬疑钩子指引文本具体化，不再允许仅省略号/氛围暗示。
- `scene_type_prompts.dart` 的复核问题文本增加“具体性/可追问性”检验要点。
- `test/real_novel_quality_benchmark_test.dart` 中所有 `targetLength` 已按目标调到 2500（章节）和 1000（场景），无遗漏。

### 风险与确认点
- `chapterId/sceneIndex` 的计数基线若与预期不一致（0-based vs 1-based），会导致开篇钩子误判；需优先对齐现有生成器输入约定后再落地。
- `_mysteryReview` 的表述修改应保持既有 JSON/字符串结构，不引入拼写或符号格式错误。
- 长度上调可能影响性能/测试时长，必要时同步调整 benchmark 阈值与执行预期。

### 产物
- 计划文件：`/Users/chengwen/dev/flow/wiki/projects/novel-writer/inbox/plan-002.md`
