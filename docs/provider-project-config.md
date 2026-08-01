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
  "validationProfile": "standard",
  "agents": {
    "planner": { "agent": "codex" },
    "executor": { "agent": "claude", "provider": "glm", "model": "glm-5" },
    "verifier": { "agent": "codex" }
  }
}
```

`variant` 只在 agent 自身有多个实现时选择该实现；供应商与模型始终使用 `provider` 和 `model`。项目配置只保存选择关系，不复制 provider token。

### 验证档位

`validationProfile` 是 `project.json` 的顶层字段，只能为 `smoke`、`standard` 或
`verified`。SWE-bench 批处理会在入队时把这个值冻结到作业的
`sourceContext.productValidation`、批次清单和报告中；运行中的作业不会被后来改动的项目配置影响。
没有指定时，SWE-bench 保守地使用 `verified`。

- `smoke`：清单和计划合并为一次规划调用；验证者为每项变更运行最小的直接仓库检查；不加入独立对抗复核。
- `standard`：同样合并清单和计划；验证者覆盖变更行为及其相关回归路径；不加入独立对抗复核，也不会为该未执行阶段启动供应商预检。
- `verified`：清单与计划分开，执行严格的独立验证和对抗复核；适合需要发布级证据的任务。

无论档位如何，CPB 都会保留冻结的验收清单、范围检查、候选改动身份校验和失败即停止的验证门。档位只改变规划是否合并及验证深度，不会把失败结果改为通过。

配置变更在新任务启动时生效；已经创建的 ACP 连接不会跨 provider 或 model 复用。

## SWE-bench 批处理

SWE-bench 运行器不再接受 `--agent`、`--planner-agent`、`--executor-agent`、
`--verifier-agent` 或 `--adversarial-agent`。真实运行必须传入一个
`--project-config <path>`；该文件作为模板写入每个生成项目的 canonical
`<CPB_HOME>/<projectName>/project.json`，随后由正常队列配置解析流程生成作业。

```bash
CPB_PROVIDERS_FILE="$HOME/.cpb/providers.json" \
node dist/scripts/queue-swebench-batch.js \
  --project-config ./swebench-project.json \
  --count 5
```

批处理清单中的 agent/provider/model 只是所用项目配置的审计副本，不能覆盖
`project.json`。缺少项目配置、引用未知 provider，或继续使用已删除的 agent
参数时，运行会在克隆仓库和创建作业之前失败。
