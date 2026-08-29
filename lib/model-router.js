// Default preferred aliases in priority order (first = highest priority)
const DEFAULT_PREFERRED_ALIASES = [
  'minimax-m2-7',
  'gpt-5-6-luna',
  'antigravity-gemini-3-6-flash',
  'gpt-5-6-terra',
  'gpt-5-4',
  'antigravity-gemini-3-7-flash',
]

function words(value) {
  return new Set(String(value).toLowerCase().match(/[a-z0-9\u4e00-\u9fff-]+/g) ?? [])
}

function scoreModel(model, task, role = 'execution') {
  if (!model.enabled) return Number.NEGATIVE_INFINITY
  if (role === 'planning' && !model.allowPlanning) return Number.NEGATIVE_INFINITY
  if (role === 'execution' && !model.allowExecution) return Number.NEGATIVE_INFINITY
  const taskWords = words(task)
  const profileWords = words(`${model.purpose} ${model.tags.join(' ')}`)
  let score = 0
  for (const token of taskWords) if (profileWords.has(token)) score += 2
  for (const tag of model.tags) if (String(task).toLowerCase().includes(tag)) score += 3
  // Apply preferred-alias bonus: lower index = higher bonus
  const prefIndex = DEFAULT_PREFERRED_ALIASES.findIndex((pref) => model.alias === pref || model.model === pref)
  if (prefIndex >= 0) score += (DEFAULT_PREFERRED_ALIASES.length - prefIndex)
  return score
}

function recommendModel(models, task, role = 'execution') {
  const ranked = models.map((model, index) => ({ model, index, score: scoreModel(model, task, role) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score || a.index - b.index)
  if (ranked.length === 0) throw new Error(`no enabled model is allowed for ${role}`)
  const winner = ranked[0]
  return {
    model: winner.model,
    reason: winner.score > 0
      ? `The task overlaps the configured purpose or tags for ${winner.model.displayName}.`
      : `${winner.model.displayName} is the first enabled model allowed for ${role}; no stronger purpose match was found.`,
  }
}

export { recommendModel, scoreModel }
