# dsh-smart-subagent-orchestrator

An independent DeepSeek Harness Cordis plugin for model discovery, user-authored model purposes, generated routing guidance, planning, and smart subagent delegation.

## Workflow

1. Scan models advertised by registered DSH LLM providers.
2. Let the user enable routes and describe what each model should do.
3. Generate and hot-register the `smart-subagent-orchestration` Skill.
4. The main agent uses `smart_subagent_plan` to create a plan, optionally via a planner model.
5. `smart_subagent_run_plan` executes the dependency graph layer by layer. Different model aliases may run in parallel, while each alias is limited to one active child at a time.
6. The settings page scans advertised models, lets the user enable routes and write purpose notes, and previews/copies/downloads the generated Skill.
7. `smart_delegate` runs a single task; in automatic mode it picks an enabled model, in ask mode it returns a recommendation and asks the user.

## Implemented tools

| Tool | Purpose |
| --- | --- |
| `smart_subagent_model_catalog` | Scan LLM providers and advertised models. |
| `smart_subagent_plan` | Author or delegate a JSON plan for the user goal. |
| `smart_subagent_run_plan` | Dispatch a plan in parallel and (optionally) join every background child. |
| `smart_delegate` | Send one task to an enabled model route. |
| `smart_subagent_status` | Immediately inspect this parent's background subagent states without waiting. |
| `smart_subagent_stop` | Request cancellation of an owned background subagent. |
| `smart_subagent_wait` | Join every background subagent started by this parent. |

## Implemented settings

Stored under the `smart-subagent-orchestrator` namespace and persisted via the DSH Settings service. The Client UI lives at **Settings → Smart Subagents** and updates live.

| Field | Default | Purpose |
| --- | --- | --- |
| `mode` | `automatic` | `automatic` picks an enabled model; `ask` returns a recommendation and choices. |
| `planningMode` | `main-agent` | `main-agent`, `automatic`, `fixed`, or `ask`. |
| `plannerAlias` | `''` | Required when `planningMode` is `fixed`. |
| `requirePlanConfirmation` | `true` | Confirm plans before dispatch when on. |
| `subagentProvider` | `spawn` | Subagent execution backend, not the LLM provider. |
| `maxDepth` | `1` | Lets the main agent create first-level children while preventing those children from creating descendants. |
| `foregroundTimeoutMs` | `120000` | Total time limit for foreground runs; timed-out runs are disposed. |
| `idleTimeoutMs` | `60000` | Settlement no-progress limit for background children and plan waits. Because DSH does not expose a reliable activity signal, this is not a true activity-idle detector. |
| `maxConcurrentSubagents` | `3` | Plugin-wide FIFO concurrency cap shared by `smart_delegate` and plan execution. Running background children hold a slot until their terminal event or timeout. |
| `enableBackground` | `true` | Use continuable background children. |
| `showSelectionReason` | `true` | Include the routing rationale in tool results. |
| `models[].alias` | required | Stable selector used in tool responses. |
| `models[].provider` | required | Provider route. |
| `models[].model` | required | Exact model id. |
| `models[].displayName` | alias | Friendly label. |
| `models[].purpose` | required | The free-form note describing when to pick this model. |
| `models[].tags` | `[]` | Lowercase kebab-case routing tags. |
| `models[].enabled` | `true` | Participate in routing. |
| `models[].allowPlanning` | `true` | May be picked by the planner. |
| `models[].allowExecution` | `true` | May run execution tasks. |
| `models[].maxTokens` | provider default | Optional output cap. |

## Development

```sh
pnpm install
pnpm test
```

The plugin-wide `maxConcurrentSubagents` gate defaults to three active children. Excess work waits in FIFO order across both direct delegation and plan execution; foreground completion and background terminal events release slots.

The runtime tracker re-implements the `wait-for-subagents` semantics against the DSH `subagent/start` and `subagent/end` events. It isolates children by the parent Agent identity, recovers settlements for missed lifecycle events, and joins every continuable child before returning. `foregroundTimeoutMs` bounds foreground runs and always disposes the run. `idleTimeoutMs` bounds background settlement progress and releases an alias lock when an end event is lost; DSH currently does not expose a reliable activity signal, so it is intentionally a no-progress settlement timeout rather than a fabricated activity-idle detector.

## License

MIT
