# novel-writer - Context

> 项目说明书。描述项目是什么、用什么技术栈、有哪些约束。

## 概述

（由 `flow init` 生成时自动填充项目基本信息）

## 技术栈

（初始化时从项目 package.json / 配置文件自动检测）

## 目录结构

（初始化时从项目文件树自动生成摘要）

## 约束

- 绝对禁止 mock 测试和 mock 数据，只做真实集成测试
- `dart analyze` 必须通过，无新增错误
- 所有 AI 生成的散文文本禁止包含「心中一凛」等 AI 陈词（黑名单维护在 `AiClicheDetector`）
- Flow pipeline 的 Codex verify 阶段已知会卡住（DEC-001），执行后由人工 dart analyze + grep 验证替代

## 已知问题（Flow 框架）

- **Codex ACP verify 卡死**: `codex-acp` 在 verify 阶段两次出现无响应，lease 过期后进程仍存活（PID 43501, 33min elapsed），必须手动 kill。推测是 `codex-acp` 空闲超时处理不当或 JSON-RPC 响应丢失。建议在 `run-pipeline.sh` 中加 verify 阶段超时熔断（如 10min timeout）。

## 外部依赖

- （关键依赖及版本要求）

- **Detected**: Flutter
