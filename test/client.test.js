import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

// Minimal React stub — must be defined BEFORE ModuleLoader.load fires
function flattenChildren(children) {
  const result = []
  for (const child of children) {
    if (Array.isArray(child)) result.push(...flattenChildren(child))
    else result.push(child)
  }
  return result
}

const React = {
  createElement(tag, props, ...children) {
    const key = typeof tag === 'string' ? tag : (props?.key ?? null)
    const flat = flattenChildren(children)
    return { $$typeof: Symbol('react.element'), type: tag, props: props ?? {}, key, refs: null, children: flat }
  },
  useState(init) {
    let val = typeof init === 'function' ? init() : init
    const setVal = (next) => { val = typeof next === 'function' ? next(val) : val }
    return [val, setVal]
  },
  useEffect(fn, _deps) {
    const cleanup = fn()
    return typeof cleanup === 'function' ? cleanup : () => {}
  },
  useCallback(fn, _deps) {
    return fn
  },
}
globalThis.React = React

// MockRequire factory — produces a require function that resolves React
function makeRequireFn() {
  return function mockRequire(dep) {
    if (dep === 'react') return React
    if (dep === 'node:assert/strict') return import.meta.require?.('node:assert/strict') ?? assert
    return undefined
  }
}

// ModuleLoader shim — mirrors DSH client.runtime behavior
const ModuleLoaderMap = new Map()

class MockModuleLoader {
  static load({ id, factory }) {
    const mod = { id, factory, exports: {} }
    ModuleLoaderMap.set(id, mod)
    // Pass a require function to the factory
    factory(makeRequireFn())
    return mod
  }

  static get(id) {
    return ModuleLoaderMap.get(id)
  }

  static clear() {
    ModuleLoaderMap.clear()
  }
}

globalThis.window = { __ModuleLoader__: MockModuleLoader }

// Load the client
const clientPath = new URL('../lib/client.js', import.meta.url)
await import(clientPath.href)

const plugin = MockModuleLoader.get('dsh-smart-subagent-orchestrator')
assert.ok(plugin, 'client plugin should be registered in ModuleLoader')

// The plugin stores exports on window.__ModuleLoader__ or through the factory
// Since the factory returns nothing, we need to look at how DSH client.runtime registers
// DSH client.runtime typically does: window.__ModuleLoader__.load({ id, factory }) where factory
// receives a require function, and the factory calls slots.inject which registers to the slot tree.
// The "exports" from the plugin come from what apply() returns.
// But since factory doesn't return, we need to check the apply result differently.
// In DSH runtime, the plugin's apply() is called later by the framework.
// We can only test the apply function by calling it directly.

const exports = {}
// Simulate what the framework does after factory(): call apply on the returned object
const factoryResult = plugin.factory(makeRequireFn())
// factoryResult is what apply() returns
assert.ok(factoryResult, 'factory should return a result')
assert.deepEqual(factoryResult.inject, ['slots'])
assert.strictEqual(typeof factoryResult.apply, 'function')

// --- Slot registration verification ---
const slots = {
  _registrations: {},
  _info: {},
  inject(slotName, factory) {
    // slots.inject calls the factory immediately; factory returns a dispose function
    // but we need to capture the config/render from inside the factory
    const dispose = factory()
    this._registrations[slotName] = dispose
  },
  register(config, render) {
    // DSH slots.register(config, render) - config has name/id fields
    const key = config.key ?? config.id
    // Store both info and return a proper dispose
    this._info[key] = { config, render }
    return () => delete this._info[key]
  },
}

const mockCtx = {
  get(name) {
    if (name === 'slots') return slots
    if (name === 'connection') return { on() { return () => {} } }
    if (name === 'remote') return { $on() { return () => {} } }
    return undefined
  },
  on() { return () => {} },
}

await factoryResult.apply(mockCtx)

// Check settings.section slot registration
const settingsReg = slots._info['smart-subagent-orchestrator']
assert.ok(settingsReg, 'settings.section slot should be registered')
assert.strictEqual(settingsReg.config.id, 'smart-subagent-orchestrator')
assert.strictEqual(settingsReg.config.order, 26)
assert.strictEqual(settingsReg.config.label, 'Smart Subagents')
assert.strictEqual(typeof settingsReg.render, 'function')

// Check tool.call.toolview slot registration
const toolViewReg = slots._info['smart_delegate']
assert.ok(toolViewReg, 'tool.call.toolview slot should be registered')
assert.deepEqual(toolViewReg.config, { name: 'tool.call.toolview', key: 'smart_delegate' })
assert.strictEqual(typeof toolViewReg.render, 'function')

// --- ChoiceRequiredCard rendering ---
const card = toolViewReg.render({
  block: {
    output: {
      kind: 'json',
      value: {
        kind: 'choice-required',
        recommendation: 'fast',
        reason: 'Fast model recommended.',
        choices: [
          { alias: 'fast', displayName: 'Fast Model', purpose: 'Quick tasks' },
          { alias: 'deep', displayName: 'Deep Model', purpose: 'Complex reasoning' },
        ],
      },
    },
  },
})

assert.ok(card, 'card should render')
assert.strictEqual(card.type, 'div')
assert.strictEqual(card.props.style.display, 'flex')
assert.strictEqual(card.children.length, 3) // strong + p + ul

const ul = card.children[2]
assert.strictEqual(ul.type, 'ul')
assert.strictEqual(ul.children.length, 2)
assert.strictEqual(ul.children[0].children.length, 1)
assert.strictEqual(ul.children[0].children[0], 'Fast Model：Quick tasks')

// --- ChoiceRequiredCard with empty/missing choices ---
const emptyCard = toolViewReg.render({
  block: { output: { kind: 'json', value: { kind: 'choice-required', recommendation: 'x', reason: 'r', choices: [] } } },
})
assert.ok(emptyCard, 'empty choices should render card')
assert.strictEqual(emptyCard.children[2].children.length, 0)

const nullCard = toolViewReg.render({
  block: { output: { kind: 'json', value: { kind: 'choice-required', recommendation: 'x', reason: 'r', choices: null } } },
})
assert.ok(nullCard, 'null choices should render card (fallback to empty array)')

const wrongKindCard = toolViewReg.render({
  block: { output: { kind: 'json', value: { kind: 'something-else' } } },
})
assert.strictEqual(wrongKindCard, null, 'wrong kind should return null')

// --- SmartSubagentSettings render smoke test ---
const mockConnection = { on() { return () => {} } }
const mockRemote = { $on() { return () => {} } }

// render() returns the SmartSubagentSettings vdom directly (component is a function, not a closure)
const vdom = settingsReg.render(mockCtx, mockConnection, mockRemote)
assert.ok(vdom, 'render should return a vdom element')
assert.strictEqual(vdom.type, 'section')
assert.ok(Array.isArray(vdom.children), 'section should have children')

assert.ok(containsText(vdom, '我的配置'), 'profile list should exist')
assert.ok(containsText(vdom, '+ 新建配置'), 'new profile action should exist')

function containsText(node, text) {
  if (!node) return false
  if (node === text) return true
  return Array.isArray(node.children) && node.children.some((child) => containsText(child, text))
}

function findComponent(node, typeCondition) {
  if (!node) return null
  if (typeCondition(node.type)) return node
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      const found = findComponent(child, typeCondition)
      if (found) return found
    }
  }
  return null
}

assert.ok(!containsText(vdom, '绑定会话'), 'profile list must not expose session binding')
assert.ok(containsText(vdom, '全局默认'), 'global profile is visibly marked')
assert.ok(containsText(vdom, '查看'), 'profile list exposes view action')
assert.ok(!containsText(vdom, '设为全局'), 'single default profile hides global action')
assert.ok(containsText(vdom, '删除'), 'profile list exposes delete action')

// Keep the key wizard contract covered even though this lightweight renderer
// does not simulate a second React render after click handlers.
const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
assert.match(clientSource, /scanProjectModels[\s\S]*setView\('select'\)/)
assert.match(clientSource, /disabled: catalogLoading \|\| !hasSelected/)
assert.match(clientSource, /h\('h2'.*新建配置：选择模型/)
assert.match(clientSource, /h\('h3'.*已选模型用途/)
assert.match(clientSource, /h\('h3'.*生成 Skill/)
assert.match(clientSource, /等待子 Agent/)
assert.match(clientSource, /normalizeStore[\s\S]*globalProfileId/)
assert.doesNotMatch(clientSource, /绑定会话/)

// Cleanup
MockModuleLoader.clear()
