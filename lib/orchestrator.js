const MAX_PLAN_STEPS = 100

function normalizePlanSteps(plan) {
  if (typeof plan !== 'object' || plan === null) throw new Error('plan must be an object')
  if (typeof plan.goal !== 'string' || plan.goal.trim() === '') throw new Error('plan.goal is required')
  if (!Array.isArray(plan.steps)) throw new Error('plan.steps must be an array')
  if (plan.steps.length === 0) return { goal: plan.goal.trim(), steps: [], layers: [] }

  const total = plan.steps.length
  if (total > MAX_PLAN_STEPS) throw new Error(`plan.steps exceeds maximum of ${MAX_PLAN_STEPS}`)
  const steps = plan.steps.map((step, index) => {
    if (typeof step !== 'object' || step === null) throw new Error(`plan.steps[${index}] must be an object`)
    const title = typeof step.title === 'string' && step.title.trim() ? step.title.trim() : `Step ${index + 1}`
    const summary = typeof step.summary === 'string' && step.summary.trim() ? step.summary.trim() : title
    const prompt = typeof step.prompt === 'string' && step.prompt.trim() ? step.prompt.trim() : summary
    const dependsOn = Array.isArray(step.dependsOn) ? step.dependsOn.slice() : []
    return { title, summary, prompt, dependsOn }
  })

  const titleIndex = new Map()
  steps.forEach((step, index) => {
    if (titleIndex.has(step.title)) throw new Error(`duplicate step title "${step.title}"`)
    titleIndex.set(step.title, index)
  })

  // Resolve each dependsOn reference to a step index. Accept:
  //   - 1-based numeric index as a string ("1", "2", …)
  //   - "step N" (case-insensitive)
  //   - exact step title
  // Reject self-dependency, duplicates, and unknown references.
  const resolved = steps.map((step, index) => {
    const seen = new Set()
    const resolvedDeps = step.dependsOn.map((raw) => {
      const text = typeof raw === 'string' ? raw.trim() : String(raw)
      if (text === '') throw new Error(`plan.steps[${index}].dependsOn contains an empty reference`)
      let target = -1
      const numeric = typeof raw === 'number' ? raw : Number(text)
      if (Number.isInteger(numeric) && (typeof raw === 'number' || String(numeric) === text)) {
        if (numeric < 1 || numeric > total) throw new Error(`plan.steps[${index}].dependsOn references unknown step index ${numeric}`)
        target = numeric - 1
      } else {
        const stepRef = text.match(/^step\s+(\d+)$/i)
        if (stepRef !== null) {
          const numericRef = Number(stepRef[1])
          if (numericRef < 1 || numericRef > total) throw new Error(`plan.steps[${index}].dependsOn references unknown step "${raw}"`)
          target = numericRef - 1
        } else {
          const titleMatch = titleIndex.get(text)
          if (titleMatch === undefined) throw new Error(`plan.steps[${index}].dependsOn references unknown step "${raw}"`)
          target = titleMatch
        }
      }
      if (target === index) throw new Error(`plan.steps[${index}].dependsOn references itself`)
      if (seen.has(target)) throw new Error(`plan.steps[${index}].dependsOn repeats reference "${raw}"`)
      seen.add(target)
      return target
    })
    return { title: step.title, summary: step.summary, prompt: step.prompt, dependsOn: resolvedDeps }
  })

  // Kahn's algorithm with topological layering.
  // For each step X, `outstanding[X]` = number of prerequisites (dependsOn) still unmet.
  // A step is ready when outstanding[X] === 0. We seed layer 0 with every step whose
  // dependsOn is empty; each subsequent layer collects steps whose prerequisites are
  // all in earlier layers.
  const outstanding = resolved.map((step) => step.dependsOn.length)
  const reverseEdges = resolved.map(() => [])
  for (let index = 0; index < resolved.length; index += 1) {
    for (const prerequisite of resolved[index].dependsOn) reverseEdges[prerequisite].push(index)
  }
  const ready = []
  for (let index = 0; index < resolved.length; index += 1) if (outstanding[index] === 0) ready.push(index)
  const layers = []
  if (ready.length > 0) layers.push(ready.slice())
  while (ready.length > 0) {
    const nextLayer = []
    for (const index of ready) {
      for (const dependent of reverseEdges[index]) {
        outstanding[dependent] -= 1
        if (outstanding[dependent] === 0) nextLayer.push(dependent)
      }
    }
    ready.length = 0
    for (const index of nextLayer) ready.push(index)
    if (ready.length > 0) layers.push(ready.slice())
  }
  for (let index = 0; index < resolved.length; index += 1) {
    if (outstanding[index] > 0) throw new Error(`plan.steps contains a cycle involving step "${resolved[index].title}"`)
  }
  return { goal: plan.goal.trim(), steps: resolved, layers }
}

function planSummary(plan) {
  return `Goal: ${plan.goal}\n` + plan.steps.map((step, index) => `Step ${index + 1}: ${step.title} — ${step.summary}`).join('\n')
}

export { normalizePlanSteps, planSummary }