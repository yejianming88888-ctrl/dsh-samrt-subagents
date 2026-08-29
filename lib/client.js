window.__ModuleLoader__.load({
  id: 'dsh-samrt-subagents',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const SETTINGS_ROUTE = '/dsh-smart-subagent-orchestrator/settings'
    const STORAGE_KEY = 'dsh-samrt-subagents.frontend-prototype.v1'
    const LOWEST = ['low', 'medium', 'high']

    const text = (value) => typeof value === 'string' ? value : ''
    const safeRead = () => { try { return typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY) } catch (_) { return null } }
    const safeWrite = (value) => { try { if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); return true } catch (_) { return false } }
    const safeClear = () => { try { if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY); return true } catch (_) { return false } }

    function lowest(efforts) { return LOWEST.find((x) => Array.isArray(efforts) && efforts.includes(x)) || 'low' }
    function routeAlias(providerId, modelId) {
      const value = `${text(providerId)}-${text(modelId)}`
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^[^a-z0-9]+|[-_]+$/g, '')
      return value || 'model'
    }

    function backendAlias(model) {
      const candidate = text(model?.alias)
      return /^[a-z0-9][a-z0-9_-]*$/.test(candidate) ? candidate : routeAlias(model?.provider, model?.model)
    }

    function selectLowestReasoningEffort(efforts) {
      if (!Array.isArray(efforts) || efforts.length === 0) return 'low'
      if (efforts.includes('low')) return 'low'
      if (efforts.includes('medium')) return 'medium'
      if (efforts.includes('high')) return 'high'
      return efforts[0]
    }

    function emptySettings(name) { return { name, foregroundTimeoutMs: '120000', idleTimeoutMs: '60000', maxConcurrentSubagents: '3', maxDepth: '1', enableBackground: true, models: [], customSkill: '', generatedSkill: '' } }
    
    function normalizeProfile(profile) {
      const s = profile && profile.settings ? profile.settings : {}
      const name = text(profile?.name) || '未命名配置'
      return {
        id: text(profile?.id) || `profile-${Date.now()}`,
        name,
        settings: {
          ...emptySettings(name),
          ...s,
          name: text(s.name) || name,
          models: Array.isArray(s.models) ? s.models : []
        }
      }
    }

    function normalizeStore(value) {
      let profiles = Array.isArray(value?.profiles) ? value.profiles.map(normalizeProfile) : []
      let globalProfileId = value?.globalProfileId
      if (!profiles.length && value && typeof value === 'object') {
        const name = text(value.name) || '默认配置'
        profiles = [normalizeProfile({ id: 'default', name, settings: value })]
        globalProfileId = 'default'
      }
      if (!profiles.length) return null
      const ids = new Set(profiles.map((profile) => profile.id))
      globalProfileId = ids.has(globalProfileId) ? globalProfileId : profiles[0].id
      const activeId = ids.has(value?.activeId) ? value.activeId : globalProfileId
      return { profiles, activeId, globalProfileId }
    }

    function initialStore() {
      try {
        const stored = safeRead()
        if (stored) {
          const normalized = normalizeStore(JSON.parse(stored))
          if (normalized) return normalized
        }
      } catch (_) {}

      const deepSeekModels = [
        {
          alias: 'deepseek-v4-flash', provider: 'deepseek-official', model: 'deepseek-v4-flash',
          displayName: 'DeepSeek-V4-Flash', maxTokens: '4096', purpose: '适合快速响应、日常编码、测试和常规开发任务。',
          tags: ['fast', 'coding'], reasoningEfforts: ['low', 'high'], reasoningEffort: 'low',
          enabled: true, allowPlanning: true, allowExecution: true,
        },
        {
          alias: 'deepseek-v4-pro', provider: 'deepseek-official', model: 'deepseek-v4-pro',
          displayName: 'DeepSeek-V4-Pro', maxTokens: '4096', purpose: '适合复杂推理、架构设计、代码审查和高难度开发任务。',
          tags: ['reasoning', 'coding'], reasoningEfforts: ['low', 'high'], reasoningEffort: 'low',
          enabled: true, allowPlanning: true, allowExecution: true,
        },
        {
          alias: 'deepseek-v4-flash-vision-exp', provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp',
          displayName: 'DeepSeek-V4-Flash-Vision-Exp', maxTokens: '4096', purpose: '适合包含图片理解的快速分析、界面检查和多模态任务。',
          tags: ['fast', 'vision'], reasoningEfforts: ['low', 'high'], reasoningEffort: 'low',
          enabled: true, allowPlanning: true, allowExecution: true,
        },
      ]
      const deepSeekProfile = normalizeProfile({
        id: 'deepseek-default',
        name: 'DeepSeek 配置',
        settings: {
          name: 'DeepSeek 配置', foregroundTimeoutMs: '120000', idleTimeoutMs: '60000',
          maxConcurrentSubagents: '3', maxDepth: '1', enableBackground: true,
          models: deepSeekModels, customSkill: '',
        },
      })

      return {
        profiles: [deepSeekProfile],
        activeId: 'deepseek-default',
        globalProfileId: 'deepseek-default'
      }
    }

    function generateSkillText(settings) {
      const modelLines = settings.models.map(m => {
        return `- **${m.displayName || m.model}** (Provider: ${m.provider})
  - Max Token: ${m.maxTokens}
  - 推理强度: ${m.reasoningEffort}
  - 用途: ${m.purpose}`
      }).join('\n')

      return `# Skill: ${settings.name}

## 基础参数
- 前台超时: ${settings.foregroundTimeoutMs} ms
- 空闲超时: ${settings.idleTimeoutMs} ms
- 最大并发子 Agent 数: ${settings.maxConcurrentSubagents}
- 最大委派深度: ${settings.maxDepth}
- 启用后台子 Agent: ${settings.enableBackground ? '是' : '否'}

## 选中模型与用途
${modelLines || '（未选择模型）'}
`
    }

    function toBackendProfileSettings(settings) {
      return {
        mode: settings.mode || 'automatic',
        planningMode: settings.planningMode || 'main-agent',
        plannerAlias: settings.plannerAlias || '',
        requirePlanConfirmation: settings.requirePlanConfirmation !== false,
        subagentProvider: settings.subagentProvider || 'spawn',
        foregroundTimeoutMs: Number(settings.foregroundTimeoutMs || 120000),
        idleTimeoutMs: Number(settings.idleTimeoutMs || 60000),
        maxConcurrentSubagents: Number(settings.maxConcurrentSubagents || 3),
        maxDepth: Number(settings.maxDepth || 1),
        enableBackground: Boolean(settings.enableBackground),
        showSelectionReason: settings.showSelectionReason !== false,
        customSkill: text(settings.customSkill),
        models: (settings.models || []).map(m => ({
          alias: backendAlias(m),
          provider: m.provider,
          model: m.model,
          displayName: m.displayName || m.alias || m.model,
          purpose: m.purpose || '',
          tags: Array.isArray(m.tags) ? m.tags : [],
          enabled: m.enabled !== false,
          allowPlanning: m.allowPlanning !== false,
          allowExecution: m.allowExecution !== false,
          maxTokens: m.maxTokens ? Number(m.maxTokens) : undefined,
          reasoningEffort: m.reasoningEffort || 'low',
          reasoningEfforts: Array.isArray(m.reasoningEfforts) ? m.reasoningEfforts : []
        }))
      }
    }

    function toBackendStore(store) {
      return {
        profiles: store.profiles.map((profile) => ({
          id: profile.id,
          name: profile.name,
          settings: toBackendProfileSettings(profile.settings)
        })),
        globalProfileId: store.globalProfileId
      }
    }

    const saveToBackend = async (store) => {
      if (typeof window === 'undefined' || typeof window.fetch !== 'function') return false
      try {
        const getRes = await window.fetch(SETTINGS_ROUTE)
        if (!getRes.ok) throw new Error('Failed to fetch settings descriptor')
        const { descriptor } = await getRes.json()
        const revision = descriptor?.revision

        const backendSettings = toBackendStore(store)

        const putRes = await window.fetch(SETTINGS_ROUTE, {
          method: 'PUT',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            section: backendSettings,
            expectedRevision: revision
          })
        })
        if (!putRes.ok) {
          const errPayload = await putRes.json().catch(() => ({}))
          throw new Error(errPayload.error || 'Failed to PUT settings')
        }
        return { ok: true }
      } catch (err) {
        console.error('[SmartSubagents] Failed to sync to backend settings:', err)
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }

    function ModelConfigCard({ model, onChange, onRemove }) {
      return h('div', { className: 'dsh-model-config-card' },
        h('div', { className: 'dsh-model-config-header' },
          h('span', { className: 'dsh-model-config-title' }, model.displayName || model.model),
          h('button', { type: 'button', className: 'dsh-model-config-remove', onClick: onRemove, title: '移除' }, '×')
        ),
        h('div', { className: 'dsh-form-group-row' },
          h('div', { className: 'dsh-form-group' },
            h('span', { className: 'dsh-label' }, 'Max Token'),
            h('input', {
              type: 'number',
              className: 'dsh-input',
              value: model.maxTokens || '',
              min: 1,
              placeholder: '默认',
              onChange: (e) => onChange({ maxTokens: e.target.value })
            })
          ),
          h('div', { className: 'dsh-form-group' },
            h('span', { className: 'dsh-label' }, '推理强度'),
            (() => {
              const efforts = model.reasoningEfforts || []
              if (efforts.length === 0) {
                return h('span', { style: { lineHeight: '32px', color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 } }, '未提供推理档位')
              } else if (efforts.length === 1) {
                return h('span', { style: { lineHeight: '32px', color: 'var(--dsw-alias-label-primary)', fontSize: 13, fontWeight: '500' } }, efforts[0])
              } else {
                return h('select', {
                  className: 'dsh-select',
                  value: model.reasoningEffort || efforts[0],
                  onChange: (e) => onChange({ reasoningEffort: e.target.value })
                },
                  efforts.map((effort) => h('option', { key: effort, value: effort }, effort))
                )
              }
            })()
          )
        ),
        h('div', { className: 'dsh-form-group' },
          h('span', { className: 'dsh-label' }, '用途备注 (必填)'),
          h('textarea', {
            className: 'dsh-textarea',
            value: model.purpose || '',
            placeholder: '描述该模型的用途（如：通用规划、慢思考推理）',
            onChange: (e) => onChange({ purpose: e.target.value })
          })
        )
      )
    }

    function SkillPreview({ content, custom, onSave, onRestore }) {
      const [editing, setEditing] = React.useState(false)
      const [editValue, setEditValue] = React.useState(content || '')

      React.useEffect(() => {
        if (!editing) setEditValue(content || '')
      }, [content, editing])

      const handleCopy = async () => {
        try {
          if (navigator.clipboard) {
            await navigator.clipboard.writeText(editing ? editValue : content)
            alert('已复制到剪贴板')
          } else {
            throw new Error('Clipboard API not supported')
          }
        } catch (e) {
          alert('复制失败: ' + e.message)
        }
      }

      const handleDownload = () => {
        try {
          const blob = new Blob([editing ? editValue : content], { type: 'text/markdown' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = 'SKILL.md'
          a.click()
          URL.revokeObjectURL(url)
        } catch (_) {}
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 } },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 } },
          h('span', { style: { fontSize: 12, fontWeight: '600', color: 'var(--dsw-alias-label-secondary)' } }, custom ? '📝 手动编辑模式' : '🤖 自动生成模式'),
          h('div', { style: { display: 'flex', gap: 6 } },
            editing
              ? h('button', { type: 'button', className: 'dsh-btn dsh-btn-secondary dsh-btn-sm', onClick: () => { onSave(editValue); setEditing(false) } }, '保存编辑')
              : h('button', { type: 'button', className: 'dsh-btn dsh-btn-secondary dsh-btn-sm', onClick: () => setEditing(true) }, '编辑'),
            editing && h('button', { type: 'button', className: 'dsh-btn dsh-btn-secondary dsh-btn-sm', onClick: () => setEditing(false) }, '取消'),
            h('button', { type: 'button', className: 'dsh-btn dsh-btn-secondary dsh-btn-sm', onClick: handleCopy }, '复制'),
            h('button', { type: 'button', className: 'dsh-btn dsh-btn-secondary dsh-btn-sm', onClick: handleDownload }, '下载'),
            custom && !editing && h('button', { type: 'button', className: 'dsh-btn dsh-btn-secondary dsh-btn-sm', onClick: onRestore }, '恢复自动')
          )
        ),
        editing
          ? h('textarea', {
              className: 'dsh-textarea',
              style: { minHeight: 120, fontFamily: 'var(--dsw-alias-font-monospace, monospace)', fontSize: 12 },
              value: editValue,
              onChange: (e) => setEditValue(e.target.value)
            })
          : h('pre', { className: 'dsh-pre' }, content || '尚未生成 Skill')
      )
    }

    function SmartSubagentSettings(ctx, _connection, _remote) {
      const [store, setStore] = React.useState(initialStore)
      const [isDirty, setIsDirty] = React.useState(false)
      const [valErr, setValErr] = React.useState('')
      const [saveStatus, setSaveStatus] = React.useState('')
      const [catalogData, setCatalogData] = React.useState([])
      const [catalogLoading, setCatalogLoading] = React.useState(false)
      const [catalogError, setCatalogError] = React.useState('')
      const [view, setView] = React.useState('list')
      const [draftProfile, setDraftProfile] = React.useState(null)

      const active = store.profiles.find((p) => p.id === store.activeId) || store.profiles[0]
      const settingsValue = active?.settings || emptySettings('开发配置')

      React.useEffect(() => {
        let cancelled = false
        const hasLocalDraft = safeRead() !== null
        if (typeof window === 'undefined' || typeof window.fetch !== 'function') return () => { cancelled = true }
        window.fetch(SETTINGS_ROUTE)
          .then((response) => {
            if (!response.ok) throw new Error('Failed to fetch settings descriptor')
            return response.json()
          })
          .then((payload) => {
            const backendStore = normalizeStore(payload?.descriptor?.value)
            if (!cancelled && backendStore && !hasLocalDraft) {
              setStore(backendStore)
              safeWrite(backendStore)
            }
          })
          .catch((error) => console.error('[SmartSubagents] Failed to load backend settings:', error))
        return () => { cancelled = true }
      }, [])

      const update = (patch) => {
        setStore((prev) => {
          const nextProfiles = prev.profiles.map((p) =>
            p.id === active.id
              ? {
                  ...p,
                  name: patch.name !== undefined ? patch.name : p.name,
                  settings: { ...p.settings, ...patch }
                }
              : p
          )
          return { ...prev, profiles: nextProfiles }
        })
        setIsDirty(true)
      }

      const handleFieldChange = (field, val) => {
        update({ [field]: val })
      }

      const scanProjectModels = async () => {
        setCatalogLoading(true)
        setCatalogError('')
        try {
          const response = await window.fetch(`${SETTINGS_ROUTE}?action=catalog`)
          if (!response.ok) throw new Error(`扫描失败（${response.status}）`)
          const payload = await response.json()
          const providers = Array.isArray(payload) ? payload : payload.providers
          if (!Array.isArray(providers)) throw new Error('项目未返回模型目录')
          setCatalogData(providers)
        } catch (error) {
          setCatalogData([])
          setCatalogError(error.message || '无法扫描项目模型')
        } finally {
          setCatalogLoading(false)
        }
      }

      const handleModelToggleInDraft = (provider, model) => {
        if (!draftProfile) return
        const settingsValue = draftProfile.settings
        const isChecked = settingsValue.models.some((m) => m.provider === provider.id && m.model === model.id)
        let nextModels
        if (isChecked) {
          nextModels = settingsValue.models.filter((m) => !(m.provider === provider.id && m.model === model.id))
        } else {
          const newModel = {
            alias: routeAlias(provider.id, model.id),
            provider: provider.id,
            model: model.id,
            displayName: model.name || model.id,
            maxTokens: String(model.maxTokens || 4096),
            purpose: '',
            reasoningEfforts: model.reasoningEfforts || ['low', 'medium', 'high'],
            reasoningEffort: selectLowestReasoningEffort(model.reasoningEfforts),
            enabled: true,
            allowPlanning: true,
            allowExecution: true
          }
          nextModels = [...settingsValue.models, newModel]
        }
        setDraftProfile((prev) => ({
          ...prev,
          settings: {
            ...prev.settings,
            models: nextModels
          }
        }))
      }

      const handleNewProfileClick = () => {
        const newId = `profile-${Date.now()}`
        const name = `新配置 ${store.profiles.length + 1}`
        const newProfile = normalizeProfile({
          id: newId,
          name,
          settings: emptySettings(name)
        })
        setDraftProfile(newProfile)
        scanProjectModels()
        setView('select')
      }

      const handleSelectNext = () => {
        if (!draftProfile || draftProfile.settings.models.length === 0) return
        setStore((prev) => {
          const nextProfiles = [...prev.profiles, draftProfile]
          const next = {
            ...prev,
            profiles: nextProfiles,
            activeId: draftProfile.id
          }
          safeWrite(next)
          return next
        })
        setIsDirty(true)
        setView('detail')
        setDraftProfile(null)
      }

      const handleSetGlobal = (id) => {
        setStore((prev) => {
          const next = { ...prev, globalProfileId: id }
          safeWrite(next)
          saveToBackend(next)
          return next
        })
      }

      const handleDeleteProfile = (id) => {
        if (store.profiles.length === 1) return
        if (!window.confirm('确定要删除该配置吗？')) return
        
        setStore((prev) => {
          const nextProfiles = prev.profiles.filter((p) => p.id !== id)
          let nextGlobalId = prev.globalProfileId
          if (prev.globalProfileId === id) {
            nextGlobalId = nextProfiles.length > 0 ? nextProfiles[0].id : null
          }
          
          let nextActiveId = prev.activeId
          if (prev.activeId === id) {
            nextActiveId = nextProfiles.length > 0 ? nextProfiles[0].id : ''
          }
          
          const next = {
            profiles: nextProfiles,
            activeId: nextActiveId,
            globalProfileId: nextGlobalId
          }
          
          safeWrite(next)
          
          if (nextGlobalId) saveToBackend(next)
          
          return next
        })
      }

      const handleDeleteInDetail = () => {
        const id = active.id
        handleDeleteProfile(id)
        setView('list')
      }

      const handleGenerateSkill = () => {
        if (!settingsValue.name.trim()) {
          setValErr('配置名称不能为空')
          return
        }
        if (settingsValue.models.length === 0) {
          setValErr('请至少配置一个模型')
          return
        }
        for (const [field, label] of [['foregroundTimeoutMs', '前台超时'], ['idleTimeoutMs', '空闲超时'], ['maxConcurrentSubagents', '最大并发子 Agent 数'], ['maxDepth', '最大委派深度']]) {
          if (!/^[1-9]\d*$/.test(String(settingsValue[field] || ''))) {
            setValErr(`${label}必须为正整数`)
            return
          }
        }
        for (const m of settingsValue.models) {
          if (!m.purpose.trim()) {
            setValErr(`模型 ${m.displayName || m.model} 的用途备注不能为空`)
            return
          }
          if (!/^[1-9]\d*$/.test(m.maxTokens)) {
            setValErr(`模型 ${m.displayName || m.model} 的 Max Token 必须为正整数`)
            return
          }
        }
        setValErr('')

        if (settingsValue.customSkill && settingsValue.customSkill.trim()) {
          if (!window.confirm('当前有手工编辑内容，重新生成会覆盖它，是否继续？')) {
            return
          }
        }

        const generated = generateSkillText(settingsValue)
        update({ customSkill: '', generatedSkill: generated })
      }

      const handleSave = () => {
        if (!settingsValue.name.trim()) {
          setValErr('配置名称不能为空')
          return
        }
        if (settingsValue.models.length === 0) {
          setValErr('请至少配置一个模型')
          return
        }
        for (const [field, label] of [['foregroundTimeoutMs', '前台超时'], ['idleTimeoutMs', '空闲超时'], ['maxConcurrentSubagents', '最大并发子 Agent 数'], ['maxDepth', '最大委派深度']]) {
          if (!/^[1-9]\d*$/.test(String(settingsValue[field] || ''))) {
            setValErr(`${label}必须为正整数`)
            return
          }
        }
        for (const m of settingsValue.models) {
          if (!m.purpose.trim()) {
            setValErr(`模型 ${m.displayName || m.model} 的用途备注不能为空`)
            return
          }
          if (!/^[1-9]\d*$/.test(m.maxTokens)) {
            setValErr(`模型 ${m.displayName || m.model} 的 Max Token 必须为正整数`)
            return
          }
        }
        setValErr('')

        if (safeWrite(store)) {
          setIsDirty(false)
          setSaveStatus('配置已保存到本地，正在同步到后端…')
          saveToBackend(store).then((result) => {
            setSaveStatus(result.ok ? '配置已保存' : `本地已保存，后端同步失败：${result.error}`)
            if (result.ok) setTimeout(() => setSaveStatus(''), 3000)
          })
        } else {
          setSaveStatus('保存失败：存储不可用')
        }
      }

      const handleReset = () => {
        if (window.confirm('确定要清除所有配置并恢复默认吗？')) {
          safeClear()
          const initial = initialStore()
          setStore(initial)
          setIsDirty(false)
          setValErr('')
          setSaveStatus('')
          
          saveToBackend(initial)
        }
      }

      const styleTag = h('style', null, `
        .dsh-sm-container {
          font-family: inherit;
          color: var(--dsw-alias-label-primary);
          font-size: inherit;
          line-height: 1.5;
          width: 100%;
          max-width: 600px;
          margin: 0 auto;
          padding: 8px 4px;
          box-sizing: border-box;
        }
        .dsh-profile-list { display: flex; flex-direction: column; gap: 8px; }
        .dsh-profile-card { flex-wrap: wrap; gap: 8px; margin-bottom: 0; }
        .dsh-profile-actions { flex-wrap: wrap; margin-left: auto; }
        .dsh-status { color: var(--dsw-alias-label-tertiary); }
        @media (max-width: 520px) {
          .dsh-header { align-items: flex-start; gap: 10px; }
          .dsh-profile-actions { width: 100%; margin-left: 0; }
          .dsh-profile-actions .dsh-btn { flex: 1 1 auto; }
          .dsh-form-group-row { grid-template-columns: 1fr; gap: 0; }
        }
        .dsh-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding-bottom: 12px;
          border-bottom: 1px solid var(--dsw-alias-border-l2);
          margin-bottom: 16px;
        }
        .dsh-header-title {
          font-size: 15px;
          font-weight: 600;
          color: var(--dsw-alias-label-primary);
          margin: 0;
        }
        .dsh-header-desc {
          font-size: 12px;
          color: var(--dsw-alias-label-tertiary);
          margin: 4px 0 0 0;
        }
        .dsh-card {
          background: var(--dsw-alias-bg-layer-2);
          border: 1px solid var(--dsw-alias-border-l2);
          border-radius: 8px;
          padding: 14px;
          margin-bottom: 16px;
          box-sizing: border-box;
        }
        .dsh-card-title {
          font-size: 13px;
          font-weight: 600;
          margin: 0 0 12px 0;
          color: var(--dsw-alias-label-primary);
          border-bottom: 1px solid var(--dsw-alias-border-l2);
          padding-bottom: 6px;
        }
        .dsh-form-group {
          display: flex;
          flex-direction: column;
          gap: 4px;
          margin-bottom: 12px;
        }
        .dsh-form-group-row {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
          margin-bottom: 12px;
        }
        .dsh-label {
          font-size: 11px;
          font-weight: 500;
          color: var(--dsw-alias-label-secondary);
        }
        .dsh-input, .dsh-select {
          box-sizing: border-box;
          width: 100%;
          height: 32px;
          padding: 0 8px;
          border: 1px solid var(--dsw-alias-border-l2);
          border-radius: 6px;
          background: var(--dsw-alias-bg-layer-1);
          color: var(--dsw-alias-label-primary);
          font: inherit;
          font-size: 13px;
          outline: none;
        }
        .dsh-input:focus, .dsh-select:focus {
          border-color: var(--dsw-alias-brand-primary, #2563eb);
        }
        .dsh-textarea {
          box-sizing: border-box;
          width: 100%;
          min-height: 60px;
          padding: 6px 8px;
          border: 1px solid var(--dsw-alias-border-l2);
          border-radius: 6px;
          background: var(--dsw-alias-bg-layer-1);
          color: var(--dsw-alias-label-primary);
          font: inherit;
          font-size: 13px;
          outline: none;
          resize: vertical;
        }
        .dsh-textarea:focus {
          border-color: var(--dsw-alias-brand-primary, #2563eb);
        }
        .dsh-checkbox-label {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          font-size: 13px;
          cursor: pointer;
          color: var(--dsw-alias-label-primary);
          user-select: none;
        }
        .dsh-checkbox {
          width: 14px;
          height: 14px;
          cursor: pointer;
          margin: 0;
        }
        .dsh-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          height: 32px;
          padding: 0 12px;
          font-size: 13px;
          font-weight: 500;
          border-radius: 6px;
          cursor: pointer;
          border: none;
          font-family: inherit;
          transition: all 0.2s;
        }
        .dsh-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .dsh-btn-primary {
          background: var(--dsw-alias-button-primary-fill, #2563eb);
          color: var(--dsw-alias-label-primary-foreground, #ffffff);
        }
        .dsh-btn-primary:hover:not(:disabled) {
          background: var(--dsw-alias-button-primary-hover, #1d4ed8);
        }
        .dsh-btn-secondary {
          border: 1px solid var(--dsw-alias-border-l2);
          background: transparent;
          color: var(--dsw-alias-label-primary);
        }
        .dsh-btn-secondary:hover:not(:disabled) {
          background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05));
        }
        .dsh-btn-danger {
          border: 1px solid var(--dsw-alias-border-l2);
          background: transparent;
          color: #ef4444;
        }
        .dsh-btn-danger:hover:not(:disabled) {
          background: rgba(239, 68, 68, 0.08);
          border-color: #ef4444;
        }
        .dsh-btn-sm {
          height: 26px;
          padding: 0 8px;
          font-size: 12px;
        }
        .dsh-badge {
          display: inline-flex;
          align-items: center;
          padding: 2px 6px;
          font-size: 11px;
          font-weight: 500;
          border-radius: 4px;
        }
        .dsh-badge-global {
          background: rgba(16, 185, 129, 0.1);
          color: #10b981;
          border: 1px solid rgba(16, 185, 129, 0.2);
        }
        .dsh-badge-unsaved {
          background: rgba(245, 158, 11, 0.1);
          color: #f59e0b;
          border: 1px solid rgba(245, 158, 11, 0.2);
        }
        .dsh-profile-card {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 12px;
          border: 1px solid var(--dsw-alias-border-l2);
          border-radius: 6px;
          background: var(--dsw-alias-bg-layer-2);
          margin-bottom: 8px;
          transition: all 0.2s;
        }
        .dsh-profile-card.global {
          border-color: rgba(16, 185, 129, 0.4);
          box-shadow: 0 1px 3px rgba(0,0,0,0.02);
        }
        .dsh-profile-info {
          display: flex;
          flex-direction: column;
          gap: 2px;
          flex: 1;
          min-width: 0;
        }
        .dsh-profile-title-row {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .dsh-profile-name {
          font-size: 13px;
          font-weight: 600;
          color: var(--dsw-alias-label-primary);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .dsh-profile-meta {
          font-size: 11px;
          color: var(--dsw-alias-label-tertiary);
        }
        .dsh-profile-actions {
          display: flex;
          align-items: center;
          gap: 6px;
          margin-left: 12px;
        }
        .dsh-tip-box {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          padding: 10px 12px;
          background: var(--dsw-alias-bg-layer-1);
          border: 1px solid var(--dsw-alias-border-l2);
          border-radius: 6px;
          margin-top: 16px;
          color: var(--dsw-alias-label-secondary);
        }
        .dsh-tip-icon {
          font-size: 14px;
          line-height: 1;
        }
        .dsh-tip-text {
          font-size: 12px;
          line-height: 1.4;
        }
        .dsh-provider-group {
          margin-bottom: 14px;
        }
        .dsh-provider-title {
          font-size: 11px;
          font-weight: 600;
          color: var(--dsw-alias-label-tertiary);
          text-transform: uppercase;
          margin-bottom: 6px;
          display: block;
        }
        .dsh-model-item {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 8px;
          border-radius: 4px;
          cursor: pointer;
          font-size: 13px;
          transition: background 0.1s;
        }
        .dsh-model-item:hover {
          background: var(--dsw-alias-interactive-bg-hover);
        }
        .dsh-model-config-card {
          padding: 12px;
          border: 1px solid var(--dsw-alias-border-l2);
          border-radius: 6px;
          background: var(--dsw-alias-bg-layer-1);
          margin-bottom: 10px;
        }
        .dsh-model-config-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 8px;
        }
        .dsh-model-config-title {
          font-weight: 600;
          font-size: 13px;
          color: var(--dsw-alias-label-primary);
        }
        .dsh-model-config-remove {
          background: transparent;
          border: none;
          color: var(--dsw-alias-label-tertiary);
          cursor: pointer;
          font-size: 16px;
          padding: 0 4px;
          line-height: 1;
        }
        .dsh-model-config-remove:hover {
          color: #ef4444;
        }
        .dsh-pre {
          margin: 8px 0 0 0;
          padding: 10px;
          background: var(--dsw-alias-bg-layer-1);
          border: 1px solid var(--dsw-alias-border-l2);
          border-radius: 6px;
          font-family: var(--dsw-alias-font-monospace, monospace);
          font-size: 12px;
          line-height: 1.4;
          white-space: pre-wrap;
          word-break: break-all;
          max-height: 180px;
          overflow-y: auto;
          color: var(--dsw-alias-label-primary);
        }
        @media (max-width: 520px) {
          .dsh-header { align-items: flex-start; gap: 10px; }
          .dsh-profile-card { align-items: flex-start; }
          .dsh-profile-actions { width: 100%; margin-left: 0; }
          .dsh-profile-actions .dsh-btn { flex: 1 1 auto; }
          .dsh-form-group-row { grid-template-columns: 1fr; gap: 0; }
        }
      @media (max-width: 520px) {
          .dsh-header { align-items: flex-start; gap: 10px; }
          .dsh-profile-card { align-items: flex-start; }
          .dsh-profile-actions { width: 100%; margin-left: 0; }
          .dsh-profile-actions .dsh-btn { flex: 1 1 auto; }
          .dsh-form-group-row { grid-template-columns: 1fr; gap: 0; }
        }
      `)

      if (!active) return null

      // View 1: List (Homepage)
      if (view === 'list') {
        const sortedProfiles = [...store.profiles].sort((a, b) => {
          if (a.id === store.globalProfileId) return -1
          if (b.id === store.globalProfileId) return 1
          return 0
        })

        return h('section', { className: 'dsh-sm-container' },
          styleTag,
          h('div', { className: 'dsh-header' },
            h('div', null,
              h('h2', { className: 'dsh-header-title' }, '我的配置'),
              h('p', { className: 'dsh-header-desc' }, '管理并切换用于智能子 Agent 委派的配置方案。')
            ),
            h('button', {
              type: 'button',
              className: 'dsh-btn dsh-btn-primary dsh-btn-sm',
              onClick: handleNewProfileClick
            }, '+ 新建配置')
          ),
          h('div', { className: 'dsh-profile-list' },
            sortedProfiles.map((p) => {
              const isGlobal = p.id === store.globalProfileId
              return h('div', { key: p.id, className: `dsh-profile-card ${isGlobal ? 'global' : ''}` },
                h('div', { className: 'dsh-profile-info' },
                  h('div', { className: 'dsh-profile-title-row' },
                    h('span', { className: 'dsh-profile-name' }, p.name),
                    isGlobal && h('span', { className: 'dsh-badge dsh-badge-global' }, '全局默认')
                  ),
                  h('div', { className: 'dsh-profile-meta dsh-status' },
                    `${p.settings.models.length} 个模型 · ${p.settings.models.length ? '可用' : '未配置模型'} · ${p.settings.enableBackground ? '后台运行' : '等待完成'}`
                  )
                ),
                h('div', { className: 'dsh-profile-actions' },
                  h('button', {
                    type: 'button',
                    className: 'dsh-btn dsh-btn-secondary dsh-btn-sm',
                    onClick: () => {
                      setStore((prev) => ({ ...prev, activeId: p.id }))
                      setView('detail')
                    }
                  }, '查看'),
                  !isGlobal && h('button', {
                    type: 'button',
                    className: 'dsh-btn dsh-btn-secondary dsh-btn-sm',
                    onClick: () => handleSetGlobal(p.id)
                  }, '设为全局'),
                  h('button', {
                    type: 'button',
                    className: 'dsh-btn dsh-btn-danger dsh-btn-sm',
                    disabled: store.profiles.length === 1,
                    onClick: () => handleDeleteProfile(p.id)
                  }, '删除')
                )
              )
            })
          ),
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 24, borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 16 } },
            h('div', { className: 'dsh-tip-box', style: { margin: 0, flex: 1, marginRight: 16 } },
              h('span', { className: 'dsh-tip-icon' }, '💡'),
              h('span', { className: 'dsh-tip-text' }, '提示：在会话中说“使用 漫剧配置”即可临时覆盖全局默认。')
            ),
            h('button', { type: 'button', className: 'dsh-btn dsh-btn-danger dsh-btn-sm', onClick: handleReset }, '重置数据')
          )
        )
      }

      // View 2: Model Selection (Draft / New Config)
      if (view === 'select') {
        const hasSelected = draftProfile && draftProfile.settings.models.length > 0

        return h('section', { className: 'dsh-sm-container' },
          styleTag,
          h('div', { className: 'dsh-header' },
            h('div', null,
              h('h2', { className: 'dsh-header-title' }, '新建配置：选择模型'),
              h('p', { className: 'dsh-header-desc' }, catalogLoading ? '正在扫描当前项目模型…' : (catalogError || '勾选至少一个模型以继续。'))
            ),
            h('button', {
              type: 'button',
              className: 'dsh-btn dsh-btn-secondary dsh-btn-sm',
              onClick: () => {
                setView('list')
                setDraftProfile(null)
              }
            }, '取消')
          ),
          h('div', { className: 'dsh-card' },
            catalogLoading && h('p', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 13 } }, '扫描中...'),
            !catalogLoading && catalogData.length === 0 && h('p', { style: { color: '#ef4444', fontSize: 13 } }, catalogError || '未扫描到可用模型。'),
            !catalogLoading && catalogData.map((provider) =>
              h('div', { key: provider.id, className: 'dsh-provider-group' },
                h('span', { className: 'dsh-provider-title' }, provider.name),
                (provider.models || []).map((model) => {
                  const isChecked = draftProfile && draftProfile.settings.models.some((m) => m.provider === provider.id && m.model === model.id)
                  return h('label', { key: model.id, className: 'dsh-model-item' },
                    h('input', {
                      type: 'checkbox',
                      className: 'dsh-checkbox',
                      checked: isChecked,
                      onChange: () => handleModelToggleInDraft(provider, model)
                    }),
                    h('span', null, `${model.name} (${Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length ? model.reasoningEfforts.join(', ') : '未提供推理档位'})`)
                  )
                })
              )
            )
          ),
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 16 } },
            h('button', {
              type: 'button',
              className: 'dsh-btn dsh-btn-primary',
              disabled: catalogLoading || !hasSelected,
              onClick: handleSelectNext
            }, `下一步（已选 ${draftProfile ? draftProfile.settings.models.length : 0} 个）`)
          )
        )
      }

      // View 3: Details
      const isGlobal = store.globalProfileId === active.id

      return h('section', { className: 'dsh-sm-container' },
        styleTag,
        h('div', { className: 'dsh-header' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('button', {
              type: 'button',
              className: 'dsh-btn dsh-btn-secondary dsh-btn-sm',
              onClick: () => {
                setView('list')
                setValErr('')
              }
            }, '← 返回'),
            h('h2', { className: 'dsh-header-title' }, active.name)
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            isGlobal
              ? h('span', { className: 'dsh-badge dsh-badge-global' }, '全局默认')
              : h('button', {
                  type: 'button',
                  className: 'dsh-btn dsh-btn-secondary dsh-btn-sm',
                  onClick: () => handleSetGlobal(active.id)
                }, '设为全局'),
            isDirty && h('span', { className: 'dsh-badge dsh-badge-unsaved' }, '未保存')
          )
        ),

        // 1. Basic Config
        h('div', { className: 'dsh-card' },
          h('h3', { className: 'dsh-card-title' }, '基本配置'),
          h('div', { className: 'dsh-form-group' },
            h('span', { className: 'dsh-label' }, '配置名称'),
            h('input', {
              type: 'text',
              className: 'dsh-input',
              value: settingsValue.name,
              onChange: (e) => handleFieldChange('name', e.target.value)
            })
          ),
          h('div', { className: 'dsh-form-group-row' },
            h('div', { className: 'dsh-form-group' },
              h('span', { className: 'dsh-label' }, '前台超时 (ms)'),
              h('input', {
                type: 'number',
                className: 'dsh-input',
                value: settingsValue.foregroundTimeoutMs,
                onChange: (e) => handleFieldChange('foregroundTimeoutMs', e.target.value)
              })
            ),
            h('div', { className: 'dsh-form-group' },
              h('span', { className: 'dsh-label' }, '空闲超时 (ms)'),
              h('input', {
                type: 'number',
                className: 'dsh-input',
                value: settingsValue.idleTimeoutMs,
                onChange: (e) => handleFieldChange('idleTimeoutMs', e.target.value)
              })
            )
          ),
          h('div', { className: 'dsh-form-group-row' },
            h('div', { className: 'dsh-form-group' },
              h('span', { className: 'dsh-label' }, '最大并发子 Agent 数'),
              h('input', {
                type: 'number',
                className: 'dsh-input',
                value: settingsValue.maxConcurrentSubagents,
                onChange: (e) => handleFieldChange('maxConcurrentSubagents', e.target.value)
              })
            ),
            h('div', { className: 'dsh-form-group' },
              h('span', { className: 'dsh-label' }, '最大委派深度'),
              h('input', {
                type: 'number',
                className: 'dsh-input',
                value: settingsValue.maxDepth,
                onChange: (e) => handleFieldChange('maxDepth', e.target.value)
              })
            )
          ),
          h('label', { className: 'dsh-checkbox-label', style: { marginTop: 4 } },
            h('input', {
              type: 'checkbox',
              className: 'dsh-checkbox',
              checked: !settingsValue.enableBackground,
              onChange: (e) => handleFieldChange('enableBackground', !e.target.checked)
            }),
            h('span', null, '等待子 Agent')
          )
        ),

        // 2. Model Purposes
        h('div', { className: 'dsh-card' },
          h('h3', { className: 'dsh-card-title' }, '已选模型用途'),
          settingsValue.models.length === 0
            ? h('p', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, margin: 0 } }, '请返回并在新建配置时勾选需要使用的模型。')
            : settingsValue.models.map((m, idx) =>
                h(ModelConfigCard, {
                  key: `${m.provider}:${m.model}:${idx}`,
                  model: m,
                  onChange: (patch) => {
                    const nextModels = settingsValue.models.map((x, n) => n === idx ? { ...x, ...patch } : x)
                    update({ models: nextModels })
                  },
                  onRemove: () => {
                    const nextModels = settingsValue.models.filter((_, n) => n !== idx)
                    update({ models: nextModels })
                  }
                })
              )
        ),

        // 3. Generate Skill
        h('div', { className: 'dsh-card' },
          h('h3', { className: 'dsh-card-title' }, '生成 Skill'),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
            h('button', { type: 'button', className: 'dsh-btn dsh-btn-primary', onClick: handleGenerateSkill }, '根据当前配置生成 Skill'),
            valErr ? h('p', { style: { color: '#ef4444', margin: '4px 0 0 0', fontSize: 12 } }, valErr) : null,
            h(SkillPreview, {
              content: settingsValue.customSkill || settingsValue.generatedSkill,
              custom: Boolean(settingsValue.customSkill),
              onSave: (v) => update({ customSkill: v }),
              onRestore: () => update({ customSkill: '' })
            })
          )
        ),

        // Bottom Actions (Save Configuration & Delete Configuration)
        h('div', { style: { display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 16, marginTop: 8 } },
          h('button', {
            type: 'button',
            className: 'dsh-btn dsh-btn-danger',
            disabled: store.profiles.length === 1,
            onClick: handleDeleteInDetail
          }, '删除配置'),
          h('div', { style: { display: 'flex', gap: 10, alignItems: 'center' } },
            saveStatus ? h('span', { style: { color: '#10b981', fontSize: 12 } }, saveStatus) : null,
            h('button', { type: 'button', className: 'dsh-btn dsh-btn-primary', onClick: handleSave }, '保存配置')
          )
        )
      )
    }

    function ChoiceRequiredCard(props) {
      const value = props.block?.output?.kind === 'json' ? props.block.output.value : null
      if (!value || value.kind !== 'choice-required') return null
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, padding: 16, border: '1px solid var(--dsw-alias-border-l2, #e5e7eb)', borderRadius: 12 } },
        h('strong', null, '请选择子 Agent 模型'),
        h('p', null, value.reason),
        h('ul', null, (value.choices || []).map((c) =>
          h('li', { key: c.alias }, `${c.displayName || c.alias}：${c.purpose || ''}`)
        ))
      )
    }

    return {
      inject: ['slots'],
      async apply(ctx) {
        const slots = ctx.get('slots')
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'smart-subagent-orchestrator', order: 26, label: 'Smart Subagents' },
          (renderCtx, connection, remote) => SmartSubagentSettings(renderCtx || ctx, connection || ctx.get('connection'), remote || ctx.get('remote'))
        ))
        slots.inject('tool.call.toolview', () => slots.register(
          { name: 'tool.call.toolview', key: 'smart_delegate' },
          (props) => ChoiceRequiredCard(props)
        ))
      }
    }
  }
})
