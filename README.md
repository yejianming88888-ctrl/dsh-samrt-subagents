# dsh-samrt-subagents

一个用于 DeepSeek Harness 的智能子 Agent 委派插件：扫描 DSH 模型、配置模型用途、生成路由 Skill，并按单任务或依赖图委派子 Agent。

项目名和仓库名统一为 `dsh-samrt-subagents`，其中 `samrt` 保留现有仓库拼写。

## 实际工作流程

```text
设置 → Smart Subagents → 新建配置
  ↓
扫描 DSH 已注册模型
  ↓
勾选参与委派的模型
  ↓
配置模型用途、推理强度和 Max Token
  ↓
生成并预览 Smart Subagents Skill
  ↓
保存配置并设为全局
  ↓
主 Agent 使用 Skill 制定计划
  ↓
用户确认计划
  ↓
按依赖关系执行，可并行委派
  ↓
回收结果并输出汇总
```

## 使用方法

### 1. 新建配置

打开 DSH 的 **设置 → Smart Subagents**，点击 **+ 新建配置**。插件会扫描当前 DSH 已注册的 LLM 提供方和模型。

模型列表显示提供方和该模型声明的推理档位，例如：

```text
Gemini 3.7 Flash (low, medium, high)
Claude Opus 4.6 Thinking (high)
GPT-5.6 Luna (low, medium, high)
```

列表中的“可用”只表示模型已被 DSH 发现，不代表当前额度、网络或上游接口一定正常。

### 2. 选择参与模型

勾选允许用于子 Agent 委派的模型，点击 **下一步（已选 N 个）**。未勾选模型不会参与当前配置的自动路由。

### 3. 配置模型用途

为每个已选模型填写：

- **Max Token**：单次输出上限；
- **推理强度**：只能选择该模型实际支持的档位；
- **用途备注**：说明该模型适合完成的开发任务。

用途备注必须真实描述模型适合的工作，例如代码开发、架构设计、测试、文档或复杂推理。系统不会仅根据模型名称假设能力。

### 4. 生成 Skill

点击 **根据当前配置生成 Skill**，生成内容包含：

- 启用的模型和提供方；
- 模型用途说明；
- 推理强度和 Token 设置；
- 模型路由提示；
- 计划与任务委派规则。

生成内容可以编辑、复制或下载，也可以点击 **恢复自动** 放弃手工修改。

### 5. 保存和切换配置

点击 **保存配置** 后，配置会保存到 DSH Settings。配置列表支持查看、修改、删除和设为全局默认。

设为全局后，后续会话默认使用该配置。也可以在会话中使用配置切换指令临时选择其他配置，而不改变全局默认配置。

## 委派工具

| 工具 | 用途 |
| --- | --- |
| `smart_subagent_model_catalog` | 扫描 DSH 提供方和已声明模型 |
| `smart_subagent_skill_preview` | 预览当前配置生成的 Skill |
| `smart_subagent_plan` | 为用户目标创建或委派 JSON 计划 |
| `smart_subagent_run_plan` | 按依赖图逐层执行计划并回收结果 |
| `smart_delegate` | 委派一个独立任务 |
| `smart_subagent_status` | 查看当前主 Agent 创建的后台子 Agent |
| `smart_subagent_stop` | 请求停止自己创建的后台子 Agent |
| `smart_subagent_wait` | 等待当前主 Agent 的后台子 Agent 完成 |

## 并发和执行规则

- 默认最大并发数为 **3**；
- 可通过 `maxConcurrentSubagents` 调整；
- 建议上限不超过 **10**；
- 超出并发的任务按 FIFO 排队；
- 不同模型别名可以并行；
- 同一个模型别名同一时间最多执行一个子 Agent；
- `maxDepth` 默认是 `1`，防止子 Agent 无限创建后代。

## 主要配置项

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `mode` | `automatic` | 自动选择启用模型，或使用 `ask` 先询问用户 |
| `planningMode` | `main-agent` | 由主 Agent、规划模型或固定模型制定计划 |
| `requirePlanConfirmation` | `true` | 执行计划前要求用户确认 |
| `maxConcurrentSubagents` | `3` | 直接委派和计划执行共用的并发上限 |
| `maxDepth` | `1` | 子 Agent 最大派生深度 |
| `foregroundTimeoutMs` | `120000` | 前台任务总超时时间 |
| `idleTimeoutMs` | `60000` | 后台无进展结算超时 |
| `enableBackground` | `true` | 是否允许后台可继续执行的子 Agent |
| `showSelectionReason` | `true` | 是否显示模型选择理由 |

系统内部会使用模型的 `alias`、`provider`、`model`、`purpose`、`enabled`、`allowPlanning`、`allowExecution` 和 `maxTokens` 配置；用户不需要填写模型标签。

## 重要限制

1. 模型扫描只能确认模型被 DSH 发现，不能保证当前额度、网络或上游接口可用。
2. 插件不会未经用户确认自动切换模型、跳过任务或改变计划。
3. `idleTimeoutMs` 是无进展结算超时，不是精确的模型活动检测。
4. 后台子 Agent 的生命周期依赖 DSH 的 `subagent/start` 和 `subagent/end` 事件。
5. 插件负责配置、路由建议、计划和委派协议，不替代 DSH 的 Agent 执行能力。
6. 配置命名空间和设置路由保留旧兼容标识，避免已有用户配置失效；项目显示名称和仓库名称已统一为 `dsh-samrt-subagents`。

## 开发和测试

```sh
pnpm install
pnpm test
```

测试覆盖模型扫描、配置读写、Skill 生成、自动/询问模式、单任务委派、依赖图执行、并发排队、超时、后台子 Agent 状态以及设置路由。

## License

MIT
