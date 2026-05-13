# fatecat - Context

> 项目说明书。描述项目是什么、用什么技术栈、有哪些约束。

## 概述

FateCat（命猫）是一个 iOS SwiftUI MVP：用户输入多个选项，让“命猫”通过随机转盘帮用户做轻量决策。MVP 目标是验证“有猫陪你做选择”的基本体验，而不是做留存游戏或商业化系统。

P0 / MVP 必须聚焦：
- 自定义选项、默认决策模板、随机结果、重新转一次。
- 小猫待机、点击反馈、转盘开始、转盘结束、结果反应。
- 结果页文字、小猫一句反馈、再来一次、返回编辑。
- 本地保存最近选项和基础设置，离线可用。

P0 明确不做：
- 金币、供奉、碎片、广告、IAP、账号、后端、云同步。
- 神陨/重生、原初神格、图鉴、复杂养成、每日签到压力。
- 完整上架合规材料和商业化埋点。

首版验收：
- 用户不看说明也能在 30 秒内完成一次随机决策。
- 小猫动画在关键动作上有反馈，不只是静态贴图。
- 结果页清楚、轻快，不让用户觉得在等广告或系统结算。

## 技术栈

- iOS app: SwiftUI under `FateCatIOS/FateCat`.
- State/model: `FateCatStore`, `FateModels`.
- Tests: XCTest in `FateCatIOS/FateCatTests`.
- Package tools: npm scripts for Lottie generation via `@afromero/kin3o`.
- Optional animation runtime: Lottie is guarded by `#if canImport(Lottie)` and falls back to bundled image/SVG-like SwiftUI drawing when unavailable.

## 目录结构

- `FateCatIOS/FateCat/FateCatApp.swift`: SwiftUI app entry.
- `FateCatIOS/FateCat/Core/FateModels.swift`: phase enums, animation mapping, templates.
- `FateCatIOS/FateCat/Core/FateCatStore.swift`: decision flow state, option normalization, result picking.
- `FateCatIOS/FateCat/Views/FateCatHomeView.swift`: main screen, stage switching, spin/button animation timing.
- `FateCatIOS/FateCat/Views/OptionEditorView.swift`: option input and template picker.
- `FateCatIOS/FateCat/Views/FateWheelView.swift`: wheel rendering, labels, center cat, result highlight.
- `FateCatIOS/FateCat/Views/CatStageView.swift`: idle/button cat stage fallback.
- `FateCatIOS/FateCat/Views/LottieCatAnimationView.swift`: optional Lottie bridge with fallback.
- `FateCatIOS/FateCat/Views/SettingsView.swift`: sound/haptics toggles.
- `FateCatIOS/FateCat/Resources/Lottie`: bundled/generated Lottie JSON resources.
- `prd-html/sections`: exported PRD sections, especially `00-multi-stage-plan.html`, `appendix-a-mvp-sprints.html`, and `appendix-b-mvp-trimming.html`.

## 约束

- Keep MVP light: no monetization, account system, cloud sync, economy, or heavy retention mechanics.
- Preserve existing SwiftUI structure and small-file boundaries.
- Prefer focused changes with tests around `FateCatStore` for behavior.
- Do not modify fake/mock tests or generated fixtures merely to make tests pass.
- Keep UI polished and directly usable as an app first screen, not a landing page.
- Existing git worktree is uncommitted; avoid reverting user/generated files.

## 外部依赖

- **Package**: fatecat-tools
- npm dev dependency: `@afromero/kin3o` for animation generation.
- Claude/Codex collaboration is mediated by Flow ACP from `/Users/chengwen/dev/flow`.

## Current MVP State

Already present:
- Basic SwiftUI app entry and home view.
- Option editor with templates: food, buy, place, action.
- Store flow: idle -> editing/options -> pressingButton -> spinning -> result.
- Option normalization removes blank and duplicate values.
- Random result picker is injectable for tests.
- Reroll, edit options, and reuse recent options exist in memory.
- Basic settings toggles exist, but they are not persisted.
- Lottie phase mapping exists, with fallback rendering when Lottie is unavailable.
- Store unit tests cover option filtering, rejection, spin result, recent reuse, and animation resource mapping.

Likely next MVP work:
- Persist recent options and settings locally.
- Strengthen result copy / cat reaction variety.
- Verify build/test in Xcode or SwiftPM as available.
- Add tests for persistence and any new decision-flow behavior.
