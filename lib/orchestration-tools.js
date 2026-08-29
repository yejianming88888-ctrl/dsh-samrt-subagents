import { defineTool } from '@deepseek-ai/dsh-tools'
import { recommendModel } from './model-router.js'
import { buildRequest, classifyFailure, createConcurrencyGate, startBackground, runForeground } from './subagent-runner.js'
import { normalizePlanSteps, planSummary } from './orchestrator.js'

let globalTracker

function choosePlanner(settings) {
  const role = 'planning'
  if (settings.planningMode === 'fixed' && settings.plannerAlias !== '') {
    const fixed = settings.models.find((model) => model.enabled && model.alias === settings.plannerAlias && model.allowPlanning)
    if (fixed === undefined) throw new Error(`planner alias "${settings.plannerAlias}" is not enabled or not allowed for planning`)
    return { model: fixed, mode: 'fixed', reason: 'Fixed planner selected by the user.' }
  }
  if (settings.planningMode === 'ask') return { mode: 'ask' }
  if (settings.planningMode === 'main-agent') return { mode: 'main-agent' }
  const planner = recommendModel(settings.models, 'Plan the work in detail and choose steps.', role)
  return { model: planner.model, mode: 'automatic', reason: planner.reason }
}

// Layer-by-layer execution. Each layer waits for the previous layer's children to
// settle before starting the next one. Within a single layer, steps run in parallel,
// but every step that picks the same model alias is serialized: a second step that
// targets an alias that already has an in-flight run must wait for that run's
// settlement before it can start. Different aliases continue to run in parallel.
//
// Foreground mode also respects the per-alias serialization.
async function executeLayers({ ctx, settings, plan, exec, mode, concurrency, tracker: providedTracker, selections, dispatched }) {
  const state = { dispatched: [], settlements: [], completedForeground: [], awaiting: undefined, aliasInFlight: new Set(), aliasWaiters: new Map(), childDone: new Map(), childTimers: new Map(), earlyEnds: new Map(), aliasByChild: new Map(), endedChildren: new Set(), interruptResults: new Map(), stepResults: new Map() }
  if (Array.isArray(dispatched)) {
    for (const entry of dispatched) {
      if (entry && typeof entry === 'object') {
        const stepIndex = entry.stepIndex
        if (entry.childId) {
          state.dispatched.push(entry)
          state.aliasByChild.set(entry.childId, entry.model)
          state.stepResults.set(stepIndex, { stepIndex, title: plan.steps[stepIndex].title, status: entry.status ?? 'started', childId: entry.childId, model: entry.model })
        } else if (entry.status === 'completed') {
          state.completedForeground.push(entry)
          state.stepResults.set(stepIndex, { stepIndex, title: plan.steps[stepIndex].title, status: 'completed', model: entry.model, runId: entry.runId, output: entry.output })
        } else if (entry.status) {
          state.stepResults.set(stepIndex, { stepIndex, title: plan.steps[stepIndex].title, status: entry.status, model: entry.model, error: entry.error })
        }
      }
    }
  }
  const tracker = exec.tracker ?? providedTracker ?? globalTracker
  const requestInterrupt = (childId) => {
    if (state.interruptResults.has(childId)) return state.interruptResults.get(childId)
    let diagnostic
    if (typeof ctx.subagents?.interrupt !== 'function') diagnostic = { status: 'unavailable', diagnostic: 'subagent interrupt API is unavailable; child may still be running' }
    else {
      try {
        const result = ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: exec.agent })
        if (result && typeof result.then === 'function') result.catch(() => {})
        diagnostic = { status: 'requested' }
      } catch (error) {
        diagnostic = { status: 'failed', diagnostic: `subagent interrupt failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
    state.interruptResults.set(childId, diagnostic)
    return diagnostic
  }
  state.requestInterrupt = requestInterrupt
  const releaseAlias = (alias) => {
    if (!state.aliasInFlight.delete(alias)) return
    const list = state.aliasWaiters.get(alias)
    if (list !== undefined) {
      while (list.length > 0) {
        const next = list.shift()
        if (list.length === 0) state.aliasWaiters.delete(alias)
        if (next.status === 'queued') {
          next.status = 'resolved'
          state.aliasInFlight.add(alias)
          next.resolve()
          break
        }
      }
    }
  }
  const onEnd = (info) => {
    if (state.endedChildren.has(info.id)) return
    concurrency?.end?.(info.id)
    const alias = state.aliasByChild.get(info.id)
    if (alias === undefined) { state.earlyEnds.set(info.id, info); return }
    state.aliasByChild.delete(info.id)
    state.endedChildren.add(info.id)
    releaseAlias(alias)
    const timer = state.childTimers.get(info.id)
    if (timer !== undefined) clearTimeout(timer)
    state.childTimers.delete(info.id)
    state.childDone.get(info.id)?.(info)
    state.childDone.delete(info.id)
  }
  const disposeEnd = ctx.on('subagent/end', onEnd)
  try {
    for (let layerIndex = 0; layerIndex < plan.layers.length; layerIndex += 1) {
      const stepIndexes = plan.layers[layerIndex].slice()
      if (mode === 'ask') {
        let encounteredAwaiting = false
        for (const index of stepIndexes) {
          await dispatchStep({ step: plan.steps[index], index, state, settings, ctx, exec, mode, tracker, concurrency, releaseAlias, selections })
          if (state.awaiting !== undefined) {
            encounteredAwaiting = true
            break
          }
        }
        if (encounteredAwaiting) {
          break
        }
      } else {
        const before = state.settlements.length
        await Promise.all(stepIndexes.map((index) => dispatchStep({ step: plan.steps[index], index, state, settings, ctx, exec, mode, tracker, concurrency, releaseAlias, selections })))
        if (layerIndex < plan.layers.length - 1) await Promise.all(state.settlements.slice(before))
      }
    }
  } finally {
    if (typeof disposeEnd === 'function') disposeEnd()
    for (const timer of state.childTimers.values()) clearTimeout(timer)
    state.childTimers.clear()
    state.childDone.clear()
    state.aliasByChild.clear()
    state.aliasInFlight.clear()
    const cancellation = new Error('orchestration was cancelled')
    for (const waiters of state.aliasWaiters.values()) {
      for (const waiter of waiters.splice(0)) waiter.reject(cancellation)
    }
    state.aliasWaiters.clear()
    state.earlyEnds.clear()
    state.endedChildren.clear()
    state.interruptResults.clear()
  }
  return state
}

async function dispatchStep({ step, index, state, settings, ctx, exec, mode, tracker, concurrency, releaseAlias, selections }) {
  if (state.stepResults.has(index)) {
    const existing = state.stepResults.get(index)
    if (existing.status !== 'started') {
      return
    }
    const childId = existing.childId
    const alias = existing.model
    state.aliasInFlight.add(alias)
    state.aliasByChild.set(childId, alias)
    let done
    const settled = new Promise((resolve) => { done = resolve })
    state.childDone.set(childId, (info) => {
      let status = 'failed'
      if (info.stopReason === 'completed') status = 'completed'
      else if (info.stopReason === 'aborted' || info.stopReason === 'interrupted') status = 'cancelled'
      else if (info.stopReason === 'timeout') status = 'timeout'
      state.stepResults.set(index, {
        stepIndex: index,
        title: step.title,
        status,
        model: alias,
        childId,
        stopReason: info.stopReason,
        ...(info.failureType === undefined ? {} : { failureType: info.failureType }),
        ...(info.error === undefined ? {} : { error: info.error })
      })
      done(info)
    })
    const timer = setTimeout(() => {
      if (!state.aliasByChild.has(childId)) return
      const interrupt = state.requestInterrupt(childId)
      state.endedChildren.add(childId)
      concurrency.end(childId)
      state.aliasByChild.delete(childId)
      state.childTimers.delete(childId)
      releaseAlias(alias)
      const callback = state.childDone.get(childId)
      state.childDone.delete(childId)
      callback?.({ stopReason: 'timeout', failureType: 'timeout', lastAssistantMessage: [], interrupt, ...(interrupt.status === 'unavailable' || interrupt.status === 'failed' ? { error: interrupt.diagnostic, errorMessage: interrupt.diagnostic } : {}) })
    }, settings.idleTimeoutMs)
    state.childTimers.set(childId, timer)
    const earlyEnd = state.earlyEnds.get(childId)
    if (earlyEnd !== undefined) {
      state.earlyEnds.delete(childId)
      clearTimeout(timer)
      state.childTimers.delete(childId)
      state.aliasByChild.delete(childId)
      state.endedChildren.add(childId)
      releaseAlias(alias)
      const callback = state.childDone.get(childId)
      state.childDone.delete(childId)
      callback?.(earlyEnd)
    }
    state.settlements.push(settled)
    return
  }

  const recommendation = recommendModel(settings.models, `${step.title}\n${step.summary}\n${step.prompt}`, 'execution')
  let targetModel = recommendation.model
  let reason = recommendation.reason
  if (selections && selections[step.title]) {
    const alias = selections[step.title]
    const matched = settings.models.find((model) => model.enabled && model.alias === alias)
    if (matched === undefined) throw new Error(`model alias "${alias}" for step "${step.title}" is not enabled or does not exist`)
    targetModel = matched
    reason = 'The caller explicitly selected this model.'
  } else if (mode === 'ask') {
    state.awaiting = { stepIndex: index, status: 'awaiting-choice', recommendation: recommendation.model.alias, reason: recommendation.reason, choices: enabledAliases(settings) }
    return
  }

  const blockedBy = step.dependsOn.filter((depIndex) => {
    const depResult = state.stepResults.get(depIndex)
    return !depResult || depResult.status !== 'completed'
  })
  if (blockedBy.length > 0) {
    state.stepResults.set(index, {
      stepIndex: index,
      title: step.title,
      status: 'skipped',
      blockedBy: blockedBy.sort((a, b) => a - b),
      reason: 'dependency-not-completed'
    })
    return
  }
  const stepSignal = exec.stepSignals?.[step.title] ?? exec.signal
  let acquired = false
  let releaseConcurrency
  try {
    releaseConcurrency = await concurrency.acquire(stepSignal)
    await waitForAliasSlot(state, targetModel.alias, stepSignal)
    acquired = true
    if (stepSignal?.aborted === true) {
      throw stepSignal.reason instanceof Error ? stepSignal.reason : new Error('orchestration was cancelled')
    }
    const label = `${index + 1}:${step.title}`
    const request = buildRequest(exec.agent, stepSignal, targetModel, label, step.prompt, settings.maxDepth)
    if (!settings.enableBackground) {
      try {
        const result = await runForeground(ctx.subagents, settings.subagentProvider, request, targetModel.alias, { timeoutMs: settings.foregroundTimeoutMs })
        state.stepResults.set(index, { stepIndex: index, title: step.title, status: 'completed', model: targetModel.alias, runId: result.runId, output: result.output })
        state.completedForeground.push({ stepIndex: index, status: 'completed', model: targetModel.alias, runId: result.runId, output: result.output })
      } catch (error) {
        let status = 'failed'
        const code = error && (error.code || error.stopReason)
        if (code === 'timeout') {
          status = 'timeout'
        } else if (code === 'aborted' || code === 'interrupted') {
          status = 'cancelled'
        } else if (code === 'cleanup-failed') {
          // Run actually completed but disposal failed; keep the success
          // marker for the user-visible status but surface the cleanup error.
          status = 'completed'
        }
        const errorMessage = error instanceof Error ? error.message : String(error)
        const failureType = error?.failureType ?? classifyFailure(code ?? 'error', errorMessage)
        if (status === 'completed') {
          state.stepResults.set(index, { stepIndex: index, title: step.title, status: 'completed', model: targetModel.alias, runId: error?.runId, failureType, error: errorMessage })
        } else {
          state.stepResults.set(index, { stepIndex: index, title: step.title, status, model: targetModel.alias, failureType, error: errorMessage })
        }
        state.completedForeground.push({ stepIndex: index, status, model: targetModel.alias, failureType, error: errorMessage })
        state.completedForeground.push({ stepIndex: index, title: step.title, status, model: targetModel.alias, failureType, error: errorMessage })
      } finally {
        releaseAlias(targetModel.alias)
        releaseConcurrency?.()
        releaseConcurrency = undefined
        acquired = false
      }
      return
    }

    // Bracket the start so smart_subagent_wait cannot observe an empty child set
    // while this step is between "no child yet" and "child tracked".
    const startState = tracker?.begin(exec.agent)
    let child
    try {
      child = await startBackground(ctx.subagents, settings.subagentProvider, request, targetModel.alias)
    } catch (error) {
      if (startState !== undefined) tracker.finish(exec.agent, startState)
      throw error
    }
    concurrency.track(child.subagentId, releaseConcurrency, settings.idleTimeoutMs, (childId) => state.requestInterrupt(childId))
    releaseConcurrency = undefined
    if (tracker !== undefined) {
      tracker.track(exec.agent, child.subagentId, label)
      tracker.finish(exec.agent, startState)
    }
    state.stepResults.set(index, {
      stepIndex: index,
      title: step.title,
      status: 'started',
      model: targetModel.alias,
      childId: child.subagentId
    })
    let done
    const settled = new Promise((resolve) => { done = resolve })
    state.childDone.set(child.subagentId, (info) => {
      let status = 'failed'
      if (info.stopReason === 'completed') status = 'completed'
      else if (info.stopReason === 'aborted' || info.stopReason === 'interrupted') status = 'cancelled'
      else if (info.stopReason === 'timeout') status = 'timeout'
      state.stepResults.set(index, {
        stepIndex: index,
        title: step.title,
        status,
        model: targetModel.alias,
        childId: child.subagentId,
        stopReason: info.stopReason,
        ...(info.failureType === undefined ? {} : { failureType: info.failureType }),
        ...(info.error === undefined ? {} : { error: info.error })
      })
      done(info)
    })
    state.aliasByChild.set(child.subagentId, targetModel.alias)
    const timer = setTimeout(() => {
      if (!state.aliasByChild.has(child.subagentId)) return
      const interrupt = state.requestInterrupt(child.subagentId)
      state.endedChildren.add(child.subagentId)
      concurrency.end(child.subagentId)
      state.aliasByChild.delete(child.subagentId)
      state.childTimers.delete(child.subagentId)
      releaseAlias(targetModel.alias)
      const callback = state.childDone.get(child.subagentId)
      state.childDone.delete(child.subagentId)
      callback?.({ stopReason: 'timeout', failureType: 'timeout', lastAssistantMessage: [], interrupt, ...(interrupt.status === 'unavailable' || interrupt.status === 'failed' ? { error: interrupt.diagnostic, errorMessage: interrupt.diagnostic } : {}) })
    }, settings.idleTimeoutMs)
    state.childTimers.set(child.subagentId, timer)
    const earlyEnd = state.earlyEnds.get(child.subagentId)
    if (earlyEnd !== undefined) {
      state.earlyEnds.delete(child.subagentId)
      clearTimeout(timer)
      state.childTimers.delete(child.subagentId)
      state.aliasByChild.delete(child.subagentId)
      state.endedChildren.add(child.subagentId)
      releaseAlias(targetModel.alias)
      const callback = state.childDone.get(child.subagentId)
      state.childDone.delete(child.subagentId)
      callback?.(earlyEnd)
    }
    state.dispatched.push({ stepIndex: index, status: 'started', model: targetModel.alias, reason, childId: child.subagentId, settlement: undefined })
    state.settlements.push(settled)
  } catch (error) {
    releaseConcurrency?.()
    if (acquired) {
      releaseAlias(targetModel.alias)
    }
    let status = 'failed'
    if (stepSignal?.aborted === true || error?.message === 'orchestration was cancelled' || error?.message?.includes('cancelled')) {
      status = 'cancelled'
    }
    const errorMessage = error instanceof Error ? error.message : String(error)
    const failureType = error?.failureType ?? classifyFailure(error?.code ?? error?.stopReason ?? 'error', errorMessage)
    state.stepResults.set(index, { stepIndex: index, title: step.title, status, model: targetModel.alias, failureType, error: errorMessage })
  }
}

function waitForAliasSlot(state, alias, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('orchestration was cancelled'))
  if (!state.aliasInFlight.has(alias)) {
    state.aliasInFlight.add(alias)
    return Promise.resolve()
  }
  let resolveWaiter
  let rejectWaiter
  const waiter = new Promise((resolve, reject) => { resolveWaiter = resolve; rejectWaiter = reject })
  const entry = { resolve: resolveWaiter, reject: rejectWaiter, status: 'queued' }
  const list = state.aliasWaiters.get(alias) ?? []
  list.push(entry)
  state.aliasWaiters.set(alias, list)
  let onAbort
  return (async () => {
    try {
      if (!signal) await waiter
      else {
        await Promise.race([
          waiter,
          new Promise((_, reject) => {
            onAbort = () => {
              entry.status = 'rejected'
              reject(signal.reason instanceof Error ? signal.reason : new Error('orchestration was cancelled'))
            }
            signal.addEventListener('abort', onAbort, { once: true })
          })
        ])
      }
    } finally {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort)
      const current = state.aliasWaiters.get(alias) ?? []
      const index = current.findIndex((e) => e.resolve === resolveWaiter)
      if (index >= 0) current.splice(index, 1)
      if (current.length === 0) state.aliasWaiters.delete(alias)
    }
  })()
}

function buildPlanTools(ctx, settingsSource, concurrencySource, trackerForPlugin) {
  const staticSettings = typeof settingsSource === 'function' ? undefined : settingsSource
  const fallbackConcurrency = concurrencySource ?? createConcurrencyGate(staticSettings?.maxConcurrentSubagents ?? 3)
  const runtimeFor = (exec) => {
    const resolved = typeof settingsSource === 'function' ? settingsSource(exec.agent) : { settings: settingsSource }
    const settings = resolved?.settings ?? resolved
    const concurrency = resolved?.concurrency ?? (typeof concurrencySource === 'function' ? concurrencySource(exec.agent, settings) : fallbackConcurrency)
    return { settings, concurrency }
  }
  return [
    defineTool({
      name: 'smart_subagent_stop',
      description: 'Request cancellation of a background child started by this parent. Returns immediately after the interrupt request is accepted.',
      parameters: { subagentId: { type: 'string', required: true, description: 'The tracked background subagent id.' } },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      isConcurrencySafe: () => true,
      execute(args, exec) {
        if (exec.agent === undefined) throw new Error('smart_subagent_stop requires a calling agent')
        if (ctx.subagents.interrupt === undefined) throw new Error('subagent interrupt is unavailable')
        const tracker = exec.tracker ?? trackerForPlugin ?? globalTracker
        const owned = tracker?.snapshot(exec.agent).some((item) => item.subagentId === args.subagentId)
        if (!owned) throw new Error(`unknown subagent "${args.subagentId}" for this parent`)
        ctx.subagents.interrupt(args.subagentId, { kind: 'ancestor', agent: exec.agent })
        const requestedAt = tracker?.requestStop?.(exec.agent, args.subagentId) ?? new Date().toISOString()
        return Promise.resolve({ status: 'interrupt-requested', subagentId: args.subagentId, requestedAt })
      },
    }),
    defineTool({
      name: 'smart_subagent_plan',
      description: 'Create, present, and dispatch an execution plan for the current user goal. In planning modes that need a child planner (fixed or automatic), it delegates to the planner model and returns its JSON plan. In main-agent mode, it normalizes the plan provided in `plan`. Returns a confirmation token the caller passes to smart_subagent_run_plan.',
      parameters: {
        goal: { type: 'string', required: true },
        planner: { type: 'string', description: 'Chosen planner model alias. If provided, overrides the configured planner or planningMode.' },
        plan: { type: 'object', additionalProperties: false, description: 'Optional plan { goal, steps[] } when the main agent authored the plan.', properties: {
          goal: { type: 'string' },
          steps: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
            title: { type: 'string' }, summary: { type: 'string' }, prompt: { type: 'string' }, dependsOn: { type: 'array', items: { type: 'string' } },
          } } },
        } },
        require_confirmation: { type: 'boolean', description: 'When true and the settings require confirmation, return a `confirmation-required` result instead of auto-dispatching.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const { settings, concurrency } = runtimeFor(exec)
        let planner
        if (typeof args.planner === 'string' && args.planner.trim() !== '') {
          const alias = args.planner.trim()
          const matched = settings.models.find((model) => model.enabled && model.alias === alias && model.allowPlanning)
          if (matched === undefined) throw new Error(`planner alias "${alias}" is not enabled or not allowed for planning`)
          planner = { model: matched, mode: 'fixed', reason: 'Planner selected by the user.' }
        } else {
          planner = choosePlanner(settings)
        }
        if (planner.mode === 'main-agent') {
          const plan = normalizePlanSteps({ goal: args.goal, steps: args.plan?.steps ?? [] })
          return { mode: 'main-agent', summary: planSummary(plan), plan, requiresConfirmation: settings.requirePlanConfirmation }
        }
        if (planner.mode === 'ask') {
          const choices = settings.models.filter((model) => model.enabled && model.allowPlanning).map((model) => ({ alias: model.alias, displayName: model.displayName, purpose: model.purpose }))
          return { mode: 'ask', recommendation: choices[0]?.alias ?? '', choices, goal: args.goal }
        }
        const prompt = `Create a JSON plan for the goal: ${args.goal}\nRespond strictly with JSON of the shape { "goal": string, "steps": [{ "title": string, "summary": string, "prompt": string, "dependsOn": string[] }] }`
        const request = buildRequest(exec.agent, exec.signal, planner.model, 'Plan the work', prompt, settings.maxDepth)
        const releaseConcurrency = await concurrency.acquire(exec.signal)
        let output
        try {
          output = await runForeground(ctx.subagents, settings.subagentProvider, request, planner.model.alias, { timeoutMs: settings.foregroundTimeoutMs, parent: exec.agent })
        } finally {
          releaseConcurrency()
        }
        const text = (output.output ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim()
        const json = text.match(/\{[\s\S]*\}/)?.[0]
        const plan = normalizePlanSteps(json === undefined ? { goal: args.goal, steps: [] } : JSON.parse(json))
        return { mode: 'planner-model', planner: planner.model.alias, reason: planner.reason, summary: planSummary(plan), plan, requiresConfirmation: settings.requirePlanConfirmation }
      },
    }),
    defineTool({
      name: 'smart_subagent_run_plan',
      description: 'Execute a plan returned by smart_subagent_plan. Parallel steps within a layer may run concurrently as background subagents; subsequent layers run after the previous layer has fully settled. Steps that pick the same model alias are serialized (max one in-flight per alias); different aliases may run in parallel. ask mode aborts dispatch and returns a recommendation.',
      parameters: {
        plan: { type: 'object', required: true, additionalProperties: false, properties: {
          goal: { type: 'string', required: true },
          steps: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
            title: { type: 'string', required: true },
            summary: { type: 'string' },
            prompt: { type: 'string' },
            dependsOn: { type: 'array', items: { type: 'string' } },
          } } },
        } },
        selections: { type: 'object', additionalProperties: true, description: 'Map of step title to selected model alias.' },
        dispatched: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'List of step execution state entries from previous runs.' },
        selection_mode: { type: 'string', enum: ['automatic', 'ask'], description: 'Override the configured routing mode for this dispatch.' },
        wait: { type: 'boolean', description: 'When true, block until every child settles before returning.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const { settings, concurrency } = runtimeFor(exec)
        const plan = normalizePlanSteps(args.plan)
        const mode = args.selection_mode ?? settings.mode
        let state
        let settlements = []
        let threwError = null
        const tracker = exec.tracker ?? trackerForPlugin ?? globalTracker
        try {
          state = await executeLayers({ ctx, settings, plan, exec, mode, concurrency, tracker, selections: args.selections, dispatched: args.dispatched })
          if (state.awaiting !== undefined) {
            return {
              status: 'awaiting-choice',
              step: state.awaiting,
              dispatched: [...state.dispatched, ...state.completedForeground],
              layers: plan.layers.map((stepIndexes, index) => ({ index, stepIndexes: stepIndexes.slice() })),
              plan,
            }
          }
          if (args.wait === true && tracker !== undefined && state.dispatched.length > 0) {
            settlements = await tracker.waitForIds(exec.agent, state.dispatched.map((entry) => entry.childId), exec.signal, settings.idleTimeoutMs)
            for (const entry of settlements) {
              const match = state.dispatched.find((value) => value.childId === entry.subagentId)
              if (match !== undefined) match.settlement = entry
              for (const [stepIndex, res] of state.stepResults.entries()) {
                if (res.childId === entry.subagentId) {
                  let status = 'failed'
                  if (entry.stopReason === 'completed') status = 'completed'
                  else if (entry.stopReason === 'aborted' || entry.stopReason === 'interrupted') status = 'cancelled'
                  else if (entry.stopReason === 'timeout') status = 'timeout'
                  state.stepResults.set(stepIndex, {
                    ...res,
                    status,
                    stopReason: entry.stopReason
                  })
                  break
                }
              }
            }
          }
        } catch (error) {
          // A caller abort is a normal orchestration outcome, not a tool error.
          // Keep the partial state so already-started children remain represented;
          // only unexpected implementation/runtime failures are rethrown below.
          if (!exec.signal?.aborted) threwError = error
          if (!state) {
            state = { dispatched: [], completedForeground: [], stepResults: new Map() }
          }
          if (args.wait === true && exec.signal?.aborted && tracker !== undefined && state.dispatched.length > 0) {
            settlements = tracker.settlementsForIds?.(exec.agent, state.dispatched.map((entry) => entry.childId)) ?? []
          }
        }

        // Abort is an aggregate orchestration outcome. A child may already have
        // been dispatched while tracker.waitForIds was interrupted, but without
        // an end event yet; expose it as cancelled rather than leaking a live
        // `started` result in the returned snapshot. Steps that never reached
        // dispatch are filled in below with cancelled/skipped results.
        if (exec.signal?.aborted === true) {
          const reason = exec.signal.reason instanceof Error
            ? exec.signal.reason.message
            : exec.signal.reason === undefined ? 'orchestration was cancelled' : String(exec.signal.reason)
          for (const [stepIndex, result] of state.stepResults.entries()) {
            if (result.status === 'started') {
              state.stepResults.set(stepIndex, { ...result, status: 'cancelled', error: reason })
            }
          }
        }

        const stepResults = []
        for (let i = 0; i < plan.steps.length; i++) {
          let res = state.stepResults.get(i)
          if (!res) {
            const step = plan.steps[i]
            const blockedBy = step.dependsOn.filter((depIndex) => {
              const depResult = state.stepResults.get(depIndex)
              return !depResult || depResult.status !== 'completed'
            })
            if (blockedBy.length > 0) {
              res = {
                stepIndex: i,
                title: step.title,
                status: 'skipped',
                blockedBy: blockedBy.sort((a, b) => a - b),
                reason: 'dependency-not-completed'
              }
            } else {
              res = {
                stepIndex: i,
                title: step.title,
                status: 'cancelled',
                reason: 'orchestration was cancelled before dispatch'
              }
            }
            state.stepResults.set(i, res)
          }
          stepResults.push(res)
        }

        stepResults.sort((a, b) => a.stepIndex - b.stepIndex)

        const summary = {
          total: plan.steps.length,
          completed: 0,
          failed: 0,
          cancelled: 0,
          timeout: 0,
          skipped: 0
        }
        for (const res of stepResults) {
          if (res.status === 'completed') summary.completed++
          else if (res.status === 'failed') summary.failed++
          else if (res.status === 'cancelled') summary.cancelled++
          else if (res.status === 'timeout') summary.timeout++
          else if (res.status === 'skipped') summary.skipped++
        }

        const hasRunning = stepResults.some((res) => res.status === 'started')
        const globallyAborted = exec.signal?.aborted === true
        let finalStatus = 'completed'
        if (globallyAborted) {
          finalStatus = 'cancelled'
        } else if (summary.completed === plan.steps.length) {
          finalStatus = 'completed'
        } else if (summary.completed > 0 || hasRunning) {
          // A non-waiting invocation reports live children as started, never completed.
          finalStatus = 'partial'
        } else if (summary.failed > 0 || summary.timeout > 0) {
          finalStatus = 'failed'
        } else {
          finalStatus = 'cancelled'
        }

        if (threwError) {
          throw threwError
        }

        const returned = {
          status: finalStatus,
          requiresConfirmation: false,
          plan,
          dispatched: [...state.dispatched, ...state.completedForeground],
          layers: plan.layers.map((stepIndexes, index) => ({ index, stepIndexes: stepIndexes.slice() })),
          stepResults,
          summary
        }
        if (args.wait === true) {
          returned.settlements = settlements
        }
        return returned
      },
    }),
    defineTool({
      name: 'smart_subagent_wait',
      description: 'Wait for every outstanding background subagent created by this parent, including those started by smart_subagent_run_plan and smart_delegate, and return their settled results.',
      parameters: {},
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        const tracker = exec.tracker ?? trackerForPlugin ?? globalTracker
        if (tracker === undefined) return { status: 'no-tracker', settlements: [] }
        const settlements = await tracker.wait(exec.agent, exec.signal)
        return { status: 'completed', settlements }
      },
    }),
    defineTool({
      name: 'smart_subagent_status',
      description: 'Get a snapshot of the current status of all background subagents started by this parent without waiting for them to settle.',
      parameters: {},
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        const tracker = exec.tracker ?? trackerForPlugin ?? globalTracker
        if (tracker === undefined) return { status: 'no-tracker', subagents: [] }
        const subagents = tracker.snapshot(exec.agent)
        return { status: 'completed', subagents }
      },
    }),
  ]
}

function enabledAliases(settings) {
  return settings.models.filter((model) => model.enabled && model.allowExecution).map((model) => ({ alias: model.alias, displayName: model.displayName, purpose: model.purpose }))
}

function setTracker(tracker) { globalTracker = tracker }

export { buildPlanTools, enabledAliases, setTracker }