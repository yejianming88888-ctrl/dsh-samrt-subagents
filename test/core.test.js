import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeSettings } from '../lib/model-config.js'
import { recommendModel } from '../lib/model-router.js'
import { generateRoutingSkill, skillContentForSettings } from '../lib/skill-generator.js'
import { buildRequest } from '../lib/subagent-runner.js'
import { scanModels } from '../lib/model-scanner.js'

const settings = normalizeSettings({
  models: [
    { alias: 'fast', provider: 'p', model: 'm1', purpose: '快速总结和整理文档', tags: ['fast', 'summary'] },
    { alias: 'deep', provider: 'p', model: 'm2', purpose: '复杂架构设计和代码审查', tags: ['architecture', 'review'] },
  ],
})

test('normalizes orchestration settings', () => {
  assert.equal(settings.mode, 'automatic')
  assert.equal(settings.maxDepth, 1)
  assert.equal(settings.models[0].enabled, true)
})

test('routes by user purpose and tags', () => {
  assert.equal(recommendModel(settings.models, 'architecture review').model.alias, 'deep')
})

test('generates a user and model invocable skill body', () => {
  const content = generateRoutingSkill(settings)
  assert.match(content, /Smart Subagent Orchestration/)
  assert.match(content, /`fast`/)
  assert.match(content, /Only use enabled routes/)
  assert.match(content, /Child agents must not call delegation tools/)
  assert.match(content, /smart_subagent_status/)
  assert.match(content, /smart_subagent_stop/)
})

test('uses a saved custom Skill and restores generation for empty text', () => {
  const custom = '# My routing rules\n\nUse the selected route exactly.'
  assert.equal(skillContentForSettings({ ...settings, customSkill: custom }), custom)
  assert.equal(skillContentForSettings({ ...settings, customSkill: '  \n  ' }), generateRoutingSkill(settings))
})

test('normalizes empty models settings and verifies max depth is 1', () => {
  const emptySettings = normalizeSettings({ models: [] })
  assert.equal(emptySettings.maxDepth, 1)
})

test('buildRequest forwards the prompt verbatim for every provider', () => {
  const signal = new AbortController().signal
  const prompt = '  Implement task 4\nDo not trim or append anything.  '
  const routes = [
    { provider: 'google-antigravity', model: 'gemini_37_flash', maxTokens: 2048 },
    { provider: 'openai', model: 'gpt-5' },
    { provider: 'other-provider', model: 'other-model' },
  ]

  for (const selected of routes) {
    const request = buildRequest('parent-agent', signal, selected, 'task-label', prompt, 1)
    assert.deepEqual(request.prompt, [{ type: 'text', text: prompt }])
    assert.equal(request.agentOptions.provider, selected.provider)
  }
})

test('resolves exact model reasoning efforts and preserves missing metadata', async () => {
  const resolved = {
    subset: { reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'high', name: 'High' }, { id: 'unsupported', name: 'Unsupported' }] } },
    none: { reasoning: { efforts: [] } },
    absent: {},
  }
  const result = await scanModels({
    listProviders: () => [{ id: 'p', name: 'Provider' }],
    listModels: async () => [
      { id: 'subset', name: 'Subset' },
      { id: 'none', name: 'None' },
      { id: 'absent', name: 'Absent' },
    ],
    resolveModelInfo: async (_provider, model) => resolved[model],
  })
  assert.deepEqual(result[0].models[0].reasoningEfforts, ['high'])
  assert.deepEqual(result[0].models[1].reasoningEfforts, [])
  assert.equal('reasoningEfforts' in result[0].models[2], false)
})

test('normalizes reasoningEfforts and reasoningEffort corrections and compatibility', () => {
  // 1. Backward compatibility: missing reasoningEfforts fallback to low/medium/high
  const configOld = normalizeSettings({
    models: [{ alias: 'm', provider: 'p', model: 'md', purpose: 'test' }]
  })
  assert.deepEqual(configOld.models[0].reasoningEfforts, ['low', 'medium', 'high'])
  assert.equal(configOld.models[0].reasoningEffort, 'low')

  // 2. Scan result explicitly [] remains [] and cannot be enabled
  const configEmpty = normalizeSettings({
    models: [{ alias: 'm', provider: 'p', model: 'md', purpose: 'test', reasoningEfforts: [], enabled: false }]
  })
  assert.deepEqual(configEmpty.models[0].reasoningEfforts, [])
  assert.equal(configEmpty.models[0].enabled, false)

  // 3. Unknown capability metadata remains selectable and preserves an empty list
  const configUnknown = normalizeSettings({
    models: [{ alias: 'm', provider: 'p', model: 'md', purpose: 'test', reasoningEfforts: [], enabled: true }]
  })
  assert.deepEqual(configUnknown.models[0].reasoningEfforts, [])
  assert.equal(configUnknown.models[0].enabled, true)
  assert.equal(configUnknown.models[0].reasoningEffort, 'low')

  // 4. Safe correction: reasoningEffort not in list gets corrected to first supported
  const configCorrect = normalizeSettings({
    models: [{ alias: 'm', provider: 'p', model: 'md', purpose: 'test', reasoningEfforts: ['medium', 'high'], reasoningEffort: 'low' }]
  })
  assert.equal(configCorrect.models[0].reasoningEffort, 'medium')
})
