function failureFor(reason) {
  if (reason === 'completed') return undefined
  if (reason === 'aborted') return 'subagent run was cancelled'
  if (reason === 'error') return 'subagent run failed'
  if (reason === 'max-tokens') return 'subagent reached its token limit'
  if (reason === 'refusal') return 'subagent refused the task'
  return `subagent stopped unexpectedly (${String(reason)})`
}

function runError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, stopReason: code, ...details })
}

const FAILURE_TYPES = new Set(['timeout', 'model-error', 'auth', 'transport', 'protocol', 'cancelled'])
function classifyFailure(reason, message = '') {
  const value = String(reason ?? '').toLowerCase()
  const text = String(message).toLowerCase()
  if (value === 'timeout' || text.includes('timeout') || text.includes('timed out')) return 'timeout'
  if (value === 'aborted' || value === 'interrupted' || value === 'cancelled') return 'cancelled'
  if (value.includes('auth') || value.includes('permission') || text.includes('unauthoriz') || text.includes('forbidden')) return 'auth'
  if (value.includes('transport') || value.includes('network') || text.includes('network') || text.includes('econn')) return 'transport'
  if (value.includes('protocol') || text.includes('protocol') || text.includes('invalid response')) return 'protocol'
  return FAILURE_TYPES.has(value) ? value : 'model-error'
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\\u0000-\\u001f\\u007f]/g, ' ').slice(0, 4096)
}

const MAX_PARTIAL_ERROR_TEXT = 64 * 1024
const MAX_RESULT_TEXT = 256 * 1024
function boundedOutput(output) {
  if (!Array.isArray(output)) return []
  let remaining = MAX_RESULT_TEXT
  return output.slice(0, 256).map((block) => {
    if (!block || typeof block !== 'object' || typeof block.text !== 'string') return block
    const text = block.text.slice(0, Math.max(0, remaining))
    remaining -= text.length
    return text.length === block.text.length ? block : { ...block, text, truncated: true }
  })
}
function withPartialText(error, output) {
  let text = ''
  for (const block of Array.isArray(output) ? output : []) {
    if (block?.type !== 'text' || typeof block.text !== 'string' || text.length >= MAX_PARTIAL_ERROR_TEXT) continue
    text += block.text.slice(0, MAX_PARTIAL_ERROR_TEXT - text.length)
  }
  return text.length === 0 ? error : `${error}\nPartial output before the run ended:\n${text}${text.length >= MAX_PARTIAL_ERROR_TEXT ? '\n[partial output truncated]' : ''}`
}

// A plugin-instance gate shared by every delegation entry point. Queued
// acquisitions are FIFO and cancellation removes only that waiter.
function createConcurrencyGate(limit = 3) {
  let max = limit
  let active = 0
  const queue = []
  const tracked = new Map()
  const ended = new Set()
  const pump = () => {
    while (active < max && queue.length > 0) {
      const entry = queue.shift()
      if (entry.cancelled) continue
      entry.acquired = true
      active += 1
      entry.resolve(() => {
        if (entry.released) return
        entry.released = true
        active -= 1
        pump()
      })
    }
  }
  return {
    setLimit(next) {
      if (!Number.isSafeInteger(next) || next <= 0) throw new Error('maxConcurrentSubagents must be a positive integer')
      max = next
      pump()
    },
    get active() { return active },
    get queued() { return queue.filter((entry) => !entry.cancelled).length },
    track(childId, release, timeoutMs, onTimeout) {
      if (ended.has(childId)) { release?.(); return }
      if (tracked.has(childId)) return
      let timer
      const entry = { release }
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (tracked.get(childId) !== entry) return
          tracked.delete(childId)
          try { onTimeout?.(childId) } catch {}
          release?.()
        }, timeoutMs)
      }
      entry.timer = timer
      tracked.set(childId, entry)
    },
    end(childId) {
      const entry = tracked.get(childId)
      if (entry !== undefined) {
        tracked.delete(childId)
        if (entry.timer !== undefined) clearTimeout(entry.timer)
        entry.release?.()
      }
      ended.add(childId)
      if (ended.size > 1000) ended.delete(ended.values().next().value)
    },
    release(childId) { this.end(childId) },
    dispose(reason = runError('aborted', 'concurrency gate was disposed')) {
      for (const entry of queue.splice(0)) {
        if (entry.acquired || entry.cancelled) continue
        entry.cancelled = true
        entry.reject(reason)
      }
      for (const entry of tracked.values()) {
        if (entry.timer !== undefined) clearTimeout(entry.timer)
        entry.release?.()
      }
      tracked.clear()
      ended.clear()
    },
    acquire(signal) {
      if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : runError('aborted', 'subagent run was cancelled'))
      return new Promise((resolve, reject) => {
        const entry = { resolve, reject, cancelled: false, acquired: false, released: false }
        let onAbort
        const cancel = () => {
          if (entry.acquired || entry.cancelled) return
          entry.cancelled = true
          if (onAbort) signal.removeEventListener('abort', onAbort)
          reject(signal.reason instanceof Error ? signal.reason : runError('aborted', 'subagent run was cancelled'))
        }
        if (signal) { onAbort = cancel; signal.addEventListener('abort', onAbort, { once: true }) }
        const originalResolve = resolve
        entry.resolve = (release) => {
          if (onAbort) signal?.removeEventListener('abort', onAbort)
          originalResolve(release)
        }
        queue.push(entry)
        pump()
      })
    },
  }
}

async function runForeground(subagents, providerName, request, alias, options = {}) {
  const timeoutMs = options.timeoutMs
  const startedAt = Date.now()
  let startTimer
  let startAbortHandler
  let startCancelled = false
  let disposed = false
  const disposeOnce = async (lateRun, { silent = false } = {}) => {
    if (!lateRun || disposed) return
    disposed = true
    try {
      await lateRun.dispose?.()
    } catch (error) {
      if (silent) return
      throw error
    }
  }
  const startPromise = Promise.resolve().then(() => subagents.start(providerName, request))
  // A start can outlive either guard. Always attach this handler immediately so a
  // late live run is disposed exactly once, including abort during start.
  startPromise.then((lateRun) => startCancelled ? disposeOnce(lateRun, { silent: true }) : undefined).catch(() => {})
  let run
  try {
    run = await Promise.race([startPromise,
      ...(timeoutMs === undefined ? [] : [new Promise((_, reject) => {
        startTimer = setTimeout(() => { startCancelled = true; reject(runError('timeout', `subagent start timed out after ${timeoutMs}ms`)) }, timeoutMs)
      })]),
      ...(request.signal === undefined ? [] : [new Promise((_, reject) => {
        if (request.signal.aborted) { startCancelled = true; reject(runError('aborted', 'subagent run was cancelled')); return }
        startAbortHandler = () => { startCancelled = true; reject(runError('aborted', 'subagent run was cancelled')) }
        request.signal.addEventListener('abort', startAbortHandler, { once: true })
      })])
    ])
  } catch (error) {
    // Preserve the original code/stopReason if the provider attached one. A
    // bare Error with no code signals a real start failure, which is the
    // case the runner historically collapsed into the generic 'error'
    // bucket.
    const code = error?.code ?? error?.stopReason
    throw Object.assign(
      error instanceof Error ? error : runError('error', safeErrorMessage(error)),
      code === undefined ? { code: 'error', stopReason: 'error' } : {},
      { durationMs: Date.now() - startedAt }
    )
  } finally {
    clearTimeout(startTimer)
    if (request.signal && startAbortHandler) request.signal.removeEventListener('abort', startAbortHandler)
  }

  // The start and result share one wall-clock budget; do not reset it after start.
  const remaining = timeoutMs === undefined ? undefined : Math.max(0, timeoutMs - (Date.now() - startedAt))
  let timer
  let abortHandler
  let executionError
  let result
  try {
    if (request.signal?.aborted) throw runError('aborted', 'subagent run was cancelled')
    const guarded = new Promise((_, reject) => {
      if (remaining !== undefined) timer = setTimeout(() => reject(runError('timeout', `subagent run timed out after ${remaining}ms`)), remaining)
      if (request.signal) { abortHandler = () => reject(runError('aborted', 'subagent run was cancelled')); request.signal.addEventListener('abort', abortHandler, { once: true }) }
    })
    result = await Promise.race([run.result, guarded])
    const failure = failureFor(result.stopReason)
    if (failure !== undefined) throw Object.assign(new Error(withPartialText(failure, result.output)), { code: result.stopReason, stopReason: result.stopReason })
  } catch (error) {
    // Trust provider-supplied code/stopReason first, then fall back to the
    // synthesized 'error' bucket. This avoids painting a transport/auth
    // failure as the generic 'subagent run failed'.
    const code = error?.code ?? error?.stopReason ?? 'error'
    const stopReason = error?.stopReason ?? code
    executionError = Object.assign(
      error instanceof Error ? error : new Error(safeErrorMessage(error)),
      { code, stopReason, failureType: classifyFailure(code, error?.message), runId: run.id, durationMs: Date.now() - startedAt }
    )
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (request.signal && abortHandler) request.signal.removeEventListener('abort', abortHandler)
  }
  if (executionError !== undefined && options.parent !== undefined && typeof subagents.interrupt === 'function') {
    try { subagents.interrupt(run.id, { kind: 'ancestor', agent: options.parent }) } catch {}
  }
  let disposalError
  try { await disposeOnce(run) } catch (error) { disposalError = error }
  if (executionError !== undefined) throw executionError
  if (disposalError !== undefined) {
    // The run already completed; a disposal failure is a cleanup issue, not
    // a model failure. Surface it with a distinct code so the orchestrator
    // can classify it correctly instead of folding it into 'error'.
    throw runError('cleanup-failed', `subagent run disposal failed: ${safeErrorMessage(disposalError)}`, { runId: run.id, failureType: classifyFailure('error', disposalError.message), durationMs: Date.now() - startedAt })
  }
  return { kind: 'foreground', runId: run.id, model: alias, output: boundedOutput(result.output), stopReason: 'completed', durationMs: Date.now() - startedAt }
}

async function startBackground(subagents, providerName, request, alias) {
  const started = await subagents.startContinuable({ provider: providerName, label: request.label, request, signal: request.signal })
  return { kind: 'continuable', subagentId: started.childId, messageId: started.messageId, model: alias }
}

function buildRequest(parent, signal, selected, task, prompt, maxDepth) {
  return {
    label: task,
    prompt: [{ type: 'text', text: prompt }],
    parent,
    signal,
    maxDepth,
    agentOptions: {
      provider: selected.provider,
      model: selected.model,
      ...(selected.maxTokens === undefined ? {} : { maxTokens: selected.maxTokens }),
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
    },
  }
}

export { buildRequest, classifyFailure, createConcurrencyGate, failureFor, runForeground, safeErrorMessage, startBackground }
