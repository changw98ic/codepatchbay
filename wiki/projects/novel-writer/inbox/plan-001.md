# P0 基础设施修复（4项）

## Handshake
From: codex  
To: claude  
Phase: plan  

## 目标范围
仅执行真实集成链路修复与接入，禁止修改 mock 测试。目标文件：  
`test/real_novel_quality_benchmark_test.dart`  
`lib/features/story_generation/data/narrative_arc_tracker.dart`  
`lib/features/story_generation/data/prose_style_analyzer.dart`  
`lib/app/llm/app_llm_providers.dart`  

## 可接受的交付边界
完成后需保证 `dart analyze` 无新增报错；保留现有 mock 单测不变，仅在真实集成测试上下文下验证修复效果。

## 计划与验收（5 步）
1. 建立执行基线与调用链地图：在计划执行前确认以上四个目标文件的现有结构与现有类型定义，确保本次仅触达真实集成路径，不改造测试桩与 mock 分支。验收标准：确认每个目标文件都已记录当前接口、字段、开关与分支点，且不列入任何新增/修改 mock 断言。
2. Token usage 记录修复（真实调用日志增强）：在 `test/real_novel_quality_benchmark_test.dart` 的 `_TrackingLlmClient` 内解析 API response 的 `usage` 对象，提取 `input_tokens` 与 `output_tokens` 并记录到每次调用日志；同步在 `_BenchmarkSceneResult` 增加 `tokenUsage` 累计字段与聚合逻辑。验收标准：每次调用日志包含输入/输出 token，场景结果输出能看到本场景累计值变化，且字段命名与已有风格保持一致，解析失败有回退机制且不影响原有统计逻辑。
3. NarrativeArcTracker 结构化提取修复：在 `lib/features/story_generation/data/narrative_arc_tracker.dart` 补齐散文文本到结构化情节线的抽取能力，方式可为“LLM 后处理 + 规则兜底”或“规则提取 + 可选 LLM 纠偏”，避免仅依赖对话体数据导致始终 0 active/0 closed。验收标准：给定包含剧情推进文本的散文输入，输出不再恒为 0 active/0 closed；同样输入保留幂等性且不误删原有对话体处理分支。
4. ProseStyleAnalyzer 指纹提取修复：修正 `lib/features/story_generation/data/prose_style_analyzer.dart` 的 `referenceFingerprintFromJsonl` 中中文引号与标点识别逻辑（含「」和 `。！？…`），使对话句占比与句型分类（陈述/疑问/感叹/省略号）能在参考库文本中得到有效统计。验收标准：同一份参考文本在无英文引号场景下仍能识别到对话比例与句型比例，生成值不再全部为 0.00；同时不回退到误杀旧有英文/中文句末规则。
5. MiMo Provider 集成与开关：在 `lib/app/llm/app_llm_providers.dart` 新增 MiMo provider 定义（baseUrl/apiKeyEnv/modelName），并在 `_resolveSettings()` 中支持 `NOVEL_BENCHMARK_USE_MIMO=1` 时切换到 MiMo，使用 `XIAOMI_BASE_URL`、`XIAOMI_API_KEY`、`XIAOMI_MODEL`。验收标准：环境变量切换时可成功选择 MiMo 配置，未设置时保持既有默认链路；不存在未定义配置引用；新增 provider 与现有 provider 的解析行为一致。

## 交付后核验清单（执行阶段）
完成上述 4 项后，需跑真实集成测试与静态分析，确认：
1. `test/real_novel_quality_benchmark_test.dart` 的核心断言在真实环境下可观测到 token 与情节线/风格数据修复效果。
2. 无新增 mock 测试改动，单测结构保持原样。
3. `dart analyze` 报告通过或仅留存与变更无关的既有问题。
