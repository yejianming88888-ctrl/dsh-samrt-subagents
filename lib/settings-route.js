import { Buffer } from 'node:buffer'
import { generateRoutingSkill, skillContentForSettings } from './skill-generator.js'
import { globalProfile, normalizeSettingsStore } from './model-config.js'
import { scanModels } from './model-scanner.js'

const ROUTE = '/dsh-smart-subagent-orchestrator/settings'
const MAX_BODY = 256 * 1024

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function sameOrigin(req) {
  const host = req.headers.host
  const origin = req.headers.origin
  if (typeof host !== 'string') return false
  let hostname
  try { hostname = new URL(`http://${host}`).hostname } catch { return false }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) return false
  if (typeof origin === 'string') {
    try {
      const url = new URL(origin)
      return ['http:', 'https:'].includes(url.protocol) && url.host === host
    } catch { return false }
  }
  return req.headers['sec-fetch-site'] === 'same-origin'
}

function sendJson(res, code, body) {
  const text = JSON.stringify(body)
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', String(Buffer.byteLength(text)))
  res.end(text)
}

async function readBody(req) {
  req.setEncoding('utf8')
  let text = ''
  for await (const chunk of req) {
    text += chunk
    if (Buffer.byteLength(text) > MAX_BODY) throw new Error('settings body exceeds 256 KiB')
  }
  if (text.length === 0) throw new Error('settings body is required')
  return JSON.parse(text)
}

function view(settings) {
  const entry = settings.describe().find((item) => String(item.ns) === 'smart-subagent-orchestrator')
  if (entry === undefined) throw new Error('smart-subagent-orchestrator namespace is not registered')
  return { writable: settings.writable === true, descriptor: { value: entry.value, revision: entry.revision } }
}

async function handleCatalog(ctx) {
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('llm service is not available')
  const results = await scanModels(llm)
  return { providers: results, scannedAt: new Date().toISOString() }
}

function handleSkillPreview(ctx) {
  const entry = ctx.settings.describe().find((item) => String(item.ns) === 'smart-subagent-orchestrator')
  if (entry === undefined) throw new Error('smart-subagent-orchestrator namespace is not registered')
  if (entry.value === undefined) throw new Error('smart-subagent-orchestrator settings value is undefined')
  const profile = globalProfile(normalizeSettingsStore(entry.value))
  return {
    skill: 'smart-subagent-orchestration',
    name: 'smart-subagent-orchestration',
    description: 'Plan work and route delegated tasks across the user-enabled subagent models.',
    whenToUse: 'Use when planning work, delegating tasks, choosing a subagent model, or coordinating multiple agents.',
    generatedAt: new Date().toISOString(),
    profileId: profile.id,
    profileName: profile.name,
    customized: typeof profile.settings.customSkill === 'string' && profile.settings.customSkill.trim() !== '',
    generatedContent: generateRoutingSkill(profile.settings),
    content: skillContentForSettings(profile.settings),
  }
}

function handleGenerateSkillFromDraft(draft) {
  // draft is the current form state, not the saved settings
  const enabled = Array.isArray(draft.models) ? draft.models.filter((model) => model.enabled) : []
  if (enabled.length === 0) {
    return { error: '请先配置模型' }
  }
  return {
    generatedContent: generateRoutingSkill(draft),
    content: typeof draft.customSkill === 'string' && draft.customSkill.trim() !== '' ? draft.customSkill : generateRoutingSkill(draft),
    customized: typeof draft.customSkill === 'string' && draft.customSkill.trim() !== '',
  }
}

function registerSettingsRoute(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return undefined
  return webServer.register({
    kind: 'exact', path: ROUTE,
    async handler(req, res) {
      if (!isLoopback(req.socket?.remoteAddress)) { sendJson(res, 403, { error: 'loopback only' }); return }
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
      const action = url.searchParams.get('action')
      if (req.method === 'GET' && action === 'catalog') {
        try { sendJson(res, 200, await handleCatalog(ctx)) } catch (e) { sendJson(res, 500, { error: e.message }) }
        return
      }
      if (req.method === 'GET' && action === 'skill-preview') {
        try { sendJson(res, 200, handleSkillPreview(ctx)) } catch (e) { sendJson(res, 500, { error: e.message }) }
        return
      }
      if (req.method === 'POST' && action === 'generate-skill-from-draft') {
        try {
          const body = await readBody(req)
          const result = handleGenerateSkillFromDraft(body)
          if (result.error) { sendJson(res, 400, { error: result.error }) }
          else { sendJson(res, 200, result) }
        } catch (e) { sendJson(res, 500, { error: e.message }) }
        return
      }
      if (req.method === 'GET') { try { sendJson(res, 200, view(ctx.settings)) } catch (e) { sendJson(res, 500, { error: e.message }) } return }
      if (req.method !== 'PUT') { res.setHeader('allow', 'GET, PUT'); sendJson(res, 405, { error: 'method not allowed' }); return }
      if (!sameOrigin(req)) { sendJson(res, 403, { error: 'same-origin required' }); return }
      if (typeof req.headers['content-type'] !== 'string' || !req.headers['content-type'].toLowerCase().startsWith('application/json')) { sendJson(res, 415, { error: 'application/json required' }); return }
      try {
        const body = await readBody(req)
        if (typeof body.section !== 'object' || body.section === null || Array.isArray(body.section)) throw new Error('section object required')
        const section = normalizeSettingsStore(body.section)
        await ctx.settings.replace('smart-subagent-orchestrator', section, body.expectedRevision)
        sendJson(res, 200, view(ctx.settings))
      } catch (error) {
        const code = error instanceof SyntaxError ? 400 : error?.name === 'SettingsConflictError' ? 409 : 400
        sendJson(res, code, { error: error.message })
      }
    },
  })
}

export { ROUTE, registerSettingsRoute, handleGenerateSkillFromDraft }