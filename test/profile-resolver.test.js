import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSettingsStore } from '../lib/model-config.js'
import { createProfileResolver, profileCommand } from '../lib/profile-resolver.js'

const model = (alias) => ({
  alias,
  provider: 'provider',
  model: alias,
  purpose: `${alias} purpose`,
  reasoningEfforts: ['low', 'high'],
})

const store = normalizeSettingsStore({
  profiles: [
    { id: 'dev', name: '开发配置', settings: { models: [model('dev-model')] } },
    { id: 'drama', name: '漫剧配置', settings: { models: [model('drama-model')] } },
  ],
  globalProfileId: 'dev',
})

const userMessage = (text) => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] })

test('legacy single settings migrate to one default profile', () => {
  const migrated = normalizeSettingsStore({ maxDepth: 2, models: [model('legacy')] })
  assert.equal(migrated.globalProfileId, 'default')
  assert.equal(migrated.profiles.length, 1)
  assert.equal(migrated.profiles[0].settings.maxDepth, 2)
  assert.equal(migrated.profiles[0].settings.models[0].alias, 'legacy')
})

test('profile resolver uses global profile and isolates session overrides', () => {
  const resolver = createProfileResolver(store)
  const first = { session: 'session-a' }
  const second = { session: 'session-b' }
  assert.equal(resolver.effectiveProfile(first).id, 'dev')
  assert.deepEqual(resolver.handleMessage(first, userMessage('使用漫剧配置')), { kind: 'profile', profileId: 'drama' })
  assert.equal(resolver.effectiveProfile(first).id, 'drama')
  assert.equal(resolver.effectiveProfile(second).id, 'dev')
  assert.deepEqual(resolver.handleMessage(first, userMessage('恢复默认配置')), { kind: 'default' })
  assert.equal(resolver.effectiveProfile(first).id, 'dev')
})

test('profile resolver follows global updates and clears removed overrides', () => {
  const resolver = createProfileResolver(store)
  const agent = { session: 'session-a' }
  resolver.handleMessage(agent, userMessage('切换到漫剧配置'))
  assert.equal(resolver.effectiveProfile(agent).id, 'drama')
  resolver.update(normalizeSettingsStore({ profiles: [store.profiles[0]], globalProfileId: 'dev' }))
  assert.equal(resolver.overrideFor('session-a'), undefined)
  assert.equal(resolver.effectiveProfile(agent).id, 'dev')
})

test('natural-language profile commands only accept known profiles and user text', () => {
  assert.deepEqual(profileCommand(store, userMessage('请使用「漫剧配置」吧。')), { kind: 'profile', profileId: 'drama' })
  assert.deepEqual(profileCommand(store, userMessage('使用全局默认配置')), { kind: 'default' })
  assert.equal(profileCommand(store, userMessage('使用不存在配置')), undefined)
  assert.equal(profileCommand(store, { source: { kind: 'assistant' }, content: [{ type: 'text', text: '使用漫剧配置' }] }), undefined)
})

test('enabled models may preserve an unknown empty reasoning capability list', () => {
  const normalized = normalizeSettingsStore({
    profiles: [{ id: 'unknown', name: '未知推理档位', settings: { models: [{ ...model('unknown-model'), reasoningEfforts: [] }] } }],
    globalProfileId: 'unknown',
  })
  assert.deepEqual(normalized.profiles[0].settings.models[0].reasoningEfforts, [])
  assert.equal(normalized.profiles[0].settings.models[0].reasoningEffort, 'low')
})
