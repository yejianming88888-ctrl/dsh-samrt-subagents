const SUPPORTED_REASONING_EFFORTS = new Set(['low', 'medium', 'high'])

async function scanModels(llm) {
  const providers = llm.listProviders()
  return Promise.all(providers.map(async (provider) => {
    try {
      const models = await llm.listModels(provider.id)
      return {
        id: provider.id,
        name: provider.name,
        models: await Promise.all(models.map(async (model) => {
          let resolved
          try {
            resolved = await llm.resolveModelInfo(provider.id, model.id)
          } catch {
            // Keep the directory entry usable when exact metadata resolution fails.
          }
          const efforts = resolved?.reasoning?.efforts
          return {
            id: model.id,
            name: model.name,
            ...(model.description === undefined ? {} : { description: model.description }),
            ...(model.inputModalities === undefined ? {} : { inputModalities: [...model.inputModalities] }),
            ...(Array.isArray(efforts) ? {
              reasoningEfforts: [...new Set(efforts.map((effort) => effort.id).filter((effort) => SUPPORTED_REASONING_EFFORTS.has(effort)))],
            } : {}),
          }
        })),
      }
    } catch (error) {
      return { id: provider.id, name: provider.name, models: [], error: error instanceof Error ? error.message : String(error) }
    }
  }))
}

export { scanModels, SUPPORTED_REASONING_EFFORTS }
