function modelLine(model) {
  const tags = model.tags.length ? ` Tags: ${model.tags.join(', ')}.` : ''
  const roles = [model.allowPlanning ? 'planning' : '', model.allowExecution ? 'execution' : ''].filter(Boolean).join(' and ')
  return `- \`${model.alias}\` (${model.displayName}, ${model.provider}/${model.model}): ${model.purpose}${tags} Allowed for ${roles || 'no roles'}.`
}

function generateRoutingSkill(settings) {
  const enabled = settings.models.filter((model) => model.enabled)
  const modeRule = settings.mode === 'ask'
    ? 'Before every subagent delegation, ask the user which enabled model to use via the `smart_delegate` tool, which returns a recommendation and the available choices. Wait for the user choice and call `smart_delegate` again with the chosen alias.'
    : 'For every subtask, select the best enabled model from the user-authored purposes and tags via the `smart_delegate` tool. State the selected alias and a concise reason.'
  const planningRule = settings.planningMode === 'main-agent'
    ? 'You (the main agent) create the plan with `smart_subagent_plan`.'
    : settings.planningMode === 'fixed'
      ? `\`smart_subagent_plan\` uses \`${settings.plannerAlias}\` as the planning model.`
      : settings.planningMode === 'ask'
        ? 'Ask the user which planning model to use before requesting a plan.'
        : '`smart_subagent_plan` automatically chooses a planning-capable model from its purpose and tags.'
  return `# Smart Subagent Orchestration\n\nUse this skill when the user asks to plan work, delegate work, choose a subagent model, or run multiple agents.\n\n## Tool flow\n\n1. Call \`smart_subagent_model_catalog\` only when you need to inspect raw provider routes.\n2. Call \`smart_subagent_plan\` with the user goal. It returns a normalized plan and any required confirmation.\n3. After user confirmation (when required), call \`smart_subagent_run_plan\` with the same plan and \`wait: true\` so the plugin joins all background children before returning.\n4. If you must launch one task outside a plan, use \`smart_delegate\` directly.\n5. Use \`smart_subagent_status\` to inspect owned background children without waiting.\n6. Use \`smart_subagent_stop\` when an owned child is stuck or no longer needed.\n7. After all background delegations across the conversation, call \`smart_subagent_wait\` exactly once before synthesizing results.\n\n## Enabled model routes\n\n${enabled.length ? enabled.map(modelLine).join('\n') : '- No models are enabled. Do not delegate until the user configures one.'}\n\n## Planning\n\n${planningRule}\n${settings.requirePlanConfirmation ? 'Show the plan and obtain user confirmation before dispatching execution tasks.' : 'The plan may be dispatched without an extra confirmation.'}\n\n## Model selection\n\n${modeRule}\nOnly use enabled routes. User-authored model purposes override assumptions based on model names.\n\n## Delegation discipline\n\n- Keep the main conversation as the only coordinator allowed to delegate.\n- Child agents must not call delegation tools or create descendant agents.\n- Give each child one self-contained task and its relevant plan step.\n- Do not duplicate work already delegated.\n- Prefer background children for independent tasks when enabled.\n- Report failures, refusals, cancellation, and token limits as failures rather than successful completion.\n`
}

function skillContentForSettings(settings) {
  return typeof settings.customSkill === 'string' && settings.customSkill.trim() !== ''
    ? settings.customSkill
    : generateRoutingSkill(settings)
}

export { generateRoutingSkill, skillContentForSettings }
