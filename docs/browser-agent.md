# Browser Agent

## Overview

Browser Agent is a universal adapter that allows CPB to use any web-based AI as a planner, reviewer, or verifier. It uses Playwright to automate browser interactions, making CPB the only multi-agent system that can orchestrate ChatGPT, DeepSeek, Kimi, Claude.ai, Gemini, and more — all through their web interfaces.

## Why Browser Agent?

### Cost arbitrage

When Codex API is rate-limited, automatically fall back to ChatGPT Web (zero cost).

### Model diversity

Use ChatGPT for planning, DeepSeek for verification, Kimi for long-context analysis — all in one pipeline.

### No API keys needed

Web interfaces only require a logged-in browser session.

## Supported Providers

| Provider | Tier | Login Required | Recommended For |
|----------|------|----------------|-----------------|
| ChatGPT | official | Yes | Planning, verification |
| DeepSeek Web | official | Yes | Planning, verification |
| Kimi | best-effort | Yes | Long-context analysis |
| 豆包 | best-effort | Yes | General tasks |
| 通义千问 | best-effort | Yes | General tasks |
| Claude.ai | experimental | Yes | Limited use (strict free tier) |
| Gemini | experimental | Yes | Limited use |
| Perplexity | experimental | Yes | Research queries |

## Quick Start

### 1. Install Playwright

```bash
cpb browser install
```

### 2. Login to a provider

```bash
cpb browser login chatgpt
```

### 3. Test the provider

```bash
cpb browser test chatgpt
```

### 4. Configure CPB to use it

```bash
cpb config --hub --plan-agent browser-agent:chatgpt
cpb config --hub --execute-agent claude
cpb config --hub --verify-agent browser-agent:deepseek
```

### 5. Run a task

```bash
cpb run "Add dark mode" --project my-project
```

## CLI Reference

### `cpb browser providers`

List all providers and their status.

### `cpb browser show <provider>`

Display provider profile details.

### `cpb browser login <provider>`

Open a browser for manual login. Saves persistent profile.

### `cpb browser logout <provider>`

Delete saved profile.

### `cpb browser test <provider>`

Send a test prompt and verify response.

### `cpb browser doctor`

Check installation, browsers, and provider health.

### `cpb browser install`

Install Playwright Chromium browser.

### `cpb browser reset <provider>`

Reset provider profile.

### `cpb browser diagnostics <provider>`

List recent diagnostic records.

## Configuration

### Hub-level (global)

```bash
cpb config --hub --plan-agent browser-agent:chatgpt
cpb config --hub --execute-agent claude
cpb config --hub --verify-agent browser-agent:deepseek
cpb config --hub --review-agent browser-agent:kimi
```

### Project-level

```bash
cpb config my-project --plan-agent browser-agent:deepseek
cpb config my-project --execute-agent claude
cpb config my-project --verify-agent browser-agent:deepseek
```

### Single-task override

```bash
cpb run "Refactor auth" --project my-project \
  --plan-agent browser-agent:chatgpt \
  --execute-agent claude \
  --verify-agent browser-agent:deepseek
```

### Pipeline with phase agents

```bash
cpb pipeline my-project "Add tests" \
  --plan-agent browser-agent:chatgpt \
  --execute-agent claude \
  --verify-agent browser-agent:deepseek \
  --review-agent browser-agent:kimi
```

## Recommended Setups

### Personal best value

```bash
cpb config --hub --plan-agent browser-agent:chatgpt
cpb config --hub --execute-agent claude
cpb config --hub --verify-agent browser-agent:chatgpt
```

### China domestic

```bash
cpb config --hub --plan-agent browser-agent:kimi
cpb config --hub --execute-agent claude
cpb config --hub --verify-agent browser-agent:tongyi-web
```

### API rate-limit fallback

When Codex hits rate limits, browser-agent is the fallback.

## Adding a New Provider

1. Create `core/agents/drivers/browser/providers/<name>.json`
2. Define selectors for login, input, response, continue
3. Test with `cpb browser test <name>`
4. Run `cpb browser doctor` to validate

Provider profile schema:

- `startUrl`: Entry URL
- `auth.loginCheck.selector`: Selector that indicates NOT logged in
- `auth.readyCheck.selector`: Selector that indicates ready for input
- `input.selector`: Prompt input element
- `input.submit`: How to send (button/enter/mod-enter)
- `response.messageSelector`: Container for assistant messages
- `response.doneWhen`: Array of completion conditions
- `continue`: Whether "Continue generating" button exists

## Troubleshooting

### "Login required" error

Run `cpb browser login <provider>` and log in manually.

### Selector errors

Provider may have updated their UI. Check `cpb browser show <provider>` and update the JSON.

### Rate limited

Browser agents have their own rate limits. Wait a few minutes and retry.

### Empty response

Check `~/.cpb/browser-agents/<provider>/diagnostics/` for screenshots.

## Security and Limitations

- Browser Agent does NOT bypass CAPTCHA or login challenges
- Browser Agent does NOT use anti-detection techniques
- Browser Agent uses headful browser with persistent profile
- Browser Agent is for low-frequency, long-duration tasks (15-45 min)
- Browser Agent is NOT recommended for executor role (no filesystem/shell access)
- Browser Agent profiles are stored in `~/.cpb/browser-agents/`

## Architecture

```
CPB pipeline
  -> runAgent({ agent: "browser-agent", variant: "chatgpt" })
    -> AcpPool.execute()
      -> server/services/browser-agent-acp.mjs (ACP server)
        -> Playwright engine
          -> provider profile (chatgpt.json)
            -> ChatGPT Web
```

## Operational Notes

- Diagnostics saved to `~/.cpb/browser-agents/<provider>/diagnostics/`
- Screenshots captured on failure (if enabled in profile)
- Trace files saved when `CPB_ACP_BROWSER_AGENT_TRACE=1`
- Each provider uses isolated persistent profile
- Concurrent sessions per provider are limited by `CPB_ACP_POOL_PROVIDER_MAX`
