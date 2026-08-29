import { globalProfile } from './model-config.js'

function messageText(message) {
  if (message?.source?.kind !== 'user' || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function commandKey(value) {
  return String(value).normalize('NFKC').toLocaleLowerCase().replace(/[\s“”"'「」『』]/gu, '')
}

function profileCommand(store, message) {
  const input = messageText(message)
  if (input === '') return undefined
  const compact = commandKey(input).replace(/[。！!？?]$/u, '')
  if (/^(?:请)?(?:恢复默认配置|恢复全局默认(?:配置)?|使用默认配置|使用全局默认(?:配置)?)$/u.test(compact)) {
    return { kind: 'default' }
  }
  const match = input.match(/^\s*(?:请)?\s*(?:使用|启用|切换(?:到|为)?)\s*[“”"'「」『』]*\s*(.+?)\s*[“”"'「」『』]*\s*(?:吧)?[。！!？?]?\s*$/u)
  if (match === null) return undefined
  const requested = commandKey(match[1])
  const profile = store.profiles.find((entry) => commandKey(entry.name) === requested || commandKey(entry.id) === requested)
  return profile === undefined ? undefined : { kind: 'profile', profileId: profile.id }
}

function createProfileResolver(initialStore) {
  let store = initialStore
  const overrides = new Map()
  const effectiveProfile = (agent) => {
    const session = agent?.session
    const overrideId = session === undefined ? undefined : overrides.get(session)
    return store.profiles.find((entry) => entry.id === overrideId) ?? globalProfile(store)
  }
  return {
    get store() { return store },
    update(nextStore) {
      store = nextStore
      const valid = new Set(store.profiles.map((entry) => entry.id))
      for (const [session, profileId] of overrides) {
        if (!valid.has(profileId)) overrides.delete(session)
      }
    },
    effectiveProfile,
    effectiveSettings(agent) { return effectiveProfile(agent).settings },
    handleMessage(agent, message) {
      if (agent?.session === undefined) return undefined
      const command = profileCommand(store, message)
      if (command?.kind === 'default') overrides.delete(agent.session)
      else if (command?.kind === 'profile') overrides.set(agent.session, command.profileId)
      return command
    },
    disposeSession(session) { overrides.delete(session) },
    overrideFor(session) { return overrides.get(session) },
    clear() { overrides.clear() },
  }
}

export { createProfileResolver, messageText, profileCommand }
