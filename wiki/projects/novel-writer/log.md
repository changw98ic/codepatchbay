# novel-writer - Log

> 推进记录。按时间顺序记录所有关键操作。

## 格式

```markdown
- **{ISO 8601}** | {codex|claude} | {阶段} | {操作描述} | {结果}
```

## 记录

（每次 Codex 规划或 Claude 执行后追加）
- **2026-05-14T00:24:08Z** | codex | plan | Created plan-001 for: P0 基础设施修复（4项）：

1. Token usage 记录：修改 test/real_novel_quality_benchmark_test.dart 中的 _TrackingLlmClient，解析 API response 中的 usage 字段（input_tokens/output_tokens），记录到每次调用的日志中。同时在 _BenchmarkSceneResult 中新增 tokenUsage 字段汇总。

2. NarrativeArcTracker 假阴性修复：当前 tracker 不从散文文本中提取情节线数据，导致一致性测试永远返回 0 active/0 closed。需要在 lib/features/story_generation/data/narrative_arc_tracker.dart 中增加从生成文本提取结构化情节线的能力（可以加一个 LLM 后处理步骤或规则解析）。

3. ProseStyleAnalyzer 对话/句型提取 bug：lib/features/story_generation/data/prose_style_analyzer.dart 中 referenceFingerprintFromJsonl 计算参考库指纹时，对话比率和句型分类（陈述/疑问/感叹/省略号）全部为 0.00。检查正则匹配逻辑——参考库文本可能没有引号或标点模式与生成文本不同。确保对中文文本的引号「」和标点。！？…都能正确匹配。

4. MiMo provider 集成：在 lib/app/llm/app_llm_providers.dart 中添加 MiMo provider 定义（baseUrl/apiKeyEnv/modelName），在 _resolveSettings() 中支持 NOVEL_BENCHMARK_USE_MIMO=1 环境变量切换到 MiMo，使用 XIAOMI_BASE_URL/XIAOMI_API_KEY/XIAOMI_MODEL 环境变量。

测试文件：test/real_novel_quality_benchmark_test.dart
核心约束：不改 mock 测试，只做真实集成测试。修改后确保 dart analyze 无错误。 | SUCCESS
- **2026-05-14T00:52:08Z** | claude | execute | deliverable-001 from plan-001 | SUCCESS
- **2026-05-14T02:01:46Z** | codex | plan | Created plan-002 for: P1 生成质量改进（4项）：

5. 开头钩子强化：
   文件：lib/features/story_generation/data/scene_prose_generator.dart
   当前 system prompt（line 29-33）太泛。需要修改：
   - 当场景是第一章第一个场景时（通过 brief 参数判断 chapterId 和 sceneIndex），在 user prompt 中追加：
     「⚠️ 这是全书开篇场景。前50字必须包含一个悬念信号（异常事件、未解之谜、冲突暗示），绝对禁止用纯环境白描开场。」
   - 在 SceneProseGenerator.generate() 的 user prompt 构建中加入这个判断逻辑

6. 章末钩子强化：
   文件：lib/features/story_generation/data/scene_type_prompts.dart
   当前 _mysteryDirector（line 84）只有「每个场景至少留下一个未解的悬念钩子」，太弱。
   修改为：
   '- 每个场景至少留下一个未解的悬念钩子——必须是一个具体的问题或意外发现，不能只是省略号或氛围暗示'
   同时在 _mysteryReview（line 135）修改：
   '- 是否留下了有效的悬念钩子？读者是否会迫切想翻到下一页？' → 增加具体性要求

7. 对话密度提升：
   文件：lib/features/story_generation/data/scene_prose_generator.dart
   在 system prompt（line 29-33）中加入对话约束：
   原文：'Synthesize the director plan and character role-play outputs into polished scene prose. Return the finished scene prose in plain text.'
   修改为：'Synthesize the director plan and character role-play outputs into polished scene prose. At least 25% of the text must be character dialogue (enclosed in Chinese quotes). Return the finished scene prose in plain text.'
   
   同时在 scene_prose_generator.dart 的 user prompt 中追加一行：
   '对话要求：正文中角色对话占比不低于25%，用中文引号「」或包裹对白。'

8. 字数目标提升：
   文件：test/real_novel_quality_benchmark_test.dart
   当前场景 targetLength=500，章节 targetLength=1000。
   搜索所有 targetLength 设置：
   - 章节级 targetLength 从 1000 改为 2500
   - 场景级 targetLength 从 500 改为 1000
   （grep 'targetLength' 确认所有位置）

验收标准：
- dart analyze 无新增错误
- scene_prose_generator.dart 的 system prompt 包含对话占比约束
- scene_type_prompts.dart 的悬疑钩子指引更具体
- benchmark test 中所有 targetLength 都已上调
- 开篇场景有专用的钩子指令（通过 brief.chapterId/sceneIndex 判断） | SUCCESS
- **2026-05-14T02:06:49Z** | claude | execute | deliverable-002 from plan-002 | SUCCESS
- **2026-05-14T02:08:08Z** | codex | verify | deliverable-002 | PARTIAL
- **2026-05-14T02:17:40Z** | claude | execute | deliverable-003 from plan-002 | SUCCESS
- **2026-05-14T02:19:18Z** | codex | verify | deliverable-003 | PASS
- **2026-05-14T02:27:31Z** | codex | plan | Created plan-003 for: P2+P3 效率优化与清理（5项）：

P2#11 GLM 超时熔断：
文件：test/real_novel_quality_benchmark_test.dart
在 _TrackingLlmClient.chat() 中加入熔断逻辑：
- 如果单次调用耗时 >60s 且返回文本 <100 字符，记录 warning 并标记为 soft_failure
- 在 _runSceneWithRetry 中统计 soft_failure 次数，连续 2 次熔断后跳过当前 scene（标记为 skipped）避免浪费 token
- 在 _log 输出中标注 [FUSE] 标记

P3#13 Pipeline 阶段标注：
文件：test/real_novel_quality_benchmark_test.dart
在 _log 函数中增加一个全局 String 变量 _currentStep，在 _runSceneWithRetry 中 orchestrator.runScene() 之前设 _currentStep 为当前 scene id，让 _TrackingLlmClient 的 _log 输出中包含 step 信息。

P3#14 Runtime 实时状态：
文件：test/real_novel_quality_benchmark_test.dart
在每完成一个场景后，将进度写入 artifacts/real_validation/novel_quality_benchmark/runtime/live-status.json，包含 completedScenes/totalScenes/currentChapter/currentScene/lastUpdate 字段。
在测试开始前创建目录。

P3#15 清理 debug _log：
文件：test/real_novel_quality_benchmark_test.dart
将 _log 函数从写入 /tmp/benchmark_debug.log 改为写入 artifacts/real_validation/novel_quality_benchmark/runtime/benchmark.log，这样日志跟产出物在同一目录。同时在日志格式中加入 INFO/WARN/FUSE 级别标记。

P3#16 删除临时测试文件：
用 Bash rm 命令删除 test/real_minimal_debug_test.dart 和 test/real_minimal_debug2_test.dart。

验收标准：
- dart analyze 无新增错误
- _TrackingLlmClient 有超时熔断逻辑
- _log 输出包含 step 和级别信息
- live-status.json 写入逻辑存在
- 临时测试文件已删除 | SUCCESS
