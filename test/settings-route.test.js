import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import { registerSettingsRoute, ROUTE, handleGenerateSkillFromDraft } from '../lib/settings-route.js'
import { normalizeSettingsStore } from '../lib/model-config.js'

const SETTINGS_NAMESPACE = 'smart-subagent-orchestrator'

function createSettingsContext(initial = {}) {
  const settingsList = [{ ns: SETTINGS_NAMESPACE, value: initial, revision: 0 }]
  let settingsWatcher
  const mockLlm = {
    listProviders() {
      return [
        { id: 'provider-a', name: 'Provider A' },
        { id: 'provider-b', name: 'Provider B' },
      ]
    },
    async listModels(providerId) {
      if (providerId === 'provider-a') {
        return [
          { id: 'model-a1', name: 'Model A1', description: 'Fast model', inputModalities: ['text', 'image'] },
          { id: 'model-a2', name: 'Model A2' },
        ]
      }
      if (providerId === 'provider-b') {
        return [
          { id: 'model-b1', name: 'Model B1', description: 'Complex reasoning', inputModalities: ['text'] },
        ]
      }
      return []
    },
  }

  // A single shared webServer per context so we can call its _handler directly
  const mockWebServer = {
    _handler: null,
    register(opts) {
      this._handler = opts.handler
      return () => { this._handler = null }
    },
  }

  const settingsService = {
    writable: true,
    describe() { return settingsList },
    register() {
      return {
        get() { return settingsList[0].value },
        async replace(next) { settingsList[0] = { ns: SETTINGS_NAMESPACE, value: next, revision: settingsList[0].revision + 1 } },
        watch(callback) { settingsWatcher = callback; return () => { settingsWatcher = undefined } },
      }
    },
    async replace(ns, value, expectedRevision) {
      settingsService.lastReplace = { ns, value, expectedRevision }
      settingsService.lastUpdate = { ns, value, expectedRevision }
      const entry = settingsList.find((item) => String(item.ns) === String(ns))
      if (entry) {
        entry.value = value
        entry.revision = (expectedRevision !== undefined ? expectedRevision : entry.revision) + 1
      }
    },
    async update(ns, value, expectedRevision) {
      settingsService.lastReplace = { ns, value, expectedRevision }
      settingsService.lastUpdate = { ns, value, expectedRevision }
      return this.replace(ns, value, expectedRevision)
    },
  }

  // ctx uses direct .settings property (not ctx.get('settings'))
  const ctx = {
    settings: settingsService,
    get(name) {
      if (name === 'webServer') return mockWebServer
      if (name === 'llm') return mockLlm
      if (name === 'settings') return settingsService
      return undefined
    },
    effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {} },
    logger: { info() {}, warn() {}, error() {} },
    on() { return () => {} },
  }

  return { ctx, mockWebServer, settingsList }
}

function createMockReq(method, url, headers = {}) {
  return {
    method,
    url,
    headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
  }
}

function createMockRes() {
  const headers = {}
  let statusCode = 200
  let body = ''
  return {
    get statusCode() { return statusCode },
    set statusCode(v) { statusCode = v },
    setHeader(name, value) { headers[name] = value },
    getHeader(name) { return headers[name] },
    end(b) { if (b !== undefined) body = b },
    get _body() { return body },
    get _headers() { return headers },
  }
}

function parseJsonResponse(res) {
  const contentType = res.getHeader('content-type')
  assert.ok(contentType?.startsWith('application/json'), `expected json but got ${contentType}`)
  return JSON.parse(res._body)
}

test('ROUTE constant equals expected path', () => {
  assert.strictEqual(ROUTE, '/dsh-smart-subagent-orchestrator/settings')
})

test('registerSettingsRoute returns an unregister function', () => {
  const { ctx } = createSettingsContext()
  const unregister = registerSettingsRoute(ctx)
  assert.strictEqual(typeof unregister, 'function')
})

test('GET /settings returns writable and descriptor', async () => {
  const { ctx, mockWebServer } = createSettingsContext({ mode: 'automatic', models: [] })
  registerSettingsRoute(ctx)
  const req = createMockReq('GET', '/dsh-smart-subagent-orchestrator/settings')
  const res = createMockRes()
  await mockWebServer._handler(req, res)
  const parsed = parseJsonResponse(res)
  assert.strictEqual(parsed.writable, true)
  assert.ok(parsed.descriptor, 'should have descriptor')
  assert.strictEqual(parsed.descriptor.revision, 0)
})

test('GET /settings?action=catalog returns provider model list', async () => {
  const { ctx, mockWebServer } = createSettingsContext()
  registerSettingsRoute(ctx)
  const req = createMockReq('GET', '/dsh-smart-subagent-orchestrator/settings?action=catalog')
  const res = createMockRes()
  await mockWebServer._handler(req, res)
  const parsed = parseJsonResponse(res)
  assert.ok(Array.isArray(parsed.providers), 'providers should be an array')
  assert.strictEqual(parsed.providers.length, 2)
  assert.strictEqual(parsed.providers[0].id, 'provider-a')
  assert.strictEqual(parsed.providers[0].name, 'Provider A')
  assert.strictEqual(parsed.providers[0].models.length, 2)
  assert.strictEqual(parsed.providers[0].models[0].id, 'model-a1')
  assert.strictEqual(parsed.providers[0].models[0].name, 'Model A1')
  assert.strictEqual(parsed.providers[0].models[0].description, 'Fast model')
  assert.deepEqual(parsed.providers[0].models[0].inputModalities, ['text', 'image'])
  assert.strictEqual(parsed.providers[1].id, 'provider-b')
  assert.ok(parsed.scannedAt, 'should have scannedAt timestamp')
})

test('GET /settings?action=skill-preview returns generated skill', async () => {
  const { ctx, mockWebServer } = createSettingsContext({
    mode: 'automatic',
    planningMode: 'main-agent',
    models: [
      { alias: 'fast', provider: 'p', model: 'm', purpose: 'Quick tasks', tags: ['fast'], enabled: true },
    ],
  })
  registerSettingsRoute(ctx)
  const req = createMockReq('GET', '/dsh-smart-subagent-orchestrator/settings?action=skill-preview')
  const res = createMockRes()
  await mockWebServer._handler(req, res)
  const parsed = parseJsonResponse(res)
  assert.strictEqual(parsed.skill, 'smart-subagent-orchestration')
  assert.strictEqual(parsed.name, 'smart-subagent-orchestration')
  assert.ok(parsed.description)
  assert.ok(parsed.whenToUse)
  assert.ok(parsed.generatedAt)
  assert.ok(typeof parsed.content === 'string', 'content should be a string')
  assert.match(parsed.content, /Smart Subagent Orchestration/)
  assert.match(parsed.content, /`fast`/)
})

test('handleGenerateSkillFromDraft returns error when no enabled models', () => {
  const result = handleGenerateSkillFromDraft({
    mode: 'automatic',
    planningMode: 'main-agent',
    models: [
      { alias: 'fast', provider: 'p', model: 'm', purpose: 'Quick tasks', enabled: false },
    ],
  })
  assert.strictEqual(result.error, '请先配置模型')
})

test('handleGenerateSkillFromDraft generates skill when models are enabled', () => {
  const result = handleGenerateSkillFromDraft({
    mode: 'automatic',
    planningMode: 'main-agent',
    customSkill: '',
    plannerAlias: '',
    requirePlanConfirmation: true,
    subagentProvider: 'spawn',
    maxDepth: 1,
    foregroundTimeoutMs: 120000,
    idleTimeoutMs: 60000,
    maxConcurrentSubagents: 3,
    enableBackground: true,
    showSelectionReason: true,
    models: [
      { alias: 'fast', provider: 'p', model: 'm', purpose: 'Quick tasks', tags: ['fast'], enabled: true, allowPlanning: true, allowExecution: true },
    ],
  })
  assert.ok(typeof result.generatedContent === 'string', 'generatedContent should be a string')
  assert.strictEqual(result.customized, false)
  assert.match(result.generatedContent, /Smart Subagent Orchestration/)
  assert.match(result.generatedContent, /`fast`/)
})

test('handleGenerateSkillFromDraft uses customSkill when provided', () => {
  const result = handleGenerateSkillFromDraft({
    mode: 'automatic',
    planningMode: 'main-agent',
    customSkill: '# My Custom Skill\n\nUse this exactly.',
    plannerAlias: '',
    requirePlanConfirmation: true,
    subagentProvider: 'spawn',
    maxDepth: 1,
    foregroundTimeoutMs: 120000,
    idleTimeoutMs: 60000,
    maxConcurrentSubagents: 3,
    enableBackground: true,
    showSelectionReason: true,
    models: [
      { alias: 'fast', provider: 'p', model: 'm', purpose: 'Quick tasks', tags: ['fast'], enabled: true, allowPlanning: true, allowExecution: true },
    ],
  })
  assert.strictEqual(result.customized, true)
  assert.strictEqual(result.content, '# My Custom Skill\n\nUse this exactly.')
})

test('handleGenerateSkillFromDraft returns error for empty models array', () => {
  const result = handleGenerateSkillFromDraft({
    mode: 'automatic',
    planningMode: 'main-agent',
    models: [],
  })
  assert.strictEqual(result.error, '请先配置模型')
})

test('handleGenerateSkillFromDraft returns error when models is undefined', () => {
  const result = handleGenerateSkillFromDraft({
    mode: 'automatic',
    planningMode: 'main-agent',
  })
  assert.strictEqual(result.error, '请先配置模型')
})

test('GET /settings?action=skill-preview returns saved custom Skill and generated fallback', async () => {
  const customSkill = '# Saved custom Skill\n\nUse this exact text.'
  const { ctx, mockWebServer } = createSettingsContext({ customSkill, models: [] })
  registerSettingsRoute(ctx)
  const req = createMockReq('GET', '/dsh-smart-subagent-orchestrator/settings?action=skill-preview')
  const res = createMockRes()
  await mockWebServer._handler(req, res)
  const parsed = parseJsonResponse(res)
  assert.strictEqual(parsed.customized, true)
  assert.strictEqual(parsed.content, customSkill)
  assert.notStrictEqual(parsed.generatedContent, customSkill)

  ctx.settings.describe()[0].value.customSkill = '  \n  '
  const fallbackRes = createMockRes()
  await mockWebServer._handler(req, fallbackRes)
  const fallback = parseJsonResponse(fallbackRes)
  assert.strictEqual(fallback.customized, false)
  assert.strictEqual(fallback.content, fallback.generatedContent)
})

test('GET /settings?action=catalog returns error when llm is unavailable', async () => {
  const { ctx, mockWebServer } = createSettingsContext()
  // Replace llm getter to return undefined
  const badCtx = {
    get(name) {
      if (name === 'webServer') return mockWebServer
      if (name === 'llm') return undefined
      return ctx.get(name)
    },
  }
  registerSettingsRoute(badCtx)
  const req = createMockReq('GET', '/dsh-smart-subagent-orchestrator/settings?action=catalog')
  const res = createMockRes()
  await mockWebServer._handler(req, res)
  assert.strictEqual(res.statusCode, 500)
  const parsed = parseJsonResponse(res)
  assert.ok(parsed.error, 'should have error message')
})

test('PUT /settings rejects non-loopback request', async () => {
  const { ctx, mockWebServer } = createSettingsContext()
  registerSettingsRoute(ctx)
  const req = {
    method: 'PUT',
    url: '/dsh-smart-subagent-orchestrator/settings',
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json', origin: 'http://127.0.0.1:3080' },
    socket: { remoteAddress: '203.0.113.1' },
  }
  const res = createMockRes()
  await mockWebServer._handler(req, res)
  assert.strictEqual(res.statusCode, 403)
})

test('GET /settings returns 405 for non-GET/PUT', async () => {
  const { ctx, mockWebServer } = createSettingsContext()
  registerSettingsRoute(ctx)
  const req = createMockReq('POST', '/dsh-smart-subagent-orchestrator/settings')
  const res = createMockRes()
  await mockWebServer._handler(req, res)
  assert.strictEqual(res.statusCode, 405)
  const parsed = parseJsonResponse(res)
  assert.ok(parsed.error)
})

test('PUT /settings successfully updates settings via loopback', async () => {
  const { ctx, mockWebServer } = createSettingsContext({ mode: 'manual', models: [] })
  registerSettingsRoute(ctx)

  const bodyObj = {
    section: {
      mode: 'automatic',
      models: []
    },
    expectedRevision: 1
  }

  const req = Readable.from([JSON.stringify(bodyObj)])
  req.method = 'PUT'
  req.url = '/dsh-smart-subagent-orchestrator/settings'
  req.headers = {
    host: '127.0.0.1:3080',
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json'
  }
  req.socket = { remoteAddress: '127.0.0.1' }

  const res = createMockRes()
  await mockWebServer._handler(req, res)

  assert.strictEqual(res.statusCode, 200)

  // Verify settings.update (replace) was called with correct parameters
  assert.ok(ctx.settings.lastUpdate, 'should call settings.update')
  assert.strictEqual(ctx.settings.lastUpdate.ns, 'smart-subagent-orchestrator')
  assert.deepEqual(ctx.settings.lastUpdate.value, normalizeSettingsStore(bodyObj.section))
  assert.strictEqual(ctx.settings.lastUpdate.expectedRevision, bodyObj.expectedRevision)

  // Verify response body
  const parsed = parseJsonResponse(res)
  assert.strictEqual(parsed.writable, true)
  assert.ok(parsed.descriptor, 'should have descriptor')
  assert.deepEqual(parsed.descriptor.value, normalizeSettingsStore(bodyObj.section))
})

test('PUT /settings with new settings updates and returns success', async () => {
  const { ctx, mockWebServer } = createSettingsContext({ mode: 'automatic', models: [] })
  registerSettingsRoute(ctx)

  const bodyObj = {
    section: {
      mode: 'ask',
      models: [
        { alias: 'test-model', provider: 'test-provider', model: 'test-model-id', purpose: 'Test execution', enabled: true }
      ]
    },
    expectedRevision: 0
  }

  const req = Readable.from([JSON.stringify(bodyObj)])
  req.method = 'PUT'
  req.url = '/dsh-smart-subagent-orchestrator/settings'
  req.headers = {
    host: '127.0.0.1:3080',
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json'
  }
  req.socket = { remoteAddress: '127.0.0.1' }

  const res = createMockRes()
  await mockWebServer._handler(req, res)

  assert.strictEqual(res.statusCode, 200)

  // Verify settings.update was called with correct parameters
  assert.ok(ctx.settings.lastUpdate, 'should call settings.update')
  assert.strictEqual(ctx.settings.lastUpdate.ns, 'smart-subagent-orchestrator')
  assert.deepEqual(ctx.settings.lastUpdate.value, normalizeSettingsStore(bodyObj.section))
  assert.strictEqual(ctx.settings.lastUpdate.expectedRevision, bodyObj.expectedRevision)

  // Verify response body contains writable and descriptor
  const parsed = parseJsonResponse(res)
  assert.strictEqual(parsed.writable, true)
  assert.ok(parsed.descriptor, 'should have descriptor')
  assert.deepEqual(parsed.descriptor.value, normalizeSettingsStore(bodyObj.section))
})

test('PUT /settings loopback success verification', async () => {
  const { ctx, mockWebServer } = createSettingsContext({ mode: 'automatic', models: [] })
  registerSettingsRoute(ctx)

  const bodyObj = {
    section: {
      mode: 'automatic',
      models: [
        { alias: 'fast-model', provider: 'provider-a', model: 'model-a1', purpose: 'Fast execution', enabled: true }
      ]
    },
    expectedRevision: 0
  }

  const req = Readable.from([JSON.stringify(bodyObj)])
  req.method = 'PUT'
  req.url = '/dsh-smart-subagent-orchestrator/settings'
  req.headers = {
    host: '127.0.0.1:3080',
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json'
  }
  req.socket = { remoteAddress: '127.0.0.1' }

  const res = createMockRes()
  await mockWebServer._handler(req, res)

  assert.strictEqual(res.statusCode, 200)

  // Verify settings.update was called with correct parameters
  assert.ok(ctx.settings.lastUpdate, 'should call settings.update')
  assert.strictEqual(ctx.settings.lastUpdate.ns, 'smart-subagent-orchestrator')
  assert.deepEqual(ctx.settings.lastUpdate.value, normalizeSettingsStore(bodyObj.section))
  assert.strictEqual(ctx.settings.lastUpdate.expectedRevision, bodyObj.expectedRevision)

  // Verify response body contains writable and descriptor
  const parsed = parseJsonResponse(res)
  assert.strictEqual(parsed.writable, true)
  assert.ok(parsed.descriptor, 'should have descriptor')
  assert.deepEqual(parsed.descriptor.value, normalizeSettingsStore(bodyObj.section))
})

test('Skill Preview flow: auto-generated changes, customSkill saves, and restores auto', async () => {
  const { ctx, mockWebServer } = createSettingsContext({
    mode: 'automatic',
    models: [{ alias: 'fast', provider: 'p', model: 'm1', purpose: 'Quick tasks', tags: ['fast'], enabled: true }],
  })
  registerSettingsRoute(ctx)

  const req = createMockReq('GET', '/dsh-smart-subagent-orchestrator/settings?action=skill-preview')

  // 1. Initial auto-generated skill preview
  const res1 = createMockRes()
  await mockWebServer._handler(req, res1)
  const parsed1 = parseJsonResponse(res1)
  assert.strictEqual(parsed1.customized, false)
  assert.match(parsed1.content, /`fast`/)

  // 2. Auto-generated content changes when settings change (e.g. disabling the model)
  ctx.settings.describe()[0].value.models[0].enabled = false
  const res2 = createMockRes()
  await mockWebServer._handler(req, res2)
  const parsed2 = parseJsonResponse(res2)
  assert.match(parsed2.content, /No models are enabled/)

  // 3. Custom skill saved overrides preview
  const customText = '# Custom skill body text'
  ctx.settings.describe()[0].value.customSkill = customText
  const res3 = createMockRes()
  await mockWebServer._handler(req, res3)
  const parsed3 = parseJsonResponse(res3)
  assert.strictEqual(parsed3.customized, true)
  assert.strictEqual(parsed3.content, customText)

  // 4. Clearing custom skill restores auto-generated content
  ctx.settings.describe()[0].value.customSkill = ''
  const res4 = createMockRes()
  await mockWebServer._handler(req, res4)
  const parsed4 = parseJsonResponse(res4)
  assert.strictEqual(parsed4.customized, false)
  assert.match(parsed4.content, /No models are enabled/)
})
