const ALIAS_RE = /^[a-z0-9][a-z0-9_-]*$/
const TAG_RE = /^[a-z0-9][a-z0-9-]*$/
const REASONING_EFFORT_RE = /^(low|medium|high)$/

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`)
  return value.trim()
}

function normalizeModels(input = []) {
  if (!Array.isArray(input)) throw new Error('models must be an array')
  const aliases = new Set()
  return input.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error(`models[${index}] must be an object`)
    const alias = text(entry.alias, `models[${index}].alias`)
    if (!ALIAS_RE.test(alias)) throw new Error(`models[${index}].alias is invalid`)
    if (aliases.has(alias)) throw new Error(`duplicate model alias "${alias}"`)
    aliases.add(alias)
    const tags = [...new Set((entry.tags ?? []).map((tag) => text(tag, `models[${index}].tags`)))]
    if (tags.some((tag) => !TAG_RE.test(tag))) throw new Error(`models[${index}].tags must be lowercase kebab-case`)
    const maxTokens = entry.maxTokens
    if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)) throw new Error(`models[${index}].maxTokens must be a positive integer`)
    const reasoningEfforts = Array.isArray(entry.reasoningEfforts)
      ? [...new Set(entry.reasoningEfforts.filter((effort) => REASONING_EFFORT_RE.test(effort)))]
      : ['low', 'medium', 'high']
    let reasoningEffort = entry.reasoningEffort
    if (reasoningEfforts.length > 0) {
      if (reasoningEffort === undefined || !reasoningEfforts.includes(reasoningEffort)) {
        reasoningEffort = reasoningEfforts[0]
      }
    } else {
      reasoningEffort = 'low'
    }
    if (!REASONING_EFFORT_RE.test(reasoningEffort)) throw new Error(`models[${index}].reasoningEffort must be low, medium, or high`)
    const enabled = entry.enabled !== false
    return {
      alias,
      provider: text(entry.provider, `models[${index}].provider`),
      model: text(entry.model, `models[${index}].model`),
      displayName: typeof entry.displayName === 'string' && entry.displayName.trim() ? entry.displayName.trim() : alias,
      purpose: text(entry.purpose, `models[${index}].purpose`),
      tags,
      enabled,
      allowPlanning: entry.allowPlanning !== false,
      allowExecution: entry.allowExecution !== false,
      ...(maxTokens === undefined ? {} : { maxTokens }),
      reasoningEffort,
      reasoningEfforts,
    }
  })
}

function normalizeProfileSettings(value = {}) {
  const mode = value.mode ?? 'automatic'
  if (!['automatic', 'ask'].includes(mode)) throw new Error('mode must be automatic or ask')
  const planningMode = value.planningMode ?? 'main-agent'
  if (!['main-agent', 'automatic', 'fixed', 'ask'].includes(planningMode)) throw new Error('planningMode is invalid')
  const maxDepth = value.maxDepth ?? 1
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) throw new Error('maxDepth must be a non-negative integer')
  const foregroundTimeoutMs = value.foregroundTimeoutMs ?? 120000
  if (!Number.isSafeInteger(foregroundTimeoutMs) || foregroundTimeoutMs <= 0) throw new Error('foregroundTimeoutMs must be a positive integer')
  const idleTimeoutMs = value.idleTimeoutMs ?? 60000
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0) throw new Error('idleTimeoutMs must be a positive integer')
  const maxConcurrentSubagents = value.maxConcurrentSubagents ?? 3
  if (!Number.isSafeInteger(maxConcurrentSubagents) || maxConcurrentSubagents <= 0) throw new Error('maxConcurrentSubagents must be a positive integer')
  return {
    mode,
    planningMode,
    customSkill: typeof value.customSkill === 'string' ? value.customSkill : '',
    plannerAlias: typeof value.plannerAlias === 'string' ? value.plannerAlias.trim() : '',
    requirePlanConfirmation: value.requirePlanConfirmation !== false,
    subagentProvider: typeof value.subagentProvider === 'string' && value.subagentProvider.trim() ? value.subagentProvider.trim() : 'spawn',
    maxDepth,
    foregroundTimeoutMs,
    idleTimeoutMs,
    maxConcurrentSubagents,
    enableBackground: value.enableBackground !== false,
    showSelectionReason: value.showSelectionReason !== false,
    models: normalizeModels(value.models ?? []),
  }
}

function normalizeSettings(value = {}) {
  return normalizeProfileSettings(value)
}

function isSettingsStore(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Array.isArray(value.profiles)
}

function normalizeProfile(entry, index) {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error(`profiles[${index}] must be an object`)
  const id = text(entry.id, `profiles[${index}].id`)
  const name = text(entry.name, `profiles[${index}].name`)
  const source = entry.settings ?? entry
  return { id, name, settings: normalizeProfileSettings(source) }
}

function normalizeSettingsStore(value = {}) {
  if (!isSettingsStore(value)) {
    const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : '默认配置'
    return {
      profiles: [{ id: 'default', name, settings: normalizeProfileSettings(value) }],
      globalProfileId: 'default',
    }
  }
  if (value.profiles.length === 0) throw new Error('profiles must contain at least one profile')
  const profiles = value.profiles.map(normalizeProfile)
  const ids = new Set()
  for (const profile of profiles) {
    if (ids.has(profile.id)) throw new Error(`duplicate profile id "${profile.id}"`)
    ids.add(profile.id)
  }
  const globalProfileId = text(value.globalProfileId, 'globalProfileId')
  if (!ids.has(globalProfileId)) throw new Error(`globalProfileId "${globalProfileId}" does not reference a profile`)
  return { profiles, globalProfileId }
}

function globalProfile(store) {
  const profile = store.profiles.find((entry) => entry.id === store.globalProfileId)
  if (profile === undefined) throw new Error(`globalProfileId "${store.globalProfileId}" does not reference a profile`)
  return profile
}

export { globalProfile, isSettingsStore, normalizeModels, normalizeProfileSettings, normalizeSettings, normalizeSettingsStore }
