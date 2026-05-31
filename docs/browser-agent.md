# Browser Agent

## 1. 什么是 browser-agent

browser-agent 是 CodePatchBay 的通用 Web AI 适配器。它通过 Playwright 浏览器自动化，将任何网页版 AI（如 ChatGPT、DeepSeek、Kimi、豆包、通义千问、Claude.ai、Gemini、Perplexity）视为标准的 ACP Agent 使用。

这不是逆向工程——browser-agent 模拟的是真实用户的交互行为（RPA），在浏览器中像人一样点击、输入、等待响应。通过将 plan 和 verify 等阶段 offload 到免费的网页版 AI，你可以显著降低 Codex API 的调用成本。

browser-agent 的 agent descriptor 声明了 `capabilities: ["plan", "verify", "review"]`，**不推荐用于 execute 阶段**——浏览器自动化太慢，不适合代码执行。

---

## 2. 支持的提供商

| 名称 | 别名 | 级别 | 说明 |
|------|------|------|------|
| `chatgpt` | — | official | ChatGPT Web |
| `deepseek-web` | `deepseek` | official | DeepSeek Web |
| `kimi-web` | `kimi` | best-effort | Kimi |
| `doubao-web` | `doubao` | best-effort | 豆包 |
| `tongyi-web` | `tongyi` | best-effort | 通义千问 |
| `claude-web` | `claude-ai` | experimental | Claude.ai |
| `gemini-web` | `gemini` | experimental | Gemini |
| `perplexity` | — | experimental | Perplexity |
| `mock` | — | official | 本地 Mock 页面，仅用于测试 |

级别含义：
- **official** — 由核心团队维护，selector 定期更新
- **best-effort** — 社区维护，依赖提供商 DOM 稳定性
- **experimental** — 尚未充分验证，可能随时失效

---

## 3. 快速开始

```bash
# 1. 安装 Playwright Chromium
cpb browser install

# 2. 登录某个提供商（以 ChatGPT 为例）
cpb browser login chatgpt
# 浏览器会打开登录页面，你手动完成登录。CPB 会等待 readyCheck，最多 60 秒。

# 3. 测试是否可用
cpb browser test chatgpt

# 4. 全量健康检查
cpb browser doctor
```

---

## 4. 推荐的 CPB 配置

### 个人最高性价比

将 plan 和 verify 交给免费的网页 AI，execute 仍用 Claude Code：

```bash
cpb pipeline my-project "Add feature" \
  --plan-agent browser-agent:chatgpt \
  --execute-agent claude \
  --verify-agent browser-agent:chatgpt
```

### 国内配置

国内用户可以将 plan/verify 分配给国产网页 AI：

```bash
cpb pipeline my-project "Add feature" \
  --plan-agent browser-agent:kimi \
  --verify-agent browser-agent:tongyi \
  --execute-agent claude
```

### API 限流 fallback

当 Codex API 触发限流时，临时切换到浏览器 agent 做 plan：

```bash
cpb plan my-project "Add feature" --plan-agent browser-agent:deepseek
```

---

## 5. 登录流程

### 登录

```bash
cpb browser login <provider>
```

CPB 会启动一个有头（headful）的持久浏览器上下文，存储在：

```
~/.cpb/browser-agents/<provider>/profile-0
```

用户手动完成登录后，CPB 会等待 `auth.readyCheck.selector` 出现，最多等待 60 秒。登录状态会持久保存，后续任务复用同一个 profile，无需重复登录。

### 登出

```bash
cpb browser logout <provider>
```

删除该 provider 的持久 profile 目录。

### 重置

```bash
cpb browser reset <provider>
```

等价于 `logout` + 提示你重新 `login`。

---

## 6. 配置层级

browser-agent 的配置分三层，优先级由低到高：

### Hub 默认

通过 `cpb hub start` 时传入的环境变量或配置文件，影响所有使用 browser-agent 的任务：

```bash
CPB_ACP_BROWSER_AGENT_PROVIDER=deepseek cpb hub start
```

### 项目级

在 `cpb plan` / `cpb execute` / `cpb verify` / `cpb pipeline` 时指定 agent：

```bash
cpb pipeline my-project "Add feature" --plan-agent browser-agent:chatgpt
```

这里的 `:chatgpt` 是 provider 选择器，等价于设置 `CPB_ACP_BROWSER_AGENT_PROVIDER=chatgpt`。

### 任务级

通过 `--plan-agent`、`--execute-agent`、`--verify-agent`、`--review-agent` 等 flag，以及 `--*-variant` 选择具体 provider：

```bash
cpb plan my-project "Add feature" \
  --plan-agent browser-agent \
  --plan-variant kimi
```

环境变量优先级（从高到低）：
1. `CPB_ACP_BROWSER_AGENT_PROVIDER`
2. `CPB_ACP_BROWSER_AGENT_VARIANT`
3. `CPB_ACP_AGENT_VARIANT`
4. 默认值 `chatgpt`

---

## 7. Provider Profile 格式与扩展

### 如何新增一个 provider

1. 创建 JSON 文件：`core/agents/drivers/browser/providers/<name>.json`
2. 运行 `cpb browser test <name>` 验证
3. 提交 PR

### Profile 字段说明

必填字段和类型定义参考 `core/agents/drivers/browser/profile-schema.mjs` 中的 `PROFILE_SCHEMA`：

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | provider 唯一标识 |
| `displayName` | string | 人类可读名称 |
| `aliases` | string[] | 别名，CLI 中可用别名代替 name |
| `support.tier` | string | `official` / `best-effort` / `experimental` |
| `support.requiresManualLogin` | boolean | 是否需要手动登录 |
| `startUrl` | string | 对话起始 URL |
| `auth.loginUrl` | string | 登录页面 URL |
| `auth.loginCheck.selector` | string | 检测到登录按钮/链接的 selector（表示尚未登录） |
| `auth.readyCheck.selector` | string | 检测到输入框的 selector（表示已登录就绪） |
| `input.selector` | string | 输入框 DOM selector |
| `input.kind` | string | `textarea` / `contenteditable` / `selector` |
| `input.method` | string | `fill` / `type` / `paste` |
| `input.clearBeforeInput` | boolean | 输入前是否清空 |
| `input.submit.mode` | string | `button` / `enter` / `mod-enter` |
| `input.submit.selector` | string? | 提交按钮 selector（mode=button 时必填） |
| `response.messageSelector` | string | assistant 消息容器的 selector |
| `response.textSelector` | string? | 提取文本的次级 selector |
| `response.mode` | string | 固定为 `last-message` |
| `response.stableRounds` | number | 文本稳定轮数，默认 3 |
| `response.pollIntervalMs` | number | 轮询间隔，默认 2000 |
| `response.maxWaitMs` | number | 最长等待时间，默认 900000 |
| `response.doneWhen` | array | 结束条件数组：`text-stable`、`selector-hidden`、`selector-visible`、`send-enabled` |
| `continue.enabled` | boolean | 是否支持“继续生成” |
| `continue.selector` | string? | 继续生成按钮的 selector |
| `continue.maxClicks` | number | 最多自动点击次数，默认 5 |
| `diagnostics.screenshotOnFailure` | boolean | 失败时是否截图 |
| `diagnostics.traceOnFailure` | boolean | 失败时是否保存 Playwright trace |

### 验证新 provider

```bash
cpb browser test <name>
```

测试会发送一个固定 prompt，要求 AI 返回特定 JSON。如果返回内容正确，说明 profile 配置无误。

---

## 8. 故障排查

### 登录过期

现象：`cpb browser test <provider>` 提示 `login required`。

解决：

```bash
cpb browser login <provider>
```

### Selector 失效

现象：页面已加载但 CPB 找不到输入框或无法读取回复。

原因：提供商更新了前端 DOM 结构。

解决：
1. 打开对应网站，用 DevTools 检查 selector 是否仍然匹配
2. 修改 `core/agents/drivers/browser/providers/<provider>.json` 中对应的 selector
3. 运行 `cpb browser test <provider>` 验证

### 风控检测

**browser-agent 不实现任何反检测技术。** 如果你遇到以下情况：
- 要求额外验证（CAPTCHA、短信、邮件）
- 账号被临时限制
- 页面弹出“检测到异常活动”

请遵循以下原则：
- 使用 headful 浏览器（不是 headless）
- 保持低频操作，不要批量/高频发送请求
- 仅用于手动登录后的正常对话场景
- 如遇风控，暂停使用，等待一段时间后重试

### 诊断工具

```bash
cpb browser diagnostics <provider>
```

列出该 provider 的历史诊断目录，每个目录包含：
- `failure.json` — 错误信息和当时的页面状态
- `screenshot.png` — 失败时的页面截图

---

## 9. 安全边界与限制

browser-agent 的设计哲学是**透明、合规、低风险**：

- **NO 反检测技术** — 不修改浏览器指纹、不注入脚本绕过检测
- **NO CAPTCHA 绕过** — 遇到人机验证时由用户手动处理
- **NO WebDriver 伪装** — 不隐藏 `navigator.webdriver` 等属性
- **Headful 浏览器 + 手动登录 + 低频使用** — 模拟真实用户行为
- **推荐用于 planner / reviewer / verifier** — 这些角色交互频率低、单次 prompt 大，适合浏览器自动化
- **不推荐用于 executor** — 代码执行需要频繁文件读写和终端交互，浏览器自动化过慢
- **Profile 隔离** — 每个 provider 的登录状态存储在独立的持久上下文目录中，互不干扰

---

## 10. 运维指南

### 诊断文件位置

```
~/.cpb/browser-agents/<provider>/diagnostics/<timestamp>/
├── failure.json    # 错误详情
└── screenshot.png  # 失败截图
```

### Playwright Trace

设置环境变量启用 trace：

```bash
TRACE=1 cpb browser test <provider>
```

trace 文件会保存在诊断目录中，可用 Playwright Trace Viewer 打开分析。

### 日志

ACP adapter (`bridges/browser-agent-acp.mjs`) 会将运行日志输出到 stderr。在 pipeline 模式下，这些日志会进入 CPB 的日志流。

### 并发控制

`BrowserSessionManager` 按 provider 隔离 profile。每个 provider 的并发会话上限由 agent descriptor 中的 `poolLimit` 控制，browser-agent 默认值为 **2**。

如果同时发起超过 pool limit 的任务，后续任务会在 ACP pool 中排队等待。

### 常用 CLI 速查

```bash
cpb browser providers            # 列出所有 provider 及登录状态
cpb browser show <provider>      # 显示某个 provider 的详细配置
cpb browser login <provider>     # 手动登录
cpb browser logout <provider>    # 登出并删除 profile
cpb browser reset <provider>     # 重置 profile
cpb browser test <provider>      # 发送测试 prompt 验证可用性
cpb browser doctor               # 全量健康检查
cpb browser diagnostics <provider> # 查看历史诊断记录
```
