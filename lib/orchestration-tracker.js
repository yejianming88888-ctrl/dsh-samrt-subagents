const EARLY_SETTLEMENT_LIMIT = 1000

function classifyStopReason(reason, message = '') {
  const value = String(reason ?? '').toLowerCase()
  const text = String(message).toLowerCase()
  if (value === 'timeout' || text.includes('timeout')) return 'timeout'
  if (value === 'aborted' || value === 'interrupted' || value === 'cancelled') return 'cancelled'
  if (value.includes('auth') || text.includes('unauthoriz') || text.includes('forbidden')) return 'auth'
  if (value.includes('transport') || text.includes('network')) return 'transport'
  if (value.includes('protocol') || text.includes('protocol')) return 'protocol'
  return value === 'completed' ? undefined : 'model-error'
}

function abortReason(signal) {
  return signal.reason instanceof Error ? signal.reason : new Error('orchestration tracker was cancelled')
}

function interruptChild(ctx, parent, childId) {
  const interrupt = ctx.subagents?.interrupt
  if (typeof interrupt !== 'function') return { status: 'unavailable', diagnostic: 'subagent interrupt API is unavailable; child may still be running' }
  try {
    const result = interrupt.call(ctx.subagents, childId, { kind: 'ancestor', agent: parent })
    if (result && typeof result.then === 'function') {
      result.catch(() => {})
    }
    return { status: 'requested' }
  } catch (error) {
    return { status: 'failed', diagnostic: `subagent interrupt failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

const MAX_SETTLEMENT_TEXT = 256 * 1024
function boundedAssistantMessage(output) {
  if (!Array.isArray(output)) return []
  let remaining = MAX_SETTLEMENT_TEXT
  return output.slice(0, 256).map((block) => {
    if (!block || typeof block !== 'object' || typeof block.text !== 'string') return block
    const text = block.text.slice(0, Math.max(0, remaining))
    remaining -= text.length
    return text.length === block.text.length ? block : { ...block, text, truncated: true }
  })
}

async function awaitWithSignal(promise, signal, timeoutMs) {
  if (signal?.aborted) throw abortReason(signal)
  let timer
  let cleanup = () => {}
  const guards = []
  if (signal) guards.push(new Promise((_, reject) => {
    const onAbort = () => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    cleanup = () => signal.removeEventListener('abort', onAbort)
  }))
  if (timeoutMs !== undefined) guards.push(new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`subagent settlement timed out after ${timeoutMs}ms`), { code: 'timeout', stopReason: 'timeout' })), timeoutMs)
  }))
  try { return await Promise.race([promise, ...guards]) } finally { cleanup(); if (timer !== undefined) clearTimeout(timer) }
}

function createOrchestrationTracker(ctx) {
  const states = new Map()
  const byChild = new Map()
  const earlySettlements = new Map()
  const startTimes = new Map()
  let startsInFlight = 0

  const ensureState = (parent) => {
    let state = states.get(parent)
    if (!state) { state = { children: new Map(), starting: 0, waiters: new Set(), waiting: 0, disposed: false }; states.set(parent, state) }
    return state
  }
  const notify = (state) => { for (const resolve of state.waiters) resolve(); state.waiters.clear() }
  const prune = (parent, state) => {
    if (state.starting === 0 && state.children.size === 0 && state.waiting === 0 && !state.disposed && states.get(parent) === state) states.delete(parent)
  }
  // A start time is owned by a formal record only once track() adopts it. While it
  // still backs an early-cache entry it must survive, so it is dropped only when
  // neither a record nor an early settlement refers to the child any more.
  const releaseStartTime = (childId) => {
    if (byChild.has(childId)) return
    if (earlySettlements.has(childId)) return
    startTimes.delete(childId)
  }
  // An end that arrives before track() is always retained. A start can be in flight
  // in any caller (smart_delegate brackets it with begin()/finish(), run_plan awaits
  // startBackground), and the event carries no hint about which. Dropping it would
  // strand the child as permanently "running", so retention is unconditional and the
  // cache is instead kept finite by a bounded LRU.
  const rememberEarly = (info) => {
    // The first end wins: a duplicate end never overwrites the recorded outcome.
    if (earlySettlements.has(info.id)) return
    if (earlySettlements.size >= EARLY_SETTLEMENT_LIMIT) {
      const oldestKey = earlySettlements.keys().next().value
      if (oldestKey !== undefined) {
        earlySettlements.delete(oldestKey)
        if (!byChild.has(oldestKey)) startTimes.delete(oldestKey)
      }
    }
    const endedAt = new Date().toISOString()
    // Anchor a start time so a settlement later built from this cache entry can
    // never report a negative duration when track() arrives after the end.
    if (!startTimes.has(info.id)) startTimes.set(info.id, endedAt)
    earlySettlements.set(info.id, { ...info, endedAt })
  }
  const settle = (record, info) => {
    if (record.settlement !== undefined) return
    const endedAt = info.endedAt ?? new Date().toISOString()
    const durationMs = Math.max(0, new Date(endedAt).getTime() - new Date(record.startedAt).getTime())
    record.settlement = {
      subagentId: record.subagentId,
      label: record.label,
      stopReason: String(info.stopReason ?? 'error'),
      output: boundedAssistantMessage(info.lastAssistantMessage),
      endedAt,
      durationMs
    }
    if (info.interrupt !== undefined) record.settlement.interrupt = info.interrupt
    const failureType = classifyStopReason(info.stopReason, info.errorMessage)
    if (failureType !== undefined) record.settlement.failureType = failureType
    if (typeof info.errorMessage === 'string') record.settlement.error = info.errorMessage.slice(0, 4096)
    record.resolve(record.settlement)
    notify(record.state)
  }
  const track = (parent, childId, label) => {
    const state = ensureState(parent)
    let record = state.children.get(childId)
    if (!record) {
      let resolve
      const settled = new Promise((done) => { resolve = done })
      const startedAt = startTimes.get(childId) ?? new Date().toISOString()
      startTimes.set(childId, startedAt)
      record = { subagentId: childId, label, resolve, settled, settlement: undefined, state, parent, stopRequested: false, startedAt }
      state.children.set(childId, record)
      byChild.set(childId, record)
      const early = earlySettlements.get(childId)
      if (early) { earlySettlements.delete(childId); settle(record, early) }
    } else if (label !== undefined) record.label = label
    return record
  }

  ctx.on('subagent/start', (info) => {
    if (!startTimes.has(info.id)) {
      startTimes.set(info.id, new Date().toISOString())
    }
    const agents = ctx.get('agents')
    const child = agents?.get(info.id)
    const descriptor = child?.session?.events?.findLast?.((event) => event.type === 'subagent/descriptor')?.data
    if (descriptor?.mode === 'continuable') {
      track(info.parent ?? info.runId ?? descriptor.parent, info.id, descriptor.label ?? descriptor.task)
    }
  })
  ctx.on('subagent/end', (info) => {
    const record = byChild.get(info.id)
    if (record) settle(record, info)
    else rememberEarly(info)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const state = states.get(agent)
    if (!state) return
    state.disposed = true
    // Only this parent's in-flight starts are cancelled. Other parents keep their
    // own counters, and the shared early cache is left intact because entries in it
    // may belong to children of a parent that is still alive.
    startsInFlight = Math.max(0, startsInFlight - state.starting)
    state.starting = 0
    for (const record of state.children.values()) {
      settle(record, { stopReason: 'aborted', lastAssistantMessage: [] })
      if (byChild.get(record.subagentId) === record) byChild.delete(record.subagentId)
      startTimes.delete(record.subagentId)
    }
    // A caller already inside wait() must still receive the settlements produced by
    // this disposal, so the children are handed to it rather than dropped. Clearing
    // them here made the waiter re-read an empty set and return nothing, losing every
    // "aborted" outcome the parent needed in order to report what it had dispatched.
    if (state.waiting > 0) state.disposedChildren = [...state.children.values()]
    state.children.clear()
    states.delete(agent)
    notify(state)
  })

  const removeRecords = (state, records) => {
    for (const record of records) {
      if (state.children.get(record.subagentId) === record) state.children.delete(record.subagentId)
      if (byChild.get(record.subagentId) === record) byChild.delete(record.subagentId)
      releaseStartTime(record.subagentId)
    }
  }
  // waitAllStarting is true only on the "wait for everything this parent owns" path,
  // where a start that has not produced a child record yet must still be awaited.
  // Waiting on an explicit id list never blocks on unrelated in-flight starts, so a
  // caller can await children it already dispatched without deadlocking against its
  // own begin()/finish() bracket.
  const waitRecords = async (parent, initialRecords, signal, timeoutMs, waitAllStarting) => {
    const state = ensureState(parent)
    let records = initialRecords
    state.waiting += 1
    try {
      const pending = () => (waitAllStarting && state.starting > 0) || records.some((record) => record.settlement === undefined)
      while (pending()) {
        let resolveChange
        const changed = new Promise((resolve) => { resolveChange = resolve; state.waiters.add(resolve) })
        try { await awaitWithSignal(changed, signal, timeoutMs) } catch (error) {
          if (error?.code !== 'timeout') throw error
          for (const record of records) if (record.settlement === undefined) {
            const interrupt = interruptChild(ctx, parent, record.subagentId)
            record.stopRequested = true
            settle(record, { stopReason: 'timeout', lastAssistantMessage: [], interrupt })
          }
          if (waitAllStarting && state.starting > 0) throw error
          break
        } finally { state.waiters.delete(resolveChange) }
        // A start that completed during the wait adds a child this caller must also
        // await, so the "wait for everything" path re-reads the live child set. A
        // disposal hands over the children it just settled, because they are no
        // longer reachable through state.children.
        if (waitAllStarting) {
          const handedOver = state.disposedChildren
          if (handedOver !== undefined) {
            state.disposedChildren = undefined
            const seen = new Set(records.map((record) => record.subagentId))
            records = [...records, ...handedOver.filter((record) => !seen.has(record.subagentId))]
          } else {
            records = [...state.children.values()]
          }
        }
      }
      const result = records.map((record) => record.settlement)
      removeRecords(state, records)
      return result
    } finally { state.waiting -= 1; prune(parent, state) }
  }

  return {
    begin(parent) { const state = ensureState(parent); state.starting += 1; startsInFlight += 1; return state },
    track(parent, childId, label) { return track(parent, childId, label) },
    finish(parent, state) {
      if (state.disposed) return
      state.starting = Math.max(0, state.starting - 1)
      startsInFlight = Math.max(0, startsInFlight - 1)
      notify(state)
      prune(parent, state)
    },
    requestStop(parent, childId) {
      const state = ensureState(parent)
      const record = state.children.get(childId)
      if (record) {
        record.stopRequested = true
        record.stopRequestedAt = record.stopRequestedAt ?? new Date().toISOString()
        notify(state)
        return record.stopRequestedAt
      }
      return undefined
    },
    async wait(parent, signal, timeoutMs) {
      const state = ensureState(parent)
      return waitRecords(parent, [...state.children.values()], signal, timeoutMs, true)
    },
    async waitForIds(parent, childIds, signal, timeoutMs) {
      const state = ensureState(parent)
      const records = childIds.map((id) => state.children.get(id)).filter(Boolean)
      return waitRecords(parent, records, signal, timeoutMs, false)
    },
    settlementsForIds(parent, childIds) {
      const state = states.get(parent)
      if (!state) return []
      return childIds.map((id) => state.children.get(id)?.settlement).filter(Boolean)
    },
    size(parent) { const state = states.get(parent); return state ? state.children.size + state.starting : 0 },
    snapshot(parent) {
      const state = states.get(parent)
      if (!state) return []
      const list = []
      for (const record of state.children.values()) {
        const item = {
          subagentId: record.subagentId,
          label: record.label,
          status: record.settlement !== undefined ? 'settled' : 'running',
          startedAt: record.startedAt,
        }
        if (record.settlement !== undefined) {
          item.endedAt = record.settlement.endedAt
          item.durationMs = record.settlement.durationMs
          item.stopReason = record.settlement.stopReason
        }
        if (record.stopRequested) {
          item.stopRequested = true
          item.stopRequestedAt = record.stopRequestedAt
        }
        list.push(item)
      }
      return list
    },
    diagnostics() {
      return {
        states: states.size,
        byChild: byChild.size,
        earlySettlements: earlySettlements.size,
        startTimes: startTimes.size,
        startsInFlight
      }
    },
  }
}

export { createOrchestrationTracker }
