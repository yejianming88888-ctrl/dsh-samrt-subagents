import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, SETTINGS_NAMESPACE, DELEGATE_TOOL } from '../lib/index.js'
import { normalizeSettings } from '../lib/model-config.js'
import { normalizePlanSteps } from '../lib/orchestrator.js'

function createContext(initial) {
  const tools = new Map()
  const skills = []
  const settingsList = [{ ns: SETTINGS_NAMESPACE, value: normalizeSettings({ idleTimeoutMs: 50, ...initial }), revision: 0 }]
  const continuableStarts = []
  const starts = []
  const foregroundOutcomes = [...(initial.foregroundOutcomes ?? [])]
  let settingsWatcher
  let lastRegistration
  const agents = new Map()
  const listeners = new Map()
  const parent = { id: 'main', options: { provider: 'p', model: 'm' } }
  return {
    tools, skills, continuableStarts, starts,
    ctx: {
      get(name) {
        if (name === 'llm') return { listProviders() { return [{ id: 'p', name: 'P' }] }, async listModels() { return [{ id: 'm', name: 'M' }] } }
        if (name === 'agents') return { get(id) { return agents.get(id) } }
        return undefined
      },
      tools: { register: (tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
      subagents: {
        async start(name, request) {
          starts.push({ name, request })
          const outcome = foregroundOutcomes.shift()
          if (outcome?.startError !== undefined) throw outcome.startError
          if (request.label?.includes('throw-error')) throw new Error('mock immediate start error')
          let result = outcome ?? { stopReason: 'completed', output: [{ type: 'text', text: 'done' }] }
          if (result instanceof Error) return { id: 'run-' + starts.length, result: Promise.reject(result), async dispose() {} }
          return { id: 'run-' + starts.length, result: Promise.resolve(result), async dispose() {} }
        },
        async startContinuable(spec) {
          if (spec.label?.includes('fail-start')) {
            throw new Error('mock startBackground failure')
          }
          continuableStarts.push(spec)
          const childId = 'child-' + (continuableStarts.length)
          agents.set(childId, { id: childId, session: { events: [{ type: 'subagent/descriptor', data: { mode: 'continuable', label: spec.label } }] } })
          Promise.resolve().then(() => {
            for (const listener of listeners.get('subagent/start') ?? []) listener({ id: childId, parent: spec.request.parent, label: spec.label })
            if (spec.label?.includes('delay-end')) {
              setTimeout(() => {
                for (const listener of listeners.get('subagent/end') ?? []) listener({ id: childId, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'done for ' + spec.label }] })
              }, 50)
            } else if (spec.label?.includes('early-error')) {
              for (const listener of listeners.get('subagent/end') ?? []) listener({ id: childId, stopReason: 'error', lastAssistantMessage: [{ type: 'text', text: 'early error for ' + spec.label }] })
            } else if (!spec.label?.includes('no-end')) {
              for (const listener of listeners.get('subagent/end') ?? []) listener({ id: childId, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'done for ' + spec.label }] })
            }
          })
          return { childId, messageId: 'm' }
        },
      },
      settings: {
        writable: true, describe() { return settingsList },
        register(namespace, schema, options) {
          lastRegistration = { namespace, schema, options }
          return {
            get() { return settingsList[0].value },
            async replace(next) { options.validate(next); settingsList[0] = { ns: namespace, value: next, revision: settingsList[0].revision + 1 } },
            watch(callback) { settingsWatcher = callback; return () => { settingsWatcher = undefined } },
          }
        },
      },
      skills: { register: (skill) => { skills.push(skill); return () => {} } },
      effect: (callback) => { const dispose = callback(); return typeof dispose === 'function' ? dispose : () => {} },
      logger: { info() {}, warn() {}, error() {} },
      on(event, listener) {
        const list = listeners.get(event) ?? []
        list.push(listener)
        listeners.set(event, list)
        return () => { const current = listeners.get(event) ?? []; listeners.set(event, current.filter((entry) => entry !== listener)) }
      },
    },
    parent,
    emit(info) { for (const listener of listeners.get(info.type) ?? []) listener(info) },
  }
}

const settings = {
  mode: 'automatic',
  planningMode: 'automatic',
  models: [
    { alias: 'fast', provider: 'p', model: 'm', purpose: '快速整理', allowExecution: true, allowPlanning: true },
    { alias: 'deep', provider: 'p', model: 'm', purpose: '复杂架构设计', allowExecution: true, allowPlanning: true },
  ],
}

test('normalizes title, numeric, and Step N dependencies into forward layers', () => {
  const plan = normalizePlanSteps({ goal: 'g', steps: [
    { title: 'compile' },
    { title: 'test', dependsOn: ['compile'] },
    { title: 'ship', dependsOn: ['Step 2'] },
    { title: 'notify', dependsOn: [3] },
  ] })
  assert.deepEqual(plan.steps.map((step) => step.dependsOn), [[], [0], [1], [2]])
  assert.deepEqual(plan.layers, [[0], [1], [2], [3]])
})

test('rejects duplicate titles, unknown, self, duplicate, and cyclic dependencies', () => {
  assert.throws(() => normalizePlanSteps({ goal: 'g', steps: [{ title: 'x' }, { title: 'x' }] }), /duplicate step title/)
  assert.throws(() => normalizePlanSteps({ goal: 'g', steps: [{ title: 'x', dependsOn: ['missing'] }] }), /unknown step/)
  assert.throws(() => normalizePlanSteps({ goal: 'g', steps: [{ title: 'x', dependsOn: ['x'] }] }), /references itself/)
  assert.throws(() => normalizePlanSteps({ goal: 'g', steps: [{ title: 'x' }, { title: 'y', dependsOn: ['1', 1] }] }), /repeats reference/)
  assert.throws(() => normalizePlanSteps({ goal: 'g', steps: [{ title: 'x', dependsOn: ['2'] }, { title: 'y', dependsOn: ['1'] }] }), /cycle/)
})

test('plan tool delegates to a planner model and returns normalized plan', async () => {
  const harness = createContext(settings)
  await apply(harness.ctx)
  const tool = harness.tools.get('smart_subagent_plan')
  const signal = new AbortController().signal
  const result = await tool.execute({ goal: 'Build a tiny app' }, { agent: harness.parent, signal })
  assert.equal(result.mode, 'planner-model')
  assert.match(result.summary, /Goal:/)
  assert.ok(Array.isArray(result.plan.steps))
})

test('run plan dispatches steps in parallel and waits', async () => {
  const harness = createContext({ ...settings, requirePlanConfirmation: false })
  await apply(harness.ctx)
  const tool = harness.tools.get('smart_subagent_run_plan')
  const signal = new AbortController().signal
  const result = await tool.execute({
    plan: { goal: 'g', steps: [{ title: 'a', summary: 'a', prompt: 'p' }, { title: 'b', summary: 'b', prompt: 'q' }] },
    wait: true,
  }, { agent: harness.parent, signal })
  assert.equal(result.status, 'completed')
  assert.equal(result.dispatched.length, 2)
  assert.equal(harness.continuableStarts.length, 2)
  assert.equal(result.settlements.length, 2)
})

test('run plan wait:false returns started/partial while the child keeps running', async () => {
  const harness = createContext({ ...settings, requirePlanConfirmation: false })
  await apply(harness.ctx)
  const runPlanTool = harness.tools.get('smart_subagent_run_plan')
  const statusTool = harness.tools.get('smart_subagent_status')
  const waitTool = harness.tools.get('smart_subagent_wait')
  const exec = { agent: harness.parent, signal: new AbortController().signal }

  const result = await runPlanTool.execute({
    plan: { goal: 'g', steps: [{ title: 'delay-end', summary: 'a', prompt: 'p' }] },
    wait: false,
  }, exec)

  assert.equal(result.status, 'partial')
  assert.equal(result.stepResults[0].status, 'started')
  assert.equal(result.dispatched[0].childId, 'child-1')
  assert.equal((await statusTool.execute({}, exec)).subagents[0].status, 'running')

  const waited = await waitTool.execute({}, exec)
  assert.equal(waited.settlements[0].subagentId, 'child-1')
  assert.equal(waited.settlements[0].stopReason, 'completed')
})

test('run plan executes dependent layers and exposes layer indexes', async () => {
  const harness = createContext({ ...settings, requirePlanConfirmation: false })
  await apply(harness.ctx)
  const result = await harness.tools.get('smart_subagent_run_plan').execute({
    plan: { goal: 'g', steps: [{ title: 'base' }, { title: 'dependent', dependsOn: ['Step 1'] }, { title: 'parallel', dependsOn: ['base'] }] },
    wait: true,
  }, { agent: harness.parent, signal: new AbortController().signal })
  assert.deepEqual(result.layers, [{ index: 0, stepIndexes: [0] }, { index: 1, stepIndexes: [1, 2] }])
  assert.equal(result.dispatched.length, 3)
})

test('ask mode stops at the first layer step and does not dispatch later layers', async () => {
  const harness = createContext({ ...settings, mode: 'ask' })
  await apply(harness.ctx)
  const result = await harness.tools.get('smart_subagent_run_plan').execute({
    plan: { goal: 'g', steps: [{ title: 'base' }, { title: 'later', dependsOn: ['1'] }] },
  }, { agent: harness.parent, signal: new AbortController().signal })
  assert.equal(result.status, 'awaiting-choice')
  assert.equal(result.step.stepIndex, 0)
  assert.equal(result.dispatched.length, 0)
  assert.deepEqual(result.layers, [{ index: 0, stepIndexes: [0] }, { index: 1, stepIndexes: [1] }])
})

test('ask mode returns recommendation and choices from smart_delegate', async () => {
  const harness = createContext({ ...settings, mode: 'ask' })
  await apply(harness.ctx)
  const tool = harness.tools.get(DELEGATE_TOOL)
  const result = await tool.execute({ task: '整理', prompt: '请整理' }, { agent: harness.parent, signal: new AbortController().signal })
  assert.equal(result.kind, 'choice-required')
  assert.equal(result.recommendation, 'fast')
})

test('wait tool returns empty settlements when nothing is running', async () => {
  const harness = createContext({ ...settings, requirePlanConfirmation: false })
  await apply(harness.ctx)
  const tool = harness.tools.get('smart_subagent_wait')
  const result = await tool.execute({}, { agent: harness.parent, signal: new AbortController().signal })
  assert.deepEqual(result.settlements, [])
})

test('status tool returns running, settled and cleared statuses during life cycle', async () => {
  const harness = createContext({ ...settings, requirePlanConfirmation: false })
  await apply(harness.ctx)
  
  const runPlanTool = harness.tools.get('smart_subagent_run_plan')
  const statusTool = harness.tools.get('smart_subagent_status')
  const waitTool = harness.tools.get('smart_subagent_wait')
  
  const signal = new AbortController().signal
  
  // 1. Initially, no background subagents
  const initialStatus = await statusTool.execute({}, { agent: harness.parent, signal })
  assert.deepEqual(initialStatus, { status: 'completed', subagents: [] })
  
  // 2. Dispatch a plan without wait
  await runPlanTool.execute({
    plan: { goal: 'g', steps: [{ title: 'delay-end', summary: 'a', prompt: 'p' }] },
    wait: false,
  }, { agent: harness.parent, signal })
  
  // 3. Immediately query status, should be running
  const runningStatus = await statusTool.execute({}, { agent: harness.parent, signal })
  assert.equal(runningStatus.status, 'completed')
  assert.equal(runningStatus.subagents.length, 1)
  assert.equal(runningStatus.subagents[0].label, '1:delay-end')
  assert.equal(runningStatus.subagents[0].status, 'running')
  assert.equal(runningStatus.subagents[0].stopReason, undefined)
  
  // 4. Wait for microtask tick to let the simulated subagent end event fire
  await new Promise((resolve) => setTimeout(resolve, 70))
  
  // 5. Query status again, should be settled now
  const settledStatus = await statusTool.execute({}, { agent: harness.parent, signal })
  assert.equal(settledStatus.status, 'completed')
  assert.equal(settledStatus.subagents.length, 1)
  assert.equal(settledStatus.subagents[0].label, '1:delay-end')
  assert.equal(settledStatus.subagents[0].status, 'settled')
  assert.equal(settledStatus.subagents[0].stopReason, 'completed')
  
  // 6. Call wait tool to harvest and clean up
  await waitTool.execute({}, { agent: harness.parent, signal })
  
  // 7. Query status again, should be empty again
  const finalStatus = await statusTool.execute({}, { agent: harness.parent, signal })
  assert.deepEqual(finalStatus, { status: 'completed', subagents: [] })
})

test('status tool segregates subagents by parent identity', async () => {
  const harness = createContext({ ...settings, requirePlanConfirmation: false })
  await apply(harness.ctx)
  
  const runPlanTool = harness.tools.get('smart_subagent_run_plan')
  const statusTool = harness.tools.get('smart_subagent_status')
  
  const signal = new AbortController().signal
  const otherParent = { id: 'other-parent', options: { provider: 'p', model: 'm' } }
  
  // Dispatch a plan for harness.parent
  await runPlanTool.execute({
    plan: { goal: 'g', steps: [{ title: 'parent-a', summary: 'a', prompt: 'p' }] },
    wait: false,
  }, { agent: harness.parent, signal })
  
  // Dispatch a plan for otherParent
  await runPlanTool.execute({
    plan: { goal: 'g', steps: [{ title: 'parent-b', summary: 'b', prompt: 'q' }] },
    wait: false,
  }, { agent: otherParent, signal })
  
  // Check harness.parent's subagents
  const parentAStatus = await statusTool.execute({}, { agent: harness.parent, signal })
  assert.equal(parentAStatus.subagents.length, 1)
  assert.equal(parentAStatus.subagents[0].label, '1:parent-a')
  
  // Check otherParent's subagents
  const parentBStatus = await statusTool.execute({}, { agent: otherParent, signal })
  assert.equal(parentBStatus.subagents.length, 1)
  assert.equal(parentBStatus.subagents[0].label, '1:parent-b')
})

test('stop tool can stop parent owned background child, rejects non-owned, and uses correct authorization info', async () => {
  const harness = createContext({ ...settings, requirePlanConfirmation: false })
  const interrupts = []
  harness.ctx.subagents.interrupt = (subagentId, auth) => {
    interrupts.push({ subagentId, auth })
  }
  await apply(harness.ctx)
  const runPlanTool = harness.tools.get('smart_subagent_run_plan')
  const stopTool = harness.tools.get('smart_subagent_stop')
  const signal = new AbortController().signal

  const result = await runPlanTool.execute({
    plan: { goal: 'g', steps: [{ title: 'no-end', summary: 'a', prompt: 'p' }] },
    wait: false,
  }, { agent: harness.parent, signal })

  const childId = result.dispatched[0].childId
  assert.ok(childId)

  const stopResult = await stopTool.execute({ subagentId: childId }, { agent: harness.parent, signal })
  assert.equal(stopResult.status, 'interrupt-requested')
  assert.equal(stopResult.subagentId, childId)
  assert.match(stopResult.requestedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

  assert.equal(interrupts.length, 1)
  assert.deepEqual(interrupts[0], {
    subagentId: childId,
    auth: { kind: 'ancestor', agent: harness.parent }
  })

  const otherParent = { id: 'other-parent', options: { provider: 'p', model: 'm' } }
  await assert.rejects(
    async () => {
      await stopTool.execute({ subagentId: childId }, { agent: otherParent, signal })
    },
    new RegExp('unknown subagent "' + childId + '" for this parent')
  )
})

test('smart_subagent_stop allows a parent to stop its own background child', async () => {
  const harness = createContext({ ...settings, requirePlanConfirmation: false })
  let interruptedId = null
  harness.ctx.subagents.interrupt = (subagentId, auth) => {
    interruptedId = subagentId
  }
  await apply(harness.ctx)
  const runPlanTool = harness.tools.get('smart_subagent_run_plan')
  const stopTool = harness.tools.get('smart_subagent_stop')
  const signal = new AbortController().signal

  const result = await runPlanTool.execute({
    plan: { goal: 'g', steps: [{ title: 'no-end', summary: 'a', prompt: 'p' }] },
    wait: false,
  }, { agent: harness.parent, signal })

  const childId = result.dispatched[0].childId
  const stopResult = await stopTool.execute({ subagentId: childId }, { agent: harness.parent, signal })
  assert.equal(stopResult.status, 'interrupt-requested')
  assert.equal(stopResult.subagentId, childId)
  assert.match(stopResult.requestedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.equal(interruptedId, childId)
})

test('smart_subagent_stop rejects stopping a background child that does not belong to the calling parent', async () => {
  const harness = createContext({ ...settings, requirePlanConfirmation: false })
  harness.ctx.subagents.interrupt = () => {}
  await apply(harness.ctx)
  const runPlanTool = harness.tools.get('smart_subagent_run_plan')
  const stopTool = harness.tools.get('smart_subagent_stop')
  const signal = new AbortController().signal

  const result = await runPlanTool.execute({
    plan: { goal: 'g', steps: [{ title: 'no-end', summary: 'a', prompt: 'p' }] },
    wait: false,
  }, { agent: harness.parent, signal })

  const childId = result.dispatched[0].childId
  const otherParent = { id: 'other-parent', options: { provider: 'p', model: 'm' } }

  await assert.rejects(
    async () => {
      await stopTool.execute({ subagentId: childId }, { agent: otherParent, signal })
    },
    new RegExp('unknown subagent "' + childId + '" for this parent')
  )
})

test('smart_subagent_stop invokes interrupt with the correct ancestor authentication payload', async () => {
  const harness = createContext({ ...settings, requirePlanConfirmation: false })
  let interruptAuth = null
  harness.ctx.subagents.interrupt = (subagentId, auth) => {
    interruptAuth = auth
  }
  await apply(harness.ctx)
  const runPlanTool = harness.tools.get('smart_subagent_run_plan')
  const stopTool = harness.tools.get('smart_subagent_stop')
  const signal = new AbortController().signal

  const result = await runPlanTool.execute({
    plan: { goal: 'g', steps: [{ title: 'no-end', summary: 'a', prompt: 'p' }] },
    wait: false,
  }, { agent: harness.parent, signal })

  const childId = result.dispatched[0].childId
  await stopTool.execute({ subagentId: childId }, { agent: harness.parent, signal })

  assert.deepEqual(interruptAuth, { kind: 'ancestor', agent: harness.parent })
})

test('smart_subagent_stop state lifecycle, end settling, wait cleanup, and failure behavior', async () => {
  const harness = createContext({ ...settings, requirePlanConfirmation: false })
  let shouldThrow = false
  harness.ctx.subagents.interrupt = (subagentId, auth) => {
    if (shouldThrow) throw new Error('Interrupt failed intentionally')
  }
  await apply(harness.ctx)
  const runPlanTool = harness.tools.get('smart_subagent_run_plan')
  const stopTool = harness.tools.get('smart_subagent_stop')
  const statusTool = harness.tools.get('smart_subagent_status')
  const waitTool = harness.tools.get('smart_subagent_wait')
  const signal = new AbortController().signal

  // Start background child
  const result = await runPlanTool.execute({
    plan: { goal: 'g', steps: [{ title: 'no-end', summary: 'a', prompt: 'p' }] },
    wait: false,
  }, { agent: harness.parent, signal })

  const childId = result.dispatched[0].childId

  // Initial check
  let statusResult = await statusTool.execute({}, { agent: harness.parent, signal })
  assert.equal(statusResult.subagents[0].status, 'running')
  assert.equal(statusResult.subagents[0].stopRequested, undefined)

  // Call stop but make interrupt fail first
  shouldThrow = true
  await assert.rejects(
    async () => {
      await stopTool.execute({ subagentId: childId }, { agent: harness.parent, signal })
    },
    /Interrupt failed intentionally/
  )

  // Verify stopRequested is NOT set
  statusResult = await statusTool.execute({}, { agent: harness.parent, signal })
  assert.equal(statusResult.subagents[0].status, 'running')
  assert.equal(statusResult.subagents[0].stopRequested, undefined)

  // Now perform successful stop
  shouldThrow = false
  const stopRes = await stopTool.execute({ subagentId: childId }, { agent: harness.parent, signal })
  assert.equal(stopRes.status, 'interrupt-requested')
  assert.equal(stopRes.subagentId, childId)
  assert.match(stopRes.requestedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

  // Verify stopRequested is set
  statusResult = await statusTool.execute({}, { agent: harness.parent, signal })
  assert.equal(statusResult.subagents[0].status, 'running')
  assert.equal(statusResult.subagents[0].stopRequested, true)
  assert.equal(statusResult.subagents[0].stopRequestedAt, stopRes.requestedAt)

  // Emit end event to settle it
  harness.emit({ type: 'subagent/end', id: childId, stopReason: 'aborted', lastAssistantMessage: [] })

  // Verify status is settled, keeping stopRequested
  statusResult = await statusTool.execute({}, { agent: harness.parent, signal })
  assert.equal(statusResult.subagents[0].status, 'settled')
  assert.equal(statusResult.subagents[0].stopReason, 'aborted')
  assert.equal(statusResult.subagents[0].stopRequested, true)

  // Clean up using wait
  await waitTool.execute({}, { agent: harness.parent, signal })

  // Verify status list is empty
  statusResult = await statusTool.execute({}, { agent: harness.parent, signal })
  assert.deepEqual(statusResult.subagents, [])
})

test('smart_subagent_run_plan aborts an in-flight plan without leaving test state behind', async () => {
  const harness = createContext({
    mode: 'automatic',
    planningMode: 'automatic',
    models: [
      { alias: 'alias-a', provider: 'p', model: 'm', purpose: 'a', allowExecution: true, allowPlanning: true }
    ],
    requirePlanConfirmation: false
  })

  await apply(harness.ctx)
  const runPlanTool = harness.tools.get('smart_subagent_run_plan')

  const controller = new AbortController()
  const signal = controller.signal

  // First step runs on alias-a (no-end, so it keeps the alias occupied)
  const runPromise1 = runPlanTool.execute({
    plan: {
      goal: 'g',
      steps: [
        { title: 'step-1', summary: 'a', prompt: 'p1' }
      ]
    },
    wait: true
  }, { agent: harness.parent, signal })

  // We wait briefly for step-1 to start and occupy the alias-a
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(harness.continuableStarts.length, 1)
  const childId1 = 'child-1'

  // Second step uses same alias, it will wait for alias-a to clear
  const controller2 = new AbortController()
  const runPromise2 = runPlanTool.execute({
    plan: {
      goal: 'g',
      steps: [
        { title: 'no-end-2', summary: 'a', prompt: 'p2' }
      ]
    },
    wait: true
  }, { agent: harness.parent, signal: controller2.signal })

  await new Promise((resolve) => setTimeout(resolve, 10))
  // Independent run_plan calls do not share alias state.
  assert.equal(harness.continuableStarts.length, 2)

  // Now abort step-2 while it is waiting in alias slot
  controller2.abort(new Error('second execution cancelled'))

  const abortedResult = await runPromise2
  assert.equal(abortedResult.status, 'cancelled')
  assert.equal(abortedResult.stepResults[0].status, 'cancelled')
  assert.match(abortedResult.stepResults[0].error, /second execution cancelled/)
  assert.ok(Array.isArray(abortedResult.stepResults))
  assert.ok(abortedResult.summary)

  // The second plan invocation has its own execution state and may start independently.
  assert.equal(harness.continuableStarts.length, 2)

  // Finish step-1 now
  harness.emit({ type: 'subagent/end', id: childId1, stopReason: 'completed', lastAssistantMessage: [] })
  await runPromise1

  // Start step-3 on the now-released alias to verify the queue is cleared and functioning
  const runPromise3 = runPlanTool.execute({
    plan: {
      goal: 'g',
      steps: [
        { title: 'step-3', summary: 'a', prompt: 'p3' }
      ]
    },
    wait: true
  }, { agent: harness.parent, signal })

  await new Promise((resolve) => setTimeout(resolve, 10))
  // Verify step-3 started successfully on the released slot
  assert.equal(harness.continuableStarts.length, 3)
  const childId3 = 'child-3'

  harness.emit({ type: 'subagent/end', id: childId3, stopReason: 'completed', lastAssistantMessage: [] })
  await runPromise3
})

test('smart_subagent_status time metrics and boundary conditions', async () => {
  const harness = createContext({ ...settings, requirePlanConfirmation: false })
  
  const mockAgents = new Map()
  const originalGet = harness.ctx.get
  harness.ctx.get = (name) => {
    if (name === 'agents') return { get(id) { return mockAgents.get(id) } }
    return originalGet(name)
  }
  
  await apply(harness.ctx)
  
  const runPlanTool = harness.tools.get('smart_subagent_run_plan')
  const statusTool = harness.tools.get('smart_subagent_status')
  const waitTool = harness.tools.get('smart_subagent_wait')
  const signal = new AbortController().signal
  
  // 1. Start a running child (using title with no-end to keep it running)
  mockAgents.set('child-run-1', { id: 'child-run-1', session: { events: [{ type: 'subagent/descriptor', data: { mode: 'continuable', label: 'no-end' } }] } })
  const result = await runPlanTool.execute({
    plan: { goal: 'g', steps: [{ title: 'no-end', summary: 'a', prompt: 'p' }] },
    wait: false,
  }, { agent: harness.parent, signal })
  
  const childId = result.dispatched[0].childId
  
  // Verify running child has startedAt and no endedAt/durationMs
  let status = await statusTool.execute({}, { agent: harness.parent, signal })
  assert.equal(status.subagents.length, 1)
  const child = status.subagents[0]
  assert.equal(child.subagentId, childId)
  assert.equal(child.status, 'running')
  assert.match(child.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.equal(child.endedAt, undefined)
  assert.equal(child.durationMs, undefined)
  
  // 2. Emit end event and check for endedAt and durationMs
  await new Promise((resolve) => setTimeout(resolve, 10))
  harness.emit({ type: 'subagent/end', id: childId, stopReason: 'completed', lastAssistantMessage: [] })
  
  status = await statusTool.execute({}, { agent: harness.parent, signal })
  assert.equal(status.subagents.length, 1)
  const childEnded = status.subagents[0]
  assert.equal(childEnded.status, 'settled')
  assert.match(childEnded.endedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.ok(typeof childEnded.durationMs === 'number' && childEnded.durationMs >= 0)
  assert.ok(Number.isInteger(childEnded.durationMs))
  
  // 3. Duplicate end events should not overwrite the first end result
  const firstEndedAt = childEnded.endedAt
  const firstDuration = childEnded.durationMs
  await new Promise((resolve) => setTimeout(resolve, 10))
  harness.emit({ type: 'subagent/end', id: childId, stopReason: 'another-reason', lastAssistantMessage: [] })
  
  status = await statusTool.execute({}, { agent: harness.parent, signal })
  const childDoubleEnded = status.subagents[0]
  assert.equal(childDoubleEnded.endedAt, firstEndedAt)
  assert.equal(childDoubleEnded.durationMs, firstDuration)
  assert.equal(childDoubleEnded.stopReason, 'completed')
  
  // 4. Early end then track still has full time fields
  const earlyId = 'child-early-end'
  mockAgents.set(earlyId, { id: earlyId, session: { events: [{ type: 'subagent/descriptor', data: { mode: 'continuable', label: 'early-label' } }] } })
  
  harness.emit({ type: 'subagent/end', id: earlyId, stopReason: 'completed', lastAssistantMessage: [] })
  harness.emit({ type: 'subagent/start', id: earlyId, parent: harness.parent })
  
  status = await statusTool.execute({}, { agent: harness.parent, signal })
  const earlyChild = status.subagents.find((x) => x.subagentId === earlyId)
  assert.ok(earlyChild)
  assert.equal(earlyChild.status, 'settled')
  assert.match(earlyChild.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.match(earlyChild.endedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.ok(earlyChild.durationMs >= 0)
  
  // 5. Parent dispose should record endedAt and durationMs for any remaining running child
  mockAgents.set('child-run-2', { id: 'child-run-2', session: { events: [{ type: 'subagent/descriptor', data: { mode: 'continuable', label: 'no-end-2' } }] } })
  const runResult2 = await runPlanTool.execute({
    plan: { goal: 'g', steps: [{ title: 'no-end-2', summary: 'a', prompt: 'p' }] },
    wait: false,
  }, { agent: harness.parent, signal })
  const childId2 = runResult2.dispatched[0].childId
  
  const waitPromise = waitTool.execute({}, { agent: harness.parent, signal })
  harness.emit({ type: 'agent/disposed', agent: harness.parent })
  
  const waitRes = await waitPromise
  assert.ok(waitRes.settlements.length > 0)
  const disposedSettle = waitRes.settlements.find((x) => x.subagentId === childId2)
  assert.ok(disposedSettle)
  assert.equal(disposedSettle.stopReason, 'aborted')
  assert.match(disposedSettle.endedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.ok(disposedSettle.durationMs >= 0)
})

test('smart_subagent_run_plan alias concurrency, FIFO queueing, cancellation, and recovery semantics', async () => {
  const harness = createContext({
    mode: 'automatic',
    planningMode: 'automatic',
    models: [
      { alias: 'alias-a', provider: 'p', model: 'm', purpose: 'a', allowExecution: true, allowPlanning: true },
      { alias: 'alias-b', provider: 'p', model: 'm', purpose: 'b', allowExecution: true, allowPlanning: true }
    ],
    requirePlanConfirmation: false
  })

  await apply(harness.ctx)
  const runPlanTool = harness.tools.get('smart_subagent_run_plan')
  const signal = new AbortController().signal

  // 1. Scenario A & B: FIFO Queueing and step-level abort
  const controllerA2 = new AbortController()
  const runPromise = runPlanTool.execute({
    plan: {
      goal: 'g',
      steps: [
        { title: 'no-end-1', summary: 'a', prompt: 'p1' }, // A1: starts immediately, blocks alias-a
        { title: 'no-end-2', summary: 'a', prompt: 'p2' }, // A2: waits, to be cancelled
        { title: 'no-end-3', summary: 'a', prompt: 'p3' }  // A3: waits
      ]
    },
    wait: true
  }, { agent: harness.parent, signal, stepSignals: { 'no-end-2': controllerA2.signal } })

  // Let A1 start and A2, A3 queue up
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(harness.continuableStarts.length, 1) // Only A1 started
  assert.equal(harness.continuableStarts[0].label, '1:no-end-1')

  // Cancel A2 while queued
  controllerA2.abort(new Error('A2 cancelled'))

  // Finish A1 now
  harness.emit({ type: 'subagent/end', id: 'child-1', stopReason: 'completed', lastAssistantMessage: [] })

  // Wait a bit. A3 should start directly, bypassing A2
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(harness.continuableStarts.length, 2)
  assert.equal(harness.continuableStarts[1].label, '3:no-end-3') // A3 started

  // Finish A3 to let the runPromise complete
  harness.emit({ type: 'subagent/end', id: 'child-2', stopReason: 'completed', lastAssistantMessage: [] })
  const res = await runPromise

  // Verify A2 is logged as cancelled, A1 and A3 settled
  assert.equal(res.status, 'partial')
  const a2Result = res.stepResults.find((x) => x.stepIndex === 1)
  assert.ok(a2Result)
  assert.equal(a2Result.status, 'cancelled')
  assert.equal(a2Result.error, 'A2 cancelled')

  // 2. Scenario C: Different alias parallel execution
  const runPromiseB = runPlanTool.execute({
    plan: {
      goal: 'g',
      steps: [
        { title: 'no-end-block-a', summary: 'a', prompt: 'p1' }, // Uses alias-a, blocks it
        { title: 'no-end-block-b', summary: 'b', prompt: 'p2' }  // Uses alias-b, should start immediately
      ]
    },
    wait: false
  }, { agent: harness.parent, signal })

  await new Promise((resolve) => setTimeout(resolve, 15))
  // Both steps must start in parallel since they use different aliases
  assert.equal(harness.continuableStarts.length, 4)

  // Clean up block-a and block-b
  harness.emit({ type: 'subagent/end', id: 'child-3', stopReason: 'completed', lastAssistantMessage: [] })
  harness.emit({ type: 'subagent/end', id: 'child-4', stopReason: 'completed', lastAssistantMessage: [] })
  await runPromiseB

  // 3. Scenario E: startBackground failure recovery
  const runPromiseFail = runPlanTool.execute({
    plan: {
      goal: 'g',
      steps: [
        { title: 'fail-start', summary: 'a', prompt: 'p1' }, // A1: throws on start background, releases slot
        { title: 'no-end-after-fail', summary: 'a', prompt: 'p2' } // A2: should start successfully after A1 fails
      ]
    },
    wait: true
  }, { agent: harness.parent, signal })

  await new Promise((resolve) => setTimeout(resolve, 15))
  // Verify A2 is started because A1 failed and released the slot
  assert.equal(harness.continuableStarts.length, 5)
  assert.equal(harness.continuableStarts[4].label, '2:no-end-after-fail')

  // Clean up A2
  harness.emit({ type: 'subagent/end', id: 'child-5', stopReason: 'completed', lastAssistantMessage: [] })
  const failRes = await runPromiseFail
  assert.equal(failRes.status, 'partial')
  const failResult = failRes.stepResults.find((x) => x.stepIndex === 0)
  assert.ok(failResult)
  assert.equal(failResult.status, 'failed')
  assert.equal(failResult.error, 'mock startBackground failure')
})

test('smart_subagent_run_plan DAG dependency failure propagation and result aggregation', async () => {
  const harness = createContext({
    mode: 'automatic',
    planningMode: 'automatic',
    models: [
      { alias: 'alias-a', provider: 'p', model: 'm', purpose: 'a', allowExecution: true, allowPlanning: true }
    ],
    requirePlanConfirmation: false
  })

  await apply(harness.ctx)
  const runPlanTool = harness.tools.get('smart_subagent_run_plan')
  const signal = new AbortController().signal

  // Construct DAG:
  // A (0), B (1, fail-start), G (2)
  // C (3, depends A), D (4, depends B)
  // E (5, depends C), F (6, depends D)
  const planArgs = {
    plan: {
      goal: 'g',
      steps: [
        { title: 'A', summary: 'a', prompt: 'p' },
        { title: 'B-fail-start', summary: 'a', prompt: 'p' }, // B: will throw start background
        { title: 'G', summary: 'a', prompt: 'p' },
        { title: 'C', summary: 'a', prompt: 'p', dependsOn: ['A'] },
        { title: 'D', summary: 'a', prompt: 'p', dependsOn: ['B-fail-start'] },
        { title: 'E', summary: 'a', prompt: 'p', dependsOn: ['C'] },
        { title: 'F', summary: 'a', prompt: 'p', dependsOn: ['D'] }
      ]
    },
    wait: true
  }

  const runPromise = runPlanTool.execute(planArgs, { agent: harness.parent, signal })

  // Let layer 0 start
  await new Promise((resolve) => setTimeout(resolve, 15))

  // At this point:
  // - G (child-6) and A (child-7) are running.
  // - B failed immediately.
  // - D got skipped during layer 1 dispatch (since B is failed).
  // - F got skipped during layer 2 dispatch (since D is skipped).
  
  // Finish A and G
  harness.emit({ type: 'subagent/end', id: 'child-6', stopReason: 'completed', lastAssistantMessage: [] })
  harness.emit({ type: 'subagent/end', id: 'child-7', stopReason: 'completed', lastAssistantMessage: [] })

  // Wait for layer 1 to dispatch C
  await new Promise((resolve) => setTimeout(resolve, 15))

  // Finish C
  harness.emit({ type: 'subagent/end', id: 'child-8', stopReason: 'completed', lastAssistantMessage: [] })

  // Wait for layer 2 to dispatch E
  await new Promise((resolve) => setTimeout(resolve, 15))

  // Finish E
  harness.emit({ type: 'subagent/end', id: 'child-9', stopReason: 'completed', lastAssistantMessage: [] })

  const result = await runPromise

  // Verify results aggregation
  assert.equal(result.status, 'partial')
  assert.equal(result.stepResults.length, 7)
  
  // Results must be sorted by stepIndex
  for (let i = 0; i < 7; i++) {
    assert.equal(result.stepResults[i].stepIndex, i)
  }

  // A, C, E, G -> completed
  assert.equal(result.stepResults[0].status, 'completed') // A
  assert.equal(result.stepResults[2].status, 'completed') // G
  assert.equal(result.stepResults[3].status, 'completed') // C
  assert.equal(result.stepResults[5].status, 'completed') // E

  // B -> failed
  assert.equal(result.stepResults[1].status, 'failed')

  // D -> skipped (blocked by B)
  assert.equal(result.stepResults[4].status, 'skipped')
  assert.deepEqual(result.stepResults[4].blockedBy, [1])
  assert.equal(result.stepResults[4].reason, 'dependency-not-completed')

  // F -> skipped (blocked by D)
  assert.equal(result.stepResults[6].status, 'skipped')
  assert.deepEqual(result.stepResults[6].blockedBy, [4])
  assert.equal(result.stepResults[6].reason, 'dependency-not-completed')

  // Verify summary counts
  assert.deepEqual(result.summary, {
    total: 7,
    completed: 4,
    failed: 1,
    cancelled: 0,
    timeout: 0,
    skipped: 2
  })
})

test('smart_subagent_run_plan handles an early error before tracking and skips dependents', async () => {
  const harness = createContext({
    mode: 'automatic',
    planningMode: 'automatic',
    models: [
      { alias: 'alias-a', provider: 'p', model: 'm', purpose: 'a', allowExecution: true, allowPlanning: true }
    ],
    requirePlanConfirmation: false
  })

  await apply(harness.ctx)
  const result = await harness.tools.get('smart_subagent_run_plan').execute({
    plan: {
      goal: 'early error',
      steps: [
        { title: 'early-error', summary: 'fails early', prompt: 'p' },
        { title: 'dependent', dependsOn: ['early-error'] },
        { title: 'downstream', dependsOn: ['dependent'] }
      ]
    },
    wait: true
  }, { agent: harness.parent, signal: new AbortController().signal })

  assert.equal(result.stepResults[0].status, 'failed')
  assert.equal(result.stepResults[1].status, 'skipped')
  assert.deepEqual(result.stepResults[1].blockedBy, [0])
  assert.equal(result.stepResults[2].status, 'skipped')
  assert.deepEqual(result.stepResults[2].blockedBy, [1])
})

test('smart_subagent_run_plan enableBackground:false error mapping for foreground runs', async () => {
  const harness = createContext({
    mode: 'automatic',
    planningMode: 'automatic',
    enableBackground: false,
    foregroundTimeoutMs: 100,
    foregroundOutcomes: [
      { stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] },
      { stopReason: 'timeout', output: [] },
      { stopReason: 'aborted', output: [] },
      { stopReason: 'interrupted', output: [] },
      { stopReason: 'error', output: [] },
      { startError: new Error('real start failure') }
    ],
    models: [
      { alias: 'alias-a', provider: 'p', model: 'm', purpose: 'a', allowExecution: true, allowPlanning: true }
    ],
    requirePlanConfirmation: false
  })

  await apply(harness.ctx)
  const runPlanTool = harness.tools.get('smart_subagent_run_plan')
  const signal = new AbortController().signal

  const planArgs = {
    plan: {
      goal: 'test error mapping',
      steps: [
        { title: 'step-ok', summary: 'ok', prompt: 'p' },
        { title: 'step-timeout', summary: 'timeout', prompt: 'p' },
        { title: 'step-aborted', summary: 'aborted', prompt: 'p' },
        { title: 'step-interrupted', summary: 'interrupted', prompt: 'p' },
        { title: 'step-error', summary: 'error', prompt: 'p' },
        { title: 'step-throw-error', summary: 'throw-error', prompt: 'p' }
      ]
    },
    wait: true
  }

  const result = await runPlanTool.execute(planArgs, { agent: harness.parent, signal })

  // Verify results aggregation
  assert.equal(result.status, 'partial')
  assert.equal(result.stepResults.length, 6)

  // Results must match error mappings
  const rOk = result.stepResults.find((x) => x.title === 'step-ok')
  const rTimeout = result.stepResults.find((x) => x.title === 'step-timeout')
  const rAborted = result.stepResults.find((x) => x.title === 'step-aborted')
  const rInterrupted = result.stepResults.find((x) => x.title === 'step-interrupted')
  const rError = result.stepResults.find((x) => x.title === 'step-error')
  const rThrow = result.stepResults.find((x) => x.title === 'step-throw-error')

  assert.equal(rOk.status, 'completed')
  assert.equal(rTimeout.status, 'timeout')
  assert.equal(rAborted.status, 'cancelled')
  assert.equal(rInterrupted.status, 'cancelled')
  assert.equal(rError.status, 'failed')
  assert.equal(rThrow.status, 'failed')

  // Verify errors are retained
  assert.ok(rTimeout.error.includes('unexpected') || rTimeout.error.includes('timeout'))
  assert.ok(rAborted.error.includes('cancelled'))
  assert.ok(rInterrupted.error.includes('unexpected') || rInterrupted.error.includes('interrupted'))
  assert.ok(rError.error.includes('failed') || rError.error.includes('unexpected'))
  assert.equal(rThrow.error, 'real start failure')
})

test('routing mode: selection_mode overrides configured routing mode and selections can resume', async () => {
  const harness = createContext({ ...settings, mode: 'automatic', idleTimeoutMs: 50 })
  await apply(harness.ctx)
  const runPlanTool = harness.tools.get('smart_subagent_run_plan')
  
  // 1. selection_mode: 'ask' overrides settings.mode === 'automatic'
  const resultAsk = await runPlanTool.execute({
    plan: { goal: 'g', steps: [{ title: 'step1', summary: 's', prompt: 'p' }] },
    selection_mode: 'ask'
  }, { agent: harness.parent, signal: new AbortController().signal })
  assert.equal(resultAsk.status, 'awaiting-choice')
  assert.equal(resultAsk.step.recommendation, 'fast')
  
  // 2. Resume with selections
  const resultResume = await runPlanTool.execute({
    plan: { goal: 'g', steps: [{ title: 'step1', summary: 's', prompt: 'p' }] },
    selections: { 'step1': 'fast' }
  }, { agent: harness.parent, signal: new AbortController().signal })
  assert.equal(resultResume.status, 'completed')
  assert.equal(resultResume.dispatched.length, 1)
})

test('planning mode: main-agent planning mode returns plan directly', async () => {
  const harness = createContext({ ...settings, planningMode: 'main-agent', idleTimeoutMs: 50 })
  await apply(harness.ctx)
  const planTool = harness.tools.get('smart_subagent_plan')
  const result = await planTool.execute({
    goal: 'Build app',
    plan: { goal: 'Build app', steps: [{ title: 'step1', summary: 's', prompt: 'p' }] }
  }, { agent: harness.parent, signal: new AbortController().signal })
  assert.equal(result.mode, 'main-agent')
  assert.equal(result.plan.steps.length, 1)
})

test('planning mode: fixed planning mode uses plannerAlias and fails if invalid', async () => {
  const harness = createContext({ ...settings, planningMode: 'fixed', plannerAlias: 'fast', idleTimeoutMs: 50 })
  await apply(harness.ctx)
  const planTool = harness.tools.get('smart_subagent_plan')
  const result = await planTool.execute({ goal: 'Build app' }, { agent: harness.parent, signal: new AbortController().signal })
  assert.equal(result.mode, 'planner-model')
  assert.equal(result.planner, 'fast')
  
  const harnessInvalid = createContext({ ...settings, planningMode: 'fixed', plannerAlias: 'nonexistent', idleTimeoutMs: 50 })
  await apply(harnessInvalid.ctx)
  const planToolInvalid = harnessInvalid.tools.get('smart_subagent_plan')
  await assert.rejects(
    planToolInvalid.execute({ goal: 'Build app' }, { agent: harnessInvalid.parent, signal: new AbortController().signal }),
    /planner alias "nonexistent" is not enabled/
  )
})

test('planning mode: ask planning mode returns ask result with choices and can resume', async () => {
  const harness = createContext({ ...settings, planningMode: 'ask', idleTimeoutMs: 50 })
  await apply(harness.ctx)
  const planTool = harness.tools.get('smart_subagent_plan')
  const result = await planTool.execute({ goal: 'Build app' }, { agent: harness.parent, signal: new AbortController().signal })
  assert.equal(result.mode, 'ask')
  assert.ok(result.choices.length > 0)
  
  // Can resume planning by passing the selected planner explicitly
  const resultResumed = await planTool.execute({ goal: 'Build app', planner: 'fast' }, { agent: harness.parent, signal: new AbortController().signal })
  assert.equal(resultResumed.mode, 'planner-model')
  assert.equal(resultResumed.planner, 'fast')
})