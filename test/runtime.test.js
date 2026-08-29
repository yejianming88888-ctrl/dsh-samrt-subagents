import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, SETTINGS_NAMESPACE } from '../lib/index.js'
import { generateRoutingSkill } from '../lib/skill-generator.js'
import { normalizeSettings } from '../lib/model-config.js'

function createContext(initial) {
  const tools = new Map()
  const skills = []
  const settingsList = [{ ns: SETTINGS_NAMESPACE, value: normalizeSettings({ idleTimeoutMs: 50, ...initial }), revision: 0 }]
  const continuableStarts = []
  const starts = []
  let settingsWatcher
  let lastRegistration
  const effects = []
  const webServer = {
    _handler: null,
    registrations: 0,
    disposals: 0,
    register({ handler }) {
      this.registrations += 1
      this._handler = handler
      return () => {
        this.disposals += 1
        if (this._handler === handler) this._handler = null
      }
    },
  }
  return {
    tools, skills, continuableStarts, starts, webServer,
    ctx: {
      get llm() { return { listProviders() { return [{ id: 'p', name: 'P' }] }, async listModels() { return [{ id: 'm', name: 'M' }] } } },
      get(name) {
        if (name === 'llm') return this.llm
        if (name === 'webServer') return webServer
        return undefined
      },
      tools: { register: (tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
      subagents: {
        async start(name, request) {
          starts.push({ name, request })
          return { id: 'r', result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] }), async dispose() {} }
        },
        async startContinuable(spec) {
          continuableStarts.push(spec)
          return { childId: 'c', messageId: 'm' }
        },
      },
      settings: {
        writable: true,
        describe() { return settingsList },
        register(namespace, schema, options) {
          lastRegistration = { namespace, schema, options }
          return {
            get() { return settingsList[0].value },
            async replace(next) {
              options.validate(next)
              settingsList[0] = { ns: namespace, value: next, revision: settingsList[0].revision + 1 }
            },
            watch(callback) { settingsWatcher = callback; return () => { settingsWatcher = undefined } },
          }
        },
      },
      skills: { register: (skill) => { skills.push(skill); return () => {} } },
      effect: (callback) => {
        const dispose = callback()
        const owned = typeof dispose === 'function' ? dispose : () => {}
        effects.push(owned)
        return owned
      },
      logger: { info() {}, warn() {}, error() {} },
      on() { return () => {} },
    },
    update(next) {
      lastRegistration.options.validate(next)
      settingsList[0] = { ns: SETTINGS_NAMESPACE, value: normalizeSettings(next), revision: settingsList[0].revision + 1 }
      settingsWatcher?.(settingsList[0].value, settingsList[0].value)
    },
    dispose() {
      for (const dispose of effects.splice(0).reverse()) dispose()
    },
  }
}

test('plugin registers scanning, preview, delegation, planning, running, waiting, status, and stopping tools and skill', async () => {
  const harness = createContext({ mode: 'automatic', models: [{ alias: 'fast', provider: 'p', model: 'm', purpose: '快速整理' }] })
  await apply(harness.ctx)
  assert.ok(harness.tools.has('smart_subagent_model_catalog'))
  assert.ok(harness.tools.has('smart_subagent_skill_preview'))
  assert.ok(harness.tools.has('smart_delegate'))
  assert.ok(harness.tools.has('smart_subagent_plan'))
  assert.ok(harness.tools.has('smart_subagent_run_plan'))
  assert.ok(harness.tools.has('smart_subagent_wait'))
  assert.ok(harness.tools.has('smart_subagent_status'))
  assert.ok(harness.tools.has('smart_subagent_stop'))
  assert.ok(harness.skills.some((skill) => skill.name === 'smart-subagent-orchestration'))
})

test('plugin disposal unregisters settings route without duplicate handlers', async () => {
  const harness = createContext({ mode: 'automatic', models: [] })
  await apply(harness.ctx)
  assert.equal(harness.webServer.registrations, 1)
  assert.equal(typeof harness.webServer._handler, 'function')

  harness.update({ mode: 'ask', models: [{ alias: 'fast', provider: 'p', model: 'm', purpose: '快速整理' }] })
  assert.equal(harness.webServer.registrations, 1)
  assert.equal(typeof harness.webServer._handler, 'function')

  harness.dispose()
  assert.equal(harness.webServer._handler, null)
  assert.equal(harness.webServer.disposals, 1)
  harness.dispose()
  assert.equal(harness.webServer._handler, null)
  assert.equal(harness.webServer.disposals, 1)
})

test('empty model settings keep bootstrap capabilities and hot-register delegation after configuration', async () => {
  const harness = createContext({ mode: 'automatic', models: [] })
  await apply(harness.ctx)
  assert.ok(harness.tools.has('smart_subagent_model_catalog'))
  assert.ok(harness.tools.has('smart_subagent_skill_preview'))
  assert.equal(harness.tools.has('smart_delegate'), false)

  harness.update({ mode: 'automatic', models: [{ alias: 'fast', provider: 'p', model: 'm', purpose: '快速整理' }] })
  assert.ok(harness.tools.has('smart_delegate'))
})

test('smart_subagent_model_catalog tool execution', async () => {
  const harness = createContext({ mode: 'automatic', models: [{ alias: 'fast', provider: 'p', model: 'm', purpose: '快速整理' }] })
  await apply(harness.ctx)
  const tool = harness.tools.get('smart_subagent_model_catalog')
  assert.ok(tool)
  const result = await tool.execute({}, { agent: { id: 'main' }, signal: new AbortController().signal })
  assert.deepEqual(result, [
    {
      id: 'p',
      name: 'P',
      models: [
        {
          id: 'm',
          name: 'M',
        },
      ],
    },
  ])
})

test('smart_subagent_skill_preview tool execution', async () => {
  const harness = createContext({
    mode: 'automatic',
    models: [{ alias: 'fast', provider: 'p', model: 'm', purpose: '快速整理', enabled: true, allowPlanning: true, allowExecution: true, tags: ['fast'] }],
  })
  await apply(harness.ctx)
  const tool = harness.tools.get('smart_subagent_skill_preview')
  assert.ok(tool)
  const result = await tool.execute({}, { agent: { id: 'main' }, signal: new AbortController().signal })
  assert.strictEqual(result.skill, 'smart-subagent-orchestration')
  assert.strictEqual(result.name, 'smart-subagent-orchestration')
  assert.ok(result.description)
  assert.ok(result.whenToUse)
  assert.ok(result.generatedAt)
  assert.ok(typeof result.content === 'string')
  assert.match(result.content, /Smart Subagent Orchestration/)
  assert.match(result.content, /`fast`/)
})

test('plugin returns a recommendation and choices in ask mode', async () => {
  const harness = createContext({ mode: 'ask', models: [{ alias: 'fast', provider: 'p', model: 'm', purpose: '快速整理' }] })
  await apply(harness.ctx)
  const tool = harness.tools.get('smart_delegate')
  const result = await tool.execute({ task: '整理', prompt: '请整理一下文档' }, { agent: { id: 'main' }, signal: new AbortController().signal })
  assert.equal(result.kind, 'choice-required')
  assert.equal(result.recommendation, 'fast')
})

test('ask mode forwards to foreground when the caller picks a model', async () => {
  const harness = createContext({ mode: 'ask', enableBackground: false, models: [{ alias: 'fast', provider: 'p', model: 'm', purpose: '快速整理' }] })
  await apply(harness.ctx)
  const tool = harness.tools.get('smart_delegate')
  const result = await tool.execute({ task: '整理', prompt: '请整理一下文档', model: 'fast', run_in_background: false }, { agent: { id: 'main' }, signal: new AbortController().signal })
  assert.equal(result.kind, 'foreground')
  assert.equal(result.runId, 'r')
})

test('automatic mode uses background continuable child', async () => {
  const harness = createContext({ mode: 'automatic', models: [{ alias: 'fast', provider: 'p', model: 'm', purpose: '复杂架构设计' }] })
  await apply(harness.ctx)
  const tool = harness.tools.get('smart_delegate')
  const signal = new AbortController().signal
  const result = await tool.execute({ task: '设计', prompt: '设计模块拆分' }, { agent: { id: 'main' }, signal })
  assert.equal(result.kind, 'continuable')
  assert.equal(harness.continuableStarts.length, 1)
  const spec = harness.continuableStarts[0]
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.request.agentOptions.provider, 'p')
  assert.equal(spec.request.agentOptions.model, 'm')
})

test('generated skill reflects current settings after update', async () => {
  const harness = createContext({ mode: 'automatic', models: [{ alias: 'fast', provider: 'p', model: 'm', purpose: '快速整理' }] })
  await apply(harness.ctx)
  harness.update({ mode: 'ask', models: [{ alias: 'fast', provider: 'p', model: 'm', purpose: '快速整理' }] })
  const skills = harness.skills.filter((entry) => entry.name === 'smart-subagent-orchestration')
  const latest = skills[skills.length - 1]
  assert.match(latest.content, /ask the user which enabled model to use/)
})

test('saved customSkill takes precedence over auto-generated', async () => {
  const customSkill = '# Custom Skill\n\nAlways use this exact text.'
  const harness = createContext({
    mode: 'automatic',
    customSkill,
    models: [{ alias: 'fast', provider: 'p', model: 'm', purpose: '快速整理' }],
  })
  await apply(harness.ctx)

  // Verify custom skill is registered and wins over auto-generated
  const skill = harness.skills.find((entry) => entry.name === 'smart-subagent-orchestration')
  assert.strictEqual(skill.content, customSkill)
})

test('whitespace-only customSkill is treated as empty and restores auto-generation', async () => {
  const harness = createContext({
    mode: 'automatic',
    customSkill: '   \n  ',
    models: [{ alias: 'fast', provider: 'p', model: 'm', purpose: '快速整理' }],
  })
  await apply(harness.ctx)

  const skill = harness.skills.find((entry) => entry.name === 'smart-subagent-orchestration')
  assert.match(skill.content, /Smart Subagent Orchestration/, 'whitespace-only customSkill should restore auto-generation')
})

test('skill preview tool respects saved customSkill', async () => {
  const customSkill = '# Preview Test Skill\n\nPreview this.'
  const harness = createContext({
    mode: 'automatic',
    customSkill,
    models: [{ alias: 'fast', provider: 'p', model: 'm', purpose: '快速整理' }],
  })
  await apply(harness.ctx)

  const tool = harness.tools.get('smart_subagent_skill_preview')
  assert.ok(tool)
  const result = await tool.execute({}, { agent: { id: 'main' }, signal: new AbortController().signal })
  assert.strictEqual(result.content, customSkill)
  assert.strictEqual(result.skill, 'smart-subagent-orchestration')
})