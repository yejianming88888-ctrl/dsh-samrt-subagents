// One-shot seed snippet. Loaded once per browser. After seeding it deletes
// itself from localStorage, so subsequent loads resume the normal flow.
//
// Copy into lib/client.js near the top of the factory body (after the
// initial declarations) and remove this comment block once you do not need
// to bootstrap data anymore.

function buildSeedStore() {
  const dev = SEED_PROFILES.dev
  const drama = SEED_PROFILES.drama
  const writing = SEED_PROFILES.writing
  return {
    profiles: [dev, drama, writing],
    activeId: dev.id,
    globalProfileId: dev.id
  }
}

async function seedOnce() {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return
  const flag = 'dsh-smart-subagent-orchestrator.seeded.v1'
  if (localStorage.getItem(flag) === '1') return
  const existing = safeRead()
  const store = buildSeedStore()
  try {
    safeWrite(store)
    localStorage.setItem(flag, '1')
    const response = await window.fetch(SETTINGS_ROUTE)
    if (!response.ok) throw new Error('settings route unavailable')
    const { descriptor } = await response.json()
    await window.fetch(SETTINGS_ROUTE, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        section: { profiles: store.profiles.map(toBackendStoreShape), globalProfileId: store.globalProfileId },
        expectedRevision: descriptor?.revision
      })
    })
  } catch (error) {
    console.error('[SmartSubagents] seed failed:', error)
  }
}