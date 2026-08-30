import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isSettingsStore, normalizeSettings, normalizeSettingsStore } from './model-config.js'
import { recommendModel } from './model-router.js'
import { scanModels } from './model-scanner.js'
import { skillContentForSettings } from './skill-generator.js'
import { buildRequest, createConcurrencyGate, runForeground, startBackground } from './subagent-runner.js'
import { registerSettingsRoute } from './settings-route.js'
import { buildPlanTools, enabledAliases, setTracker } from './orchestration-tools.js'
import { createOrchestrationTracker } from './orchestration-tracker.js'
import { createProfileResolver } from './profile-resolver.js'

const name = 'dsh-samrt-subagent'
const inject = ['tools', 'subagents', 'skills', 'settings', 'llm', 'agents']
const SETTINGS_NAMESPACE = 'smart-subagent-orchestrator'
const DELEGATE_TOOL = 'smart_delegate'
const SCAN_TOOL = 'smart_subagent_model_catalog'
const PREVIEW_TOOL = 'smart_subagent_skill_preview'
const SKILL_NAME = 'smart-subagent-orchestration'

const ModelSchema = z.object({
  alias: z.string().required(), provider: z.string().required(), model: z.string().required(),
  displayName: z.string(), purpose: z.string().required(), tags: z.array(z.string()).default([]),
  enabled: z.boolean().default(true), allowPlanning: z.boolean().default(true), allowExecution: z.boolean().default(true),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  reasoningEffort: z.union(['low', 'medium', 'high']).default('low'),
  reasoningEfforts: z.array(z.string()).default(['low', 'medium', 'high']),
})
const ProfileSettingsSchema = z.object({
  mode: z.union(['automatic', 'ask']).default('automatic'),
  planningMode: z.union(['main-agent', 'automatic', 'fixed', 'ask']).default('main-agent'),
  plannerAlias: z.string().default(''), requirePlanConfirmation: z.boolean().default(true),
  subagentProvider: z.string().default('spawn'), maxDepth: z.number().step(1).min(0).default(1),
  foregroundTimeoutMs: z.number().step(1).min(1).default(120000), idleTimeoutMs: z.number().step(1).min(1).default(60000),
  maxConcurrentSubagents: z.number().step(1).min(1).default(3),
  enableBackground: z.boolean().default(true), showSelectionReason: z.boolean().default(true),
  customSkill: z.string().default(''),
  models: z.array(ModelSchema).default([]),
})
const SettingsStoreSchema = z.object({
  profiles: z.array(z.object({ id: z.string().required(), name: z.string().required(), settings: ProfileSettingsSchema })).min(1),
  globalProfileId: z.string().required(),
})
// The legacy branch lets Settings load old persisted values long enough for apply()
// to replace them with the multi-profile representation.
const SettingsSchema = z.union([SettingsStoreSchema, ProfileSettingsSchema])

function enabledCatalog(settings) {
  return settings.models.filter((model) => model.enabled).map((model) => ({
    alias: model.alias, displayName: model.displayName, provider: model.provider, model: model.model,
    purpose: model.purpose, tags: model.tags, allowPlanning: model.allowPlanning, allowExecution: model.allowExecution,
  }))
}

function combinedCatalog(store) {
  const result = new Map()
  for (const profile of store.profiles) {
    for (const model of enabledCatalog(profile.settings)) if (!result.has(model.alias)) result.set(model.alias, model)
  }
  return [...result.values()]
}

function registerScanTool(ctx) {
  return ctx.tools.register(defineTool({
    name: SCAN_TOOL,
    description: 'Scan model routes advertised by the currently registered DSH LLM providers. Catalog results are advisory; users decide which routes to enable.',
    parameters: {}, output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    isConcurrencySafe: () => true,
    execute() { return scanModels(ctx.llm) },
  }))
}

function registerSkillPreviewTool(ctx, resolver) {
  return ctx.tools.register(defineTool({
    name: PREVIEW_TOOL,
    description: 'Preview the generated smart subagent orchestration skill.',
    parameters: {},
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    isConcurrencySafe: () => true,
    execute(_args, exec) {
      const profile = resolver.effectiveProfile(exec.agent)
      return {
        skill: SKILL_NAME, name: SKILL_NAME,
        description: 'Plan work and route delegated tasks across the user-enabled subagent models.',
        whenToUse: 'Use when planning work, delegating tasks, choosing a subagent model, or coordinating multiple agents.',
        generatedAt: new Date().toISOString(), profileId: profile.id, profileName: profile.name,
        content: skillContentForSettings(profile.settings),
      }
    },
  }))
}

function createDelegateTool(ctx, resolver, tracker, runtimeFor, choices) {
  return defineTool({
    name: DELEGATE_TOOL,
    description: 'Delegate one task to an enabled model route. In ask mode, omit model to receive a recommendation and choices, ask the user, then call again with the chosen alias.',
    parameters: {
      task: { type: 'string', required: true, description: 'Short task label.' },
      prompt: { type: 'string', required: true, description: 'Complete self-contained child prompt.' },
      role: { type: 'string', enum: ['planning', 'execution'], description: 'Defaults to execution.' },
      model: { type: 'string', enum: choices.map((entry) => entry.alias), description: 'Enabled alias. Required after user selection in ask mode.' },
      run_in_background: { type: 'boolean', description: 'Use a durable continuable child when enabled; defaults to true.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { settings, concurrency } = runtimeFor(exec.agent)
      const role = args.role ?? 'execution'
      const recommendation = recommendModel(settings.models, `${args.task}\n${args.prompt}`, role)
      if (settings.mode === 'ask' && args.model === undefined) return { kind: 'choice-required', recommendation: recommendation.model.alias, reason: recommendation.reason, choices: enabledAliases(settings) }
      const selected = args.model === undefined ? recommendation.model : settings.models.find((model) => model.enabled && model.alias === args.model)
      if (selected === undefined) throw new Error(`unknown or disabled model alias "${String(args.model)}" in profile "${resolver.effectiveProfile(exec.agent).name}"`)
      if (role === 'planning' && !selected.allowPlanning) throw new Error(`model "${selected.alias}" is not allowed for planning`)
      if (role === 'execution' && !selected.allowExecution) throw new Error(`model "${selected.alias}" is not allowed for execution`)
      const request = buildRequest(exec.agent, exec.signal, selected, args.task, args.prompt, settings.maxDepth)
      const useBackground = settings.enableBackground && args.run_in_background !== false
      let releaseConcurrency = await concurrency.acquire(exec.signal)
      if (!useBackground) {
        try {
          return { ...(await runForeground(ctx.subagents, settings.subagentProvider, request, selected.alias, { timeoutMs: settings.foregroundTimeoutMs, parent: exec.agent })), selectionReason: args.model === undefined ? recommendation.reason : 'The caller explicitly selected this model.' }
        } finally { releaseConcurrency() }
      }
      const state = tracker.begin(exec.agent)
      try {
        const child = await startBackground(ctx.subagents, settings.subagentProvider, request, selected.alias)
        concurrency.track(child.subagentId, releaseConcurrency, settings.idleTimeoutMs)
        releaseConcurrency = undefined
        tracker.track(exec.agent, child.subagentId, args.task)
        return { kind: 'continuable', subagentId: child.subagentId, messageId: child.messageId, model: selected.alias, selectionReason: args.model === undefined ? recommendation.reason : 'The caller explicitly selected this model.' }
      } finally {
        releaseConcurrency?.()
        tracker.finish(exec.agent, state)
      }
    },
  })
}

async function apply(ctx) {
  const scope = ctx.settings.register(SETTINGS_NAMESPACE, SettingsSchema, { applies: 'live', validate: normalizeSettingsStore })
  const raw = scope.get()
  let store = normalizeSettingsStore(raw)
  if (!isSettingsStore(raw)) await scope.replace(store)

  const resolver = createProfileResolver(store)
  const tracker = createOrchestrationTracker(ctx)
  setTracker(tracker)
  const fallbackConcurrency = createConcurrencyGate(3)
  const gates = new Map()
  const runtimeFor = (agent) => {
    const settings = resolver.effectiveSettings(agent)
    const key = agent?.session
    const concurrency = key === undefined ? fallbackConcurrency : (gates.get(key) ?? (() => {
      const gate = createConcurrencyGate(settings.maxConcurrentSubagents)
      gates.set(key, gate)
      return gate
    })())
    concurrency.setLimit(settings.maxConcurrentSubagents)
    return { settings, concurrency }
  }

  registerScanTool(ctx)
  registerSkillPreviewTool(ctx, resolver)
  ctx.on('subagent/end', (info) => {
    fallbackConcurrency.end(info.id)
    for (const gate of gates.values()) gate.end(info.id)
  })

  let fallbackSkillDisposer
  const agentSkills = new Map()
  const skillDefinition = (settings) => ({
    name: SKILL_NAME,
    description: 'Plan work and route delegated tasks across the user-enabled subagent models.',
    whenToUse: 'Use when planning work, delegating tasks, choosing a subagent model, or coordinating multiple agents.',
    invocation: { modelInvocable: true, userInvocable: true }, source: 'runtime',
    content: skillContentForSettings(settings),
  })
  const syncAgentSkill = (agent) => {
    const previous = agentSkills.get(agent)
    try { previous?.() } catch {}
    const skills = agent?.ctx?.skills ?? agent?.ctx?.get?.('skills')
    if (skills?.register === undefined) { agentSkills.delete(agent); return }
    agentSkills.set(agent, skills.register(skillDefinition(resolver.effectiveSettings(agent))))
  }

  ctx.on('agent/session-start', ({ agent }) => {
    fallbackSkillDisposer?.()
    fallbackSkillDisposer = undefined
    syncAgentSkill(agent)
  })
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (resolver.handleMessage(agent, message) !== undefined) syncAgentSkill(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const dispose = agentSkills.get(agent)
    agentSkills.delete(agent)
    try { dispose?.() } catch {}
    // Session profile overrides outlive an individual Agent instance and are
    // cleared only when the owning Session is disposed.
  })
  ctx.on('session/disposed', (session) => {
    resolver.disposeSession(session)
    gates.get(session)?.dispose()
    gates.delete(session)
  })

  let settingsKey
  let toolDisposers = []
  let reconciling = false
  const reconcile = (value) => {
    const nextStore = normalizeSettingsStore(value)
    const nextKey = JSON.stringify(nextStore)
    if (nextKey === settingsKey || reconciling) return
    reconciling = true
    settingsKey = nextKey
    try {
      for (const dispose of toolDisposers) dispose()
      toolDisposers = []
      store = nextStore
      resolver.update(store)
      const choices = combinedCatalog(store)
      const tools = buildPlanTools(ctx, runtimeFor, undefined, tracker)
      if (choices.length > 0) tools.unshift(createDelegateTool(ctx, resolver, tracker, runtimeFor, choices))
      for (const tool of tools) toolDisposers.push(ctx.tools.register(tool))
      for (const agent of agentSkills.keys()) syncAgentSkill(agent)
      if (agentSkills.size === 0) {
        fallbackSkillDisposer?.()
        fallbackSkillDisposer = ctx.skills.register(skillDefinition(resolver.effectiveSettings(undefined)))
      } else if (fallbackSkillDisposer !== undefined) {
        // Once agents exist, the fallback skill is unreachable; releasing it
        // prevents a stale registration from outliving every Agent.
        fallbackSkillDisposer()
        fallbackSkillDisposer = undefined
      }
    } finally {
      reconciling = false
    }
  }
  reconcile(store)
  ctx.effect(() => scope.watch(reconcile), 'smart-subagent-orchestrator: live settings')
  ctx.effect(() => () => {
    for (const dispose of toolDisposers.splice(0)) dispose()
    fallbackSkillDisposer?.()
    for (const dispose of agentSkills.values()) { try { dispose() } catch {} }
    agentSkills.clear()
    resolver.clear()
    fallbackConcurrency.dispose()
    for (const gate of gates.values()) gate.dispose()
    gates.clear()
  }, 'smart-subagent-orchestrator: runtime cleanup')
  ctx.effect(() => {
    const disposeRoute = registerSettingsRoute(ctx)
    return () => { disposeRoute?.() }
  }, 'smart-subagent-orchestrator: settings route')
}

export { DELEGATE_TOOL, SCAN_TOOL, PREVIEW_TOOL, SETTINGS_NAMESPACE, SKILL_NAME, ModelSchema, ProfileSettingsSchema, SettingsStoreSchema, SettingsSchema, apply, inject, name, normalizeSettings }
