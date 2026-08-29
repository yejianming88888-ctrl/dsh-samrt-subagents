import assert from 'node:assert/strict'
import test from 'node:test'
import { createConcurrencyGate, runForeground } from '../lib/subagent-runner.js'
import { createOrchestrationTracker } from '../lib/orchestration-tracker.js'
import { normalizeSettings } from '../lib/model-config.js'

function eventContext(subagents = {}) {
  const listeners = new Map()
  return {
    ctx: {
      get() { return undefined },
      subagents,
      on(type, fn) { const list = listeners.get(type) ?? []; list.push(fn); listeners.set(type, list); return () => {} },
    },
    emit(type, info) { for (const fn of listeners.get(type) ?? []) fn(info) },
  }
}

test('foreground timeout disposes the run and identifies timeout', async () => {
  let disposed = 0
  await assert.rejects(runForeground({ start: async () => ({ id: 'r', result: new Promise(() => {}), async dispose() { disposed += 1 } }) }, 'spawn', { signal: new AbortController().signal }, 'x', { timeoutMs: 10 }), (error) => error.code === 'timeout')
  assert.equal(disposed, 1)
})

test('foreground abort disposes the run and identifies aborted', async () => {
  let disposed = 0
  const controller = new AbortController()
  const promise = runForeground({ start: async () => ({ id: 'r', result: new Promise(() => {}), async dispose() { disposed += 1 } }) }, 'spawn', { signal: controller.signal }, 'x', { timeoutMs: 1000 })
  controller.abort()
  await assert.rejects(promise, (error) => error.code === 'aborted')
  assert.equal(disposed, 1)
})

test('foreground timeout disposes a run that resolves after start timeout exactly once', async () => {
  let resolveStart
  let disposed = 0
  const start = new Promise((resolve) => { resolveStart = resolve })
  const pending = runForeground({ start: () => start }, 'spawn', { signal: new AbortController().signal }, 'x', { timeoutMs: 5 })
  await assert.rejects(pending, (error) => error.code === 'timeout')
  resolveStart({ id: 'late', result: new Promise(() => {}), async dispose() { disposed += 1 } })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(disposed, 1)
})

test('foreground abort during start disposes the late run exactly once', async () => {
  let resolveStart
  let disposed = 0
  const controller = new AbortController()
  const start = new Promise((resolve) => { resolveStart = resolve })
  const pending = runForeground({ start: () => start }, 'spawn', { signal: controller.signal }, 'x', { timeoutMs: 1000 })
  controller.abort()
  await assert.rejects(pending, (error) => error.code === 'aborted')
  resolveStart({ id: 'late', result: new Promise(() => {}), async dispose() { disposed += 1 } })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(disposed, 1)
})

test('tracker timeout interrupts the actual child and diagnoses unavailable API', async () => {
  const calls = []
  const { ctx, emit } = eventContext({ interrupt(id, auth) { calls.push({ id, auth }) } })
  const tracker = createOrchestrationTracker(ctx)
  const parent = { id: 'parent' }
  tracker.track(parent, 'child', 'child')
  const [settlement] = await tracker.waitForIds(parent, ['child'], new AbortController().signal, 1)
  assert.equal(settlement.stopReason, 'timeout')
  assert.deepEqual(calls, [{ id: 'child', auth: { kind: 'ancestor', agent: parent } }])
  assert.equal(settlement.interrupt.status, 'requested')

  const unavailable = eventContext()
  const trackerWithoutInterrupt = createOrchestrationTracker(unavailable.ctx)
  trackerWithoutInterrupt.track(parent, 'child-2', 'child-2')
  const [diagnosed] = await trackerWithoutInterrupt.waitForIds(parent, ['child-2'], new AbortController().signal, 1)
  assert.equal(diagnosed.interrupt.status, 'unavailable')
  assert.match(diagnosed.interrupt.diagnostic, /unavailable/)
})

test('foreground preserves real error code and stopReason for callers', async () => {
  const cases = [
    { error: Object.assign(new Error('provider timeout'), { code: 'timeout' }), code: 'timeout', stopReason: 'timeout' },
    { error: Object.assign(new Error('provider interrupted'), { stopReason: 'interrupted' }), code: 'interrupted', stopReason: 'interrupted' },
    { error: new Error('provider failure'), code: 'error', stopReason: 'error' },
  ]
  for (const expected of cases) {
    const run = runForeground({ start: async () => ({ id: 'r', result: Promise.reject(expected.error), async dispose() {} }) }, 'spawn', {}, 'x')
    await assert.rejects(run, (error) => error.code === expected.code && error.stopReason === expected.stopReason && error.message === expected.error.message)
  }
})

test('foreground disposal failure after success keeps the run successful and surfaces a distinct cleanup error', async () => {
  const successResult = { stopReason: 'completed', output: [{ type: 'text', text: 'done' }] }
  const run = runForeground(
    { start: async () => ({ id: 'r', result: Promise.resolve(successResult), async dispose() { throw new Error('dispose boom') } }) },
    'spawn',
    { signal: new AbortController().signal },
    'x'
  )
  await assert.rejects(run, (error) => {
    assert.equal(error.code, 'cleanup-failed')
    assert.equal(error.stopReason, 'cleanup-failed')
    assert.ok(error.message.includes('dispose boom'))
    assert.equal(error.runId, 'r')
    return true
  })
})

test('foreground start failure with provider code preserves that code instead of generic error', async () => {
  const providerError = Object.assign(new Error('provider transport closed'), { code: 'transport', stopReason: 'transport' })
  const run = runForeground(
    { start: async () => { throw providerError } },
    'spawn',
    { signal: new AbortController().signal },
    'x'
  )
  await assert.rejects(run, (error) => {
    assert.equal(error.code, 'transport')
    assert.equal(error.stopReason, 'transport')
    assert.equal(error.message, 'provider transport closed')
    return true
  })
})

test('foreground error preserves original error message and partial output', async () => {
  const originalError = new Error('actual provider error message')
  const result = {
    stopReason: 'error',
    output: [
      { type: 'text', text: 'partial output before crash' },
      { type: 'text', text: '\nmore text' }
    ]
  }
  await assert.rejects(
    runForeground({ start: async () => ({ id: 'r', result: Promise.resolve(result), async dispose() {} }) }, 'spawn', { signal: new AbortController().signal }, 'x'),
    (error) => {
      // The error message should include the failure description
      assert.ok(error.message.includes('subagent run failed'), 'should include failure text')
      // The error message should include partial output
      assert.ok(error.message.includes('partial output before crash'), 'should include partial output')
      assert.ok(error.message.includes('more text'), 'should include more text')
      // The error should preserve stopReason as 'error'
      assert.equal(error.stopReason, 'error')
      assert.equal(error.code, 'error')
      return true
    }
  )
})

test('tracker begin/finish increments and decrements startsInFlight', async () => {
  const { ctx, emit } = eventContext()
  const tracker = createOrchestrationTracker(ctx)
  const parent = { id: 'p' }
  
  assert.equal(tracker.diagnostics().startsInFlight, 0)
  
  // begin increments startsInFlight
  const state = tracker.begin(parent)
  assert.equal(tracker.diagnostics().startsInFlight, 1)
  
  // finish decrements startsInFlight and clears earlySettlements
  tracker.finish(parent, state)
  assert.equal(tracker.diagnostics().startsInFlight, 0)
})

// An end can legitimately arrive before track() on either delegation path, and the
// event carries no marker identifying which start it belongs to. Gating retention on
// a global in-flight counter silently dropped real settlements and stranded children
// as permanently "running", so retention is unconditional and bounded instead.
test('tracker retains an early end regardless of in-flight starts', async () => {
  const { ctx, emit } = eventContext()
  const tracker = createOrchestrationTracker(ctx)
  const parent = { id: 'p' }

  // Without begin(), an early end is still retained.
  emit('subagent/end', { id: 'early-without-start', stopReason: 'error', lastAssistantMessage: [] })
  assert.equal(tracker.diagnostics().earlySettlements, 1, 'early end retained without a counted start')

  // With begin(), an early end is retained the same way.
  const state = tracker.begin(parent)
  emit('subagent/end', { id: 'early-with-start', stopReason: 'error', lastAssistantMessage: [] })
  assert.equal(tracker.diagnostics().earlySettlements, 2, 'early end retained while a start is in flight')

  // Track the child - should settle from the cached early end.
  tracker.track(parent, 'early-with-start', 'label')
  const [settlement] = await tracker.waitForIds(parent, ['early-with-start'], new AbortController().signal)
  assert.equal(settlement.stopReason, 'error')
  assert.equal(tracker.diagnostics().earlySettlements, 1, 'consumed entry is removed, the untracked one stays')

  // The untracked early end is still claimable later.
  tracker.track(parent, 'early-without-start', 'late')
  assert.equal(tracker.snapshot(parent)[0].status, 'settled')

  tracker.finish(parent, state)
})

// waitForIds must not block on this parent's begin()/finish() bracket: the caller that
// opened the bracket is the same one awaiting the ids, so coupling them deadlocked.
test('waitForIds settles requested ids while a start is still in flight', async () => {
  const { ctx, emit } = eventContext()
  const tracker = createOrchestrationTracker(ctx)
  const parent = { id: 'p' }

  const state = tracker.begin(parent)
  tracker.track(parent, 'c1', 'one')
  emit('subagent/end', { id: 'c1', stopReason: 'completed', lastAssistantMessage: [] })

  const settlements = await tracker.waitForIds(parent, ['c1'], new AbortController().signal)
  assert.equal(settlements.length, 1)
  assert.equal(settlements[0].stopReason, 'completed')
  assert.equal(tracker.diagnostics().startsInFlight, 1, 'the bracket is still open and untouched by the wait')

  tracker.finish(parent, state)
  assert.equal(tracker.diagnostics().startsInFlight, 0)
})

// Disposal is per parent. Resetting the global counter and clearing the shared early
// cache destroyed bookkeeping for children of parents that were still alive.
test('tracker agent/disposed only retires the disposed parent bookkeeping', async () => {
  const { ctx, emit } = eventContext()
  const tracker = createOrchestrationTracker(ctx)
  const parent = { id: 'p' }
  const other = { id: 'other' }

  const state = tracker.begin(parent)
  const otherState = tracker.begin(other)
  emit('subagent/end', { id: 'early-kept', stopReason: 'error', lastAssistantMessage: [] })
  assert.equal(tracker.diagnostics().earlySettlements, 1)
  assert.equal(tracker.diagnostics().startsInFlight, 2)

  // Disposing one parent releases only that parent's in-flight start and leaves the
  // shared early cache intact for the surviving parent.
  emit('agent/disposed', { agent: parent })
  assert.equal(tracker.diagnostics().earlySettlements, 1, 'shared early cache survives another parent disposal')
  assert.equal(tracker.diagnostics().startsInFlight, 1, 'only the disposed parent start is released')

  tracker.finish(parent, state) // safe to call even after dispose
  assert.equal(tracker.diagnostics().startsInFlight, 1, 'finish after dispose does not double-decrement')

  // The surviving parent can still claim the cached early end.
  tracker.track(other, 'early-kept', 'kept')
  assert.equal(tracker.snapshot(other)[0].status, 'settled')
  tracker.finish(other, otherState)
  assert.equal(tracker.diagnostics().startsInFlight, 0)
})

test('concurrency gate releases on end regardless of tracking order', async () => {
  const gate = createConcurrencyGate(1)
  
  // Acquire a slot
  const release = await gate.acquire()
  assert.equal(gate.active, 1)
  
  // Track a child with this concurrency slot
  const controller = new AbortController()
  gate.track('child-1', release, undefined)
  assert.equal(gate.active, 1)
  
  // End should release the slot
  gate.end('child-1')
  assert.equal(gate.active, 0)
  
  // Can acquire again
  const release2 = await gate.acquire()
  assert.equal(gate.active, 1)
  release2()
  assert.equal(gate.active, 0)
})

test('concurrency gate end is idempotent and safe for unknown child', async () => {
  const gate = createConcurrencyGate(2)

  // Acquire two slots
  const release1 = await gate.acquire()
  const release2 = await gate.acquire()
  assert.equal(gate.active, 2)

  // end() for an untracked child must be a no-op. A stray subagent/end event for a
  // child this gate never issued a slot to must not decrement the active count, or
  // the cap would drift and admit more concurrent runs than configured.
  gate.end('unknown-child')
  assert.equal(gate.active, 2)

  // end() for a tracked child releases exactly that child's slot.
  gate.track('child-1', release1, undefined)
  gate.end('child-1')
  assert.equal(gate.active, 1)

  // A repeated end() for the same child is idempotent.
  gate.end('child-1')
  assert.equal(gate.active, 1)

  release2()
  assert.equal(gate.active, 0)
})

test('tracker retains an end that arrives before track', async () => {
  const { ctx, emit } = eventContext()
  const tracker = createOrchestrationTracker(ctx)
  emit('subagent/end', { id: 'c', stopReason: 'completed', lastAssistantMessage: [] })
  tracker.track('p', 'c', 'early')
  const [settlement] = await tracker.waitForIds('p', ['c'], new AbortController().signal)
  assert.deepEqual(settlement, { subagentId: 'c', label: 'early', stopReason: 'completed', output: [], endedAt: settlement.endedAt, durationMs: settlement.durationMs })
  assert.match(settlement.endedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.ok(Number.isInteger(settlement.durationMs) && settlement.durationMs >= 0)
})

test('separate trackers keep independent records when one waits', async () => {
  const { ctx, emit } = eventContext()
  const trackerA = createOrchestrationTracker(ctx)
  const trackerB = createOrchestrationTracker(ctx)
  const parent = {}
  trackerA.track(parent, 'shared', 'A')
  trackerB.track(parent, 'shared', 'B')

  emit('subagent/end', { id: 'shared', stopReason: 'completed', lastAssistantMessage: [] })
  const [settlementA] = await trackerA.waitForIds(parent, ['shared'], new AbortController().signal)
  assert.equal(settlementA.label, 'A')
  assert.equal(trackerB.snapshot(parent)[0].label, 'B')
  const [settlementB] = await trackerB.waitForIds(parent, ['shared'], new AbortController().signal)
  assert.equal(settlementB.label, 'B')
})

test('disposing one parent does not remove another parent child', async () => {
  const { ctx, emit } = eventContext()
  const tracker = createOrchestrationTracker(ctx)
  const a = {}
  const b = {}
  tracker.track(a, 'a', 'a')
  tracker.track(b, 'b', 'b')
  emit('agent/disposed', { agent: a })
  emit('subagent/end', { id: 'b', stopReason: 'completed', lastAssistantMessage: [] })
  const [settlement] = await tracker.waitForIds(b, ['b'], new AbortController().signal)
  assert.deepEqual(settlement, { subagentId: 'b', label: 'b', stopReason: 'completed', output: [], endedAt: settlement.endedAt, durationMs: settlement.durationMs })
  assert.match(settlement.endedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.ok(Number.isInteger(settlement.durationMs) && settlement.durationMs >= 0)
})

test('settings timeout fields have defaults and positive integer validation', () => {
  const value = normalizeSettings({})
  assert.equal(value.foregroundTimeoutMs, 120000)
  assert.equal(value.idleTimeoutMs, 60000)
  assert.equal(value.maxConcurrentSubagents, 3)
  assert.throws(() => normalizeSettings({ foregroundTimeoutMs: 0 }), /positive integer/)
  assert.throws(() => normalizeSettings({ idleTimeoutMs: 1.5 }), /positive integer/)
  assert.throws(() => normalizeSettings({ maxConcurrentSubagents: 0 }), /positive integer/)
  assert.throws(() => normalizeSettings({ maxConcurrentSubagents: 1.5 }), /positive integer/)
})

test('concurrency gate caps at three and releases queued work in FIFO order', async () => {
  const gate = createConcurrencyGate()
  const releases = await Promise.all([gate.acquire(), gate.acquire(), gate.acquire()])
  assert.equal(gate.active, 3)
  const order = []
  const fourth = gate.acquire().then((release) => { order.push('fourth'); return release })
  const fifth = gate.acquire().then((release) => { order.push('fifth'); return release })
  await Promise.resolve()
  assert.equal(gate.queued, 2)
  releases[0]()
  const releaseFourth = await fourth
  assert.deepEqual(order, ['fourth'])
  releaseFourth()
  const releaseFifth = await fifth
  assert.deepEqual(order, ['fourth', 'fifth'])
  releaseFifth()
  releases[1]()
  releases[2]()
  assert.equal(gate.active, 0)
})

test('concurrency gate cancels queued work and applies dynamic limits safely', async () => {
  const gate = createConcurrencyGate(1)
  const releaseFirst = await gate.acquire()
  const controller = new AbortController()
  const cancelled = gate.acquire(controller.signal)
  controller.abort(new Error('cancel queued'))
  await assert.rejects(cancelled, /cancel queued/)
  assert.equal(gate.queued, 0)
  const second = gate.acquire()
  gate.setLimit(2)
  const releaseSecond = await second
  assert.equal(gate.active, 2)
  releaseFirst()
  releaseSecond()
  assert.equal(gate.active, 0)
})

test('concurrency gate dispose rejects queued work and releases tracked slots', async () => {
  const gate = createConcurrencyGate(1)
  const release = await gate.acquire()
  gate.track('child', release, 60000)
  const queued = gate.acquire()
  gate.dispose()
  await assert.rejects(queued, /disposed/)
  assert.equal(gate.active, 0)
  assert.equal(gate.queued, 0)
})

test('tracker memory cleanup and boundaries via diagnostics', async () => {
  const { ctx, emit } = eventContext()
  const tracker = createOrchestrationTracker(ctx)
  
  const parent1 = { id: 'parent-1' }
  const parent2 = { id: 'parent-2' }

  // 1. Initial diagnostics check
  assert.deepEqual(tracker.diagnostics(), { states: 0, byChild: 0, earlySettlements: 0, startTimes: 0, startsInFlight: 0 })

  // 2. Track children
  tracker.track(parent1, 'c1', 'child-1')
  tracker.track(parent2, 'c2', 'child-2')
  
  assert.deepEqual(tracker.diagnostics(), { states: 2, byChild: 2, earlySettlements: 0, startTimes: 2, startsInFlight: 0 })

  // 3. Settle and check duplicate end before wait
  emit('subagent/end', { id: 'c1', stopReason: 'completed', lastAssistantMessage: [] })
  emit('subagent/end', { id: 'c1', stopReason: 'another-reason', lastAssistantMessage: [] })

  assert.deepEqual(tracker.diagnostics(), { states: 2, byChild: 2, earlySettlements: 0, startTimes: 2, startsInFlight: 0 })

  await tracker.waitForIds(parent1, ['c1'], new AbortController().signal)

  // Verify parent1 records are cleaned up (parent1 state pruned, startTimes removed)
  assert.deepEqual(tracker.diagnostics(), { states: 1, byChild: 1, earlySettlements: 0, startTimes: 1, startsInFlight: 0 })

  // 4. Duplicate early end doesn't create multiple early settlements.
  // A cached early end also anchors a start time, so a settlement built from it after
  // a late track() can never report a start that is newer than its own end.
  emit('subagent/end', { id: 'early-dup', stopReason: 'completed', lastAssistantMessage: [] })
  emit('subagent/end', { id: 'early-dup', stopReason: 'another-reason', lastAssistantMessage: [] })
  assert.deepEqual(tracker.diagnostics(), { states: 1, byChild: 1, earlySettlements: 1, startTimes: 2, startsInFlight: 0 })
  
  // Clear the early-dup child by tracking it and waiting
  tracker.track(parent1, 'early-dup', 'dup')
  await tracker.waitForIds(parent1, ['early-dup'], new AbortController().signal)
  assert.deepEqual(tracker.diagnostics(), { states: 1, byChild: 1, earlySettlements: 0, startTimes: 1, startsInFlight: 0 })

  // 5. Parent dispose cleans up its children (parent2)
  emit('agent/disposed', { agent: parent2 })
  assert.deepEqual(tracker.diagnostics(), { states: 0, byChild: 0, earlySettlements: 0, startTimes: 0, startsInFlight: 0 })

  // 6. Bounded early settlements
  // Emit 1005 early end events
  for (let i = 0; i < 1005; i++) {
    emit('subagent/end', { id: `early-${i}`, stopReason: 'completed', lastAssistantMessage: [] })
  }
  
  const diag = tracker.diagnostics()
  assert.equal(diag.earlySettlements, 1000)

  // Track the most recent early-1004 early end, it should still be in cache
  tracker.track(parent1, 'early-1004', 'latest')
  const [settlement] = await tracker.waitForIds(parent1, ['early-1004'], new AbortController().signal)
  assert.equal(settlement.subagentId, 'early-1004')
  assert.equal(settlement.stopReason, 'completed')

  // Verify the tracked one got evicted from earlySettlements and cleaned up on wait.
  // Each still-cached early end keeps its own anchored start time, so startTimes
  // tracks the surviving cache entries rather than dropping to zero.
  const postWaitDiag = tracker.diagnostics()
  assert.equal(postWaitDiag.earlySettlements, 999)
  assert.equal(postWaitDiag.byChild, 0)
  assert.equal(postWaitDiag.states, 0)
  assert.equal(postWaitDiag.startTimes, 999)
  assert.equal(postWaitDiag.startsInFlight, 0)
})

test('tracker child ID reuse, generation isolation, and early cache eviction with startTimes cleaning', async () => {
  const { ctx, emit } = eventContext()
  const tracker = createOrchestrationTracker(ctx)
  const parentA = { id: 'parent-a' }
  const parentB = { id: 'parent-b' }
  const signal = new AbortController().signal

  // 1. Wait after reusing child ID
  tracker.track(parentA, 'child-reuse', 'run-1')
  const snap1 = tracker.snapshot(parentA)[0]
  assert.ok(snap1.startedAt)

  emit('subagent/end', { id: 'child-reuse', stopReason: 'completed', lastAssistantMessage: [] })
  await tracker.waitForIds(parentA, ['child-reuse'], signal)

  // Sleep slightly to guarantee ISO timestamp changes if generated fresh
  await new Promise((resolve) => setTimeout(resolve, 5))

  tracker.track(parentA, 'child-reuse', 'run-2')
  const snap2 = tracker.snapshot(parentA)[0]
  assert.ok(snap2.startedAt)
  assert.notEqual(snap1.startedAt, snap2.startedAt)
  assert.equal(snap2.status, 'running')
  assert.equal(snap2.endedAt, undefined)

  emit('subagent/end', { id: 'child-reuse', stopReason: 'completed', lastAssistantMessage: [] })
  await tracker.waitForIds(parentA, ['child-reuse'], signal)

  // 2. Dispose parent and cross-parent child ID reuse
  tracker.track(parentA, 'child-shared', 'run-a')
  emit('agent/disposed', { agent: parentA })
  
  // Now parentB tracks same child ID
  tracker.track(parentB, 'child-shared', 'run-b')
  const bSnap = tracker.snapshot(parentB)[0]
  assert.equal(bSnap.status, 'running')
  assert.equal(bSnap.endedAt, undefined)

  emit('subagent/end', { id: 'child-shared', stopReason: 'completed', lastAssistantMessage: [] })
  const [bSettlement] = await tracker.waitForIds(parentB, ['child-shared'], signal)
  assert.equal(bSettlement.stopReason, 'completed')

  // 3. Early end eviction cleans startTimes but keeps active records
  // Register c-active as an active formal record
  tracker.track(parentA, 'c-active', 'active')
  assert.equal(tracker.diagnostics().startTimes, 1)

  // Emit 1005 early start/end events for other IDs
  for (let i = 0; i < 1005; i++) {
    const id = `early-evict-${i}`
    emit('subagent/start', { id })
    emit('subagent/end', { id, stopReason: 'completed', lastAssistantMessage: [] })
  }

  // 1005 early runs + 1 active run = 1006 startTimes initially.
  // Eviction of 5 oldest early settlements should also evict their startTimes.
  // So startTimes should be 1000 (early settlements max) + 1 (active run) = 1001.
  const diag = tracker.diagnostics()
  assert.equal(diag.earlySettlements, 1000)
  assert.equal(diag.startTimes, 1001)

  // Verify c-active is still active and has its start time intact
  const activeSnap = tracker.snapshot(parentA).find((x) => x.subagentId === 'c-active')
  assert.ok(activeSnap)
  assert.equal(activeSnap.status, 'running')

  // Clean up active run
  emit('subagent/end', { id: 'c-active', stopReason: 'completed', lastAssistantMessage: [] })
  await tracker.waitForIds(parentA, ['c-active'], signal)
})
