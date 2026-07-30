# Agent、供应商与模型配置

CPB 把三件事分开：角色选择由 agent 负责，供应商定义放在全局目录，项目只选择本项目要使用的 agent、provider 和 model。

默认角色只选择内置 agent，不绑定具体 provider 或 model。初始化项目时不会写入一组固定的 Codex/Claude 供应商映射。

## 文件位置

默认 CPB 根目录是 `~/.cpb`；设置 `CPB_HOME` 后使用该目录。

```text
~/.cpb/
  providers.json              # 全局供应商目录，不放 API key 本身
  <projectName>/
    project.json              # 项目选择的 agent/provider/model
  projects/<projectName>/     # 项目运行数据和 wiki
```

`CPB_PROVIDERS_FILE` 可以把全局供应商文件改到指定位置。`project.json` 的 canonical 路径仍然是 `<CPB_HOME>/<projectName>/project.json`。

## providers.json

供应商配置只声明环境变量名称和目标协议变量，密钥继续由进程环境、原生登录或外部密钥管理器提供：

```json
{
  "providers": {
    "glm": {
      "agent": "claude",
      "key": "glm",
      "family": "glm",
      "baseUrlEnv": "GLM_BASE_URL",
      "apiKeyEnv": "GLM_API_KEY",
      "modelEnv": "GLM_MODEL"
    },
    "anthropic": {
      "agent": "claude",
      "key": "anthropic",
      "family": "claude",
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "baseUrlEnv": "ANTHROPIC_BASE_URL",
      "modelEnv": "ANTHROPIC_MODEL"
    }
  }
}
```

常用字段：

- `key`：CPB 内部的供应商并发、配额和审计标识；省略时使用目录名。
- `family`：供应商家族，用于配额隔离和故障切换判断；省略时使用目录名。
- `baseUrlEnv`、`apiKeyEnv`、`authTokenEnv`、`modelEnv`：输入环境变量名。
- `baseUrl`、`model`：非敏感的固定值；API key 不应写进 JSON。
- `environment`、`derived`、`values`、`required`、`cli`、`quota`：需要完整控制目标环境、派生变量、命令或配额规则时使用的高级字段。

Anthropic-compatible agent 会自动把 `apiKeyEnv` 同时映射到 `ANTHROPIC_API_KEY` 和 `ANTHROPIC_AUTH_TOKEN`。项目选择的 model 会覆盖 providers.json 中的默认 `model` 或 `modelEnv` 值。

## project.json

最小配置可以直接写一个默认 agent：

```json
{
  "agent": "claude",
  "provider": "glm",
  "model": "glm-5"
}
```

需要按角色分别指定时使用 `agents`：

```json
{
  "agents": {
    "planner": { "agent": "codex" },
    "executor": { "agent": "claude", "provider": "glm", "model": "glm-5" },
    "verifier": { "agent": "codex" }
  }
}
```

`variant` 仍可用于兼容旧的 agent descriptor，但新配置的供应商选择应优先使用 `provider` 和 `model`。项目配置只保存选择关系，不复制 provider token。

配置变更在新任务启动时生效；已经创建的 ACP 连接不会跨 provider 或 model 复用。
