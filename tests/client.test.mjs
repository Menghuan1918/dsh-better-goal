/**
 * Scoped React tests for the zero-build browser closure.
 *
 * Loads `src/client.js` through a fake `window.__ModuleLoader__` (no browser),
 * drives components with react-test-renderer@18, and verifies:
 *   - closure identity / service injection / slot registration;
 *   - the GoalBar renders the native goal projection and mutates through the
 *     CAS-checked `remote.goals` RPC, never commands.execute (so no
 *     command/run lifecycle is produced by UI buttons);
 *   - the CAS ref is read from the live projection at click time;
 *   - active+disarmed resume and activation event/reset refresh;
 *   - edit/pause/resume/clear/error paths and unlimited cap rendering;
 *   - the plugin-row settings form validates and saves the three volatile
 *     Config fields through the native form mutate(ops, revision) contract.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as React from 'react'
import TestRenderer from 'react-test-renderer'
import { DEFAULTS, ENTRY_ID, PACKAGE_NAME, ROW_CONFIG_KEY, UNLIMITED_ROUNDS } from '../src/config.js'

const { createElement: h } = React
const act = TestRenderer.act ?? TestRenderer.default?.act
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SESSION_ID = 'session-1'
const UNLIMITED = UNLIMITED_ROUNDS
/** The row-config key the Plugins page derives for Apollo's declaring bundle. */
const APOLLO_ROW_CONFIG_KEY = 'dsh-apollo#dsh-better-goal'
/** The row-config key for Apollo's published scoped package. */
const SCOPED_APOLLO_ROW_CONFIG_KEY = '@menghuan1918/dsh-apollo#dsh-better-goal'
const SOURCE = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

/** Fake t: keeps keys and parameters visible without depending on copy. */
const t = (key, params) => (params === undefined ? key : key + '(' + JSON.stringify(params) + ')')

// ── loader / host fixtures ─────────────────────────────────────────────────

function loadClient() {
  const registrations = []
  new Function('window', SOURCE)({ __ModuleLoader__: { load: (entry) => registrations.push(entry) } })
  assert.equal(registrations.length, 1)
  const exports = new Function('require', 'return (' + registrations[0].factory.toString() + ')(require)')((specifier) => {
    if (specifier === 'react') return React
    throw new Error('unexpected external require: ' + specifier)
  })
  return { entry: registrations[0], exports }
}

function makeSlots() {
  const watchers = new Map()
  const registrations = []
  return {
    registrations,
    injected: [],
    inject(name, callback) {
      this.injected.push(name)
      const set = watchers.get(name) ?? new Set()
      watchers.set(name, set)
      set.add(callback)
      return () => set.delete(callback)
    },
    register(options, component) {
      const record = { options, component }
      registrations.push(record)
      return () => {
        const at = registrations.indexOf(record)
        if (at >= 0) registrations.splice(at, 1)
      }
    },
    declare(name) {
      const disposers = []
      for (const callback of [...(watchers.get(name) ?? [])]) {
        const dispose = callback()
        if (typeof dispose === 'function') disposers.push(dispose)
      }
      watchers.set(name, new Set(disposers))
      return disposers
    },
  }
}

/** Mutable live projection store exposed through the native binding face. */
function makeProjectionStore(initial) {
  let value = initial
  let running = false
  const projectionListeners = new Set()
  const sessionListeners = new Set()
  const face = {
    getSnapshot: () => value,
    subscribe: (listener) => {
      projectionListeners.add(listener)
      return () => projectionListeners.delete(listener)
    },
  }
  const session = {
    getSnapshot: () => ({ openState: 'open', running }),
    subscribe: (listener) => {
      sessionListeners.add(listener)
      return () => sessionListeners.delete(listener)
    },
    projections: {
      faceOf: (key) => (key === 'goal' ? face : { getSnapshot: () => undefined, subscribe: () => () => {} }),
    },
  }
  return {
    get value() { return value },
    set(next) {
      value = next
      for (const listener of [...projectionListeners]) listener()
    },
    /** Advance the projection without notifying observers (unrendered update). */
    setSilently(next) { value = next },
    binding: { session },
  }
}

/** Apply the closure against a minimal host face; returns observable wiring. */
function install({ projection = null, activation = 'armed', goalResults } = {}) {
  const slots = makeSlots()
  const projectionStore = makeProjectionStore(projection)
  const effects = []
  const dictionaries = []
  const commandCalls = []
  const goalCalls = []
  const goalReads = []
  const activationListeners = new Set()
  const resetListeners = new Set()
  let currentActivation = activation

  /** Default successful GoalView/GoalRef value for one mutation. */
  const successValue = (method, ref, request) => {
    if (method === 'clear') return { id: ref.id, revision: ref.revision + 1 }
    const goal = projectionStore.value?.goal ?? {}
    return {
      ...goal,
      id: ref.id,
      revision: ref.revision + 1,
      roundsStarted: projectionStore.value?.roundsStarted ?? 0,
      createdAt: 0,
      updatedAt: 0,
      activation: method === 'pause' ? 'disarmed' : 'armed',
      ...(method === 'edit' && typeof request?.objective === 'string'
        ? { objective: request.objective }
        : {}),
    }
  }

  /** Record one native goal mutation and optionally override its result. */
  const mutation = (method) => async (...args) => {
    const [sessionId, ref, request] = args
    goalCalls.push({ method, sessionId, ref, request })
    const override = goalResults?.[method]
    if (override !== undefined) return await override(...args)
    return { ok: true, value: successValue(method, ref, request) }
  }

  const goals = {
    get: async (sessionId) => {
      goalReads.push(sessionId)
      const current = projectionStore.value
      if (current?.goal === undefined || current?.goal === null) return { ok: true, value: undefined }
      return {
        ok: true,
        value: {
          ...current.goal,
          roundsStarted: current.roundsStarted ?? 0,
          createdAt: 0,
          updatedAt: 0,
          activation: currentActivation,
        },
      }
    },
    edit: mutation('edit'),
    pause: mutation('pause'),
    resume: mutation('resume'),
    clear: mutation('clear'),
  }
  const command = {
    execute: async (...args) => {
      commandCalls.push(args)
      return { ok: true, value: { commandId: 'command-1', result: { kind: 'success', text: 'ok' } } }
    },
  }
  const ctx = {
    effect(factory, label) {
      const dispose = factory()
      effects.push({ label, dispose })
      return dispose
    },
    locale: {
      register: (ns, dicts) => { dictionaries.push({ ns, dicts }); return () => {} },
      bind: () => t,
    },
    slots,
    sessions: {
      binding: () => projectionStore.binding,
      using: async (_sessionId, _options, operation) => operation({ binding: projectionStore.binding }),
    },
    remote: {
      commands: command,
      goals,
      $on: (event, listener) => {
        if (event !== 'goal/activation-changed') return () => {}
        activationListeners.add(listener)
        return () => activationListeners.delete(listener)
      },
    },
    on: (event, listener) => {
      if (event !== 'connection/reset') return () => {}
      resetListeners.add(listener)
      return () => resetListeners.delete(listener)
    },
  }
  const loaded = loadClient()
  loaded.exports.apply(ctx)
  return {
    ...loaded,
    slots,
    effects,
    dictionaries,
    commandCalls,
    goalCalls,
    goalReads,
    projectionStore,
    setActivation(next) { currentActivation = next },
    emitActivation(goal) {
      for (const listener of [...activationListeners]) listener({ sessionId: SESSION_ID, goal })
    },
    emitReset() {
      for (const listener of [...resetListeners]) listener()
    },
    declare(name) {
      slots.declare(name)
      const record = slots.registrations.find((entry) => entry.options.name === name)
      assert.ok(record, `slot ${name} registered`)
      return record
    },
  }
}

// ── DOM-ish helpers ────────────────────────────────────────────────────────

const isHost = (node) => typeof node.type === 'string'
const byLabel = (renderer, label) => renderer.root.findAll((node) => isHost(node) && node.props?.['aria-label'] === label)[0]
const byId = (renderer, id) => renderer.root.findAll((node) => isHost(node) && node.props?.id === id)[0]
const primaryButton = (renderer) => renderer.root.findAll((node) => isHost(node) && node.type === 'button' && node.props?.['data-variant'] === 'primary')[0]
const allText = (node) => {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(allText).join('')
  return allText(node.children ?? [])
}
const pageText = (renderer) => allText(renderer.toJSON())

// ── closure wiring ─────────────────────────────────────────────────────────

test('closure id, injected services, dictionaries, and every slot registration', () => {
  const setup = install()
  assert.equal(setup.entry.id, ENTRY_ID)
  assert.deepEqual(setup.exports.inject, ['slots', 'sessions', 'remote', 'remote.goals', 'locale'])
  assert.deepEqual(setup.slots.injected, ['conversation.input.dock', 'plugins.row.config'])
  assert.equal(setup.dictionaries.length, 1)
  assert.equal(setup.dictionaries[0].ns, 'better-goal')
  assert.deepEqual(
    Object.keys(setup.dictionaries[0].dicts.zh).sort(),
    Object.keys(setup.dictionaries[0].dicts.en).sort(),
  )
  // Every literal copy key referenced by a component exists in both locales.
  const usedKeys = [...SOURCE.matchAll(/tr\(t, '([^']+)'/g)].map((match) => match[1])
  for (const key of usedKeys) {
    assert.equal(typeof setup.dictionaries[0].dicts.zh[key], 'string', `zh copy for ${key}`)
    assert.equal(typeof setup.dictionaries[0].dicts.en[key], 'string', `en copy for ${key}`)
  }
  assert.deepEqual(setup.effects.map((entry) => entry.label), [
    'dsh-better-goal: dictionaries',
    'dsh-better-goal: GoalBar',
    'dsh-better-goal: row config page',
  ])
  setup.declare('conversation.input.dock')
  setup.declare('plugins.row.config')
  const rows = setup.slots.registrations.filter((entry) => entry.options.name === 'plugins.row.config')
  assert.equal(PACKAGE_NAME, 'dsh-better-goal')
  assert.deepEqual(
    rows.map((entry) => entry.options.key).sort(),
    [APOLLO_ROW_CONFIG_KEY, ROW_CONFIG_KEY, SCOPED_APOLLO_ROW_CONFIG_KEY].sort(),
  )
  assert.equal(new Set(rows.map((entry) => entry.options.key)).size, rows.length, 'one entry per exact key')
  for (const row of rows) {
    assert.equal(row.component, rows[0].component, 'one entry component serves every key')
    assert.equal(row.options.locale, 'better-goal')
  }
  assert.equal(setup.slots.registrations.length, 4)
})

// ── GoalBar ────────────────────────────────────────────────────────────────

/** Minimal framework hook seat over one HostObservable source (stable subscriptions). */
function makeGoalActivationHook(source) {
  const subscribe = (listener) => source.subscribe(listener)
  const getSnapshot = () => source.getSnapshot()
  return function useGoalActivation(selector) {
    const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    return selector(snapshot)
  }
}

/** Yield once so the async activation read and React updates settle inside act(). */
async function flushAct() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

async function mountGoalBar({ projection, activation, goalResults }) {
  const setup = install({ projection, activation, goalResults })
  const record = setup.declare('conversation.input.dock')
  const injected = record.options.inject(SESSION_ID)
  const useProjection = (key) => (key === 'goal' ? setup.projectionStore.value : undefined)
  const useGoalActivation = injected.hooks === undefined
    ? undefined
    : makeGoalActivationHook(injected.hooks.goalActivation)
  const element = () => h(record.component, { ...injected, useProjection, useGoalActivation, t })
  let renderer = null
  await act(async () => { renderer = TestRenderer.create(element()) })
  await flushAct()
  return {
    setup,
    injected,
    element,
    get renderer() { return renderer },
    async update(nextProjection) {
      setup.projectionStore.set(nextProjection)
      await act(async () => { renderer.update(element()) })
      await flushAct()
    },
    flush: flushAct,
  }
}

const activeGoal = {
  id: 'goal-1',
  revision: 4,
  objective: 'Ship the independent goal',
  phase: 'active',
  maxGoalRounds: UNLIMITED,
}

test('active GoalBar renders the projection, unlimited rounds, and pauses through remote.goals', async () => {
  const bar = await mountGoalBar({
    projection: { goal: activeGoal, roundsStarted: 2 },
  })
  const text = pageText(bar.renderer)
  assert.match(text, /phase\.active/)
  assert.match(text, /Ship the independent goal/)
  assert.match(text, /meta\.rounds/)
  assert.match(text, /cap\.unlimited/)
  assert.equal(
    bar.renderer.root.findAll((node) => isHost(node) && node.type === 'style' && node.props?.['data-plugin-css'] === 'dsh-better-goal/goal.css').length,
    1,
  )
  assert.equal(byLabel(bar.renderer, 'action.resume'), undefined)
  assert.ok(byLabel(bar.renderer, 'action.pause'))

  await act(async () => { await byLabel(bar.renderer, 'action.pause').props.onClick() })
  assert.equal(bar.setup.goalCalls.length, 1)
  assert.equal(bar.setup.goalCalls[0].method, 'pause')
  assert.equal(bar.setup.goalCalls[0].sessionId, SESSION_ID)
  assert.deepEqual(bar.setup.goalCalls[0].ref, { id: 'goal-1', revision: 4 })
  // No slash-command lifecycle: UI buttons never call commands.execute.
  assert.equal(bar.setup.commandCalls.length, 0)
})

test('UI mutation buttons never execute commands (no command/run lifecycle)', async () => {
  const bar = await mountGoalBar({
    projection: { goal: activeGoal, roundsStarted: 2 },
  })
  await act(async () => { await byLabel(bar.renderer, 'action.pause').props.onClick() })
  assert.equal(bar.setup.commandCalls.length, 0)
  assert.equal(bar.setup.goalCalls.length, 1)
  assert.equal(bar.setup.goalCalls[0].method, 'pause')
  assert.ok(bar.setup.commandCalls.length === 0, 'commands.execute must stay unused')
})

test('CAS ref is read from the live projection at click time, not the rendered snapshot', async () => {
  const bar = await mountGoalBar({
    projection: { goal: activeGoal, roundsStarted: 2 },
  })
  bar.setup.projectionStore.setSilently({
    goal: { ...activeGoal, revision: 9 },
    roundsStarted: 2,
  })
  // The rendered snapshot is still revision 4; the verb reads the live 9.
  await act(async () => { await byLabel(bar.renderer, 'action.pause').props.onClick() })
  assert.deepEqual(bar.setup.goalCalls[0].ref, { id: 'goal-1', revision: 9 })
  assert.equal(bar.setup.commandCalls.length, 0)
})

test('active+disarmed initializes from read-only remote.goals.get and offers UI resume', async () => {
  const bar = await mountGoalBar({
    projection: { goal: activeGoal, roundsStarted: 2 },
    activation: 'disarmed',
  })
  assert.ok(bar.setup.goalReads.length >= 1, 'activation was initialized through remote.goals.get')
  assert.match(pageText(bar.renderer), /phase\.active\.disarmed/)
  assert.equal(byLabel(bar.renderer, 'action.pause'), undefined)
  const resume = byLabel(bar.renderer, 'action.resume')
  assert.ok(resume)

  await act(async () => { await resume.props.onClick() })
  assert.equal(bar.setup.goalCalls.length, 1)
  assert.equal(bar.setup.goalCalls[0].method, 'resume')
  assert.deepEqual(bar.setup.goalCalls[0].ref, { id: 'goal-1', revision: 4 })
  assert.equal(bar.setup.commandCalls.length, 0)
})

test('activation-changed and connection/reset refresh the visible controls without mutation', async () => {
  const bar = await mountGoalBar({
    projection: { goal: activeGoal, roundsStarted: 2 },
    activation: 'armed',
  })
  assert.ok(byLabel(bar.renderer, 'action.pause'))
  assert.equal(byLabel(bar.renderer, 'action.resume'), undefined)

  await act(async () => {
    bar.setup.emitActivation({ id: 'goal-1', revision: 4, activation: 'disarmed' })
    await Promise.resolve()
  })
  assert.equal(byLabel(bar.renderer, 'action.pause'), undefined)
  assert.ok(byLabel(bar.renderer, 'action.resume'))
  assert.match(pageText(bar.renderer), /phase\.active\.disarmed/)

  bar.setup.setActivation('armed')
  await act(async () => {
    bar.setup.emitReset()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  assert.ok(byLabel(bar.renderer, 'action.pause'))
  assert.equal(byLabel(bar.renderer, 'action.resume'), undefined)
  assert.equal(bar.setup.commandCalls.length, 0, 'read-only activation observation never runs commands')
  assert.equal(bar.setup.goalCalls.length, 0, 'read-only activation observation never mutates goals')
})

test('edit opens inline form and saves a CAS-protected remote.goals.edit', async () => {
  const bar = await mountGoalBar({
    projection: { goal: activeGoal, roundsStarted: 2 },
  })
  await act(async () => { byLabel(bar.renderer, 'action.edit').props.onClick() })
  const input = byLabel(bar.renderer, 'objective.aria')
  assert.ok(input)
  assert.equal(input.props.value, activeGoal.objective)
  await act(async () => {
    input.props.onChange({ target: { value: '  Revised objective  ' } })
  })
  await act(async () => { await byLabel(bar.renderer, 'action.save').props.onClick() })
  assert.equal(bar.setup.goalCalls.length, 1)
  assert.equal(bar.setup.goalCalls[0].method, 'edit')
  assert.deepEqual(bar.setup.goalCalls[0].ref, { id: 'goal-1', revision: 4 })
  assert.deepEqual(bar.setup.goalCalls[0].request, { objective: 'Revised objective' })
  assert.equal(bar.setup.commandCalls.length, 0)
  assert.equal(byLabel(bar.renderer, 'objective.aria'), undefined)
})

test('paused goal offers resume and complete/goal-less states render nothing', async () => {
  const paused = await mountGoalBar({
    projection: { goal: { ...activeGoal, phase: 'paused' }, roundsStarted: 1 },
  })
  assert.ok(byLabel(paused.renderer, 'action.resume'))
  assert.equal(byLabel(paused.renderer, 'action.pause'), undefined)
  await act(async () => { await byLabel(paused.renderer, 'action.resume').props.onClick() })
  assert.equal(paused.setup.goalCalls[0].method, 'resume')
  assert.deepEqual(paused.setup.goalCalls[0].ref, { id: 'goal-1', revision: 4 })
  assert.equal(paused.setup.commandCalls.length, 0)

  for (const projection of [null, { goal: { ...activeGoal, phase: 'complete' }, roundsStarted: 4 }]) {
    const empty = await mountGoalBar({ projection })
    assert.equal(empty.renderer.toJSON(), null)
  }
})

test('successful clear hides the strip immediately while the projection catches up', async () => {
  const bar = await mountGoalBar({
    projection: { goal: activeGoal, roundsStarted: 2 },
  })
  await act(async () => { await byLabel(bar.renderer, 'action.clear').props.onClick() })
  assert.equal(bar.setup.goalCalls.length, 1)
  assert.equal(bar.setup.goalCalls[0].method, 'clear')
  assert.deepEqual(bar.setup.goalCalls[0].ref, { id: 'goal-1', revision: 4 })
  assert.equal(bar.setup.commandCalls.length, 0)
  assert.equal(bar.renderer.toJSON(), null)
})

test('remote error and local missing-goal failure render inline without a mutation', async () => {
  const bar = await mountGoalBar({
    projection: { goal: activeGoal, roundsStarted: 2 },
    goalResults: {
      clear: async () => ({ ok: false, error: { code: 'GOAL_STALE_REF', message: 'stale revision' } }),
    },
  })
  await act(async () => { await byLabel(bar.renderer, 'action.clear').props.onClick() })
  assert.match(pageText(bar.renderer), /stale revision \(GOAL_STALE_REF\)/)
  assert.match(pageText(bar.renderer), /phase\.active/)
  assert.equal(bar.setup.commandCalls.length, 0)

  const missing = await mountGoalBar({ projection: null })
  const local = await missing.injected.onPause()
  assert.deepEqual(local, {
    ok: false,
    error: { code: 'no-current-goal', message: 'no current goal to mutate' },
  })
  assert.equal(missing.setup.goalCalls.length, 0)
  assert.equal(missing.setup.commandCalls.length, 0)
})

// ── settings form ──────────────────────────────────────────────────────────

function makeConfigForm({ value = {}, writable = true, revision = 3 } = {}) {
  const snapshot = {
    status: 'ready',
    value,
    base: value,
    user: undefined,
    revision,
    writable,
  }
  const calls = []
  let resolve = null
  return {
    calls,
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: async () => true,
    unset: async () => true,
    mutate(ops, expectedRevision) {
      calls.push({ ops, revision: expectedRevision })
      return new Promise((settle) => { resolve = settle })
    },
    finish(accepted) {
      assert.equal(typeof resolve, 'function', 'mutate is pending')
      const settle = resolve
      resolve = null
      settle(accepted)
    },
  }
}

async function mountSettings(options = {}) {
  const setup = install()
  const record = setup.declare('plugins.row.config')
  const controller = options.controller ?? makeConfigForm(options)
  const form = () => ({ state: controller.getSnapshot(), mutate: (ops, revision) => controller.mutate(ops, revision) })
  const element = () => h(record.component, { view: 'page', t, form: form() })
  let renderer = null
  await act(async () => { renderer = TestRenderer.create(element()) })
  return {
    setup,
    component: record.component,
    controller,
    get renderer() { return renderer },
    async update() { await act(async () => { renderer.update(element()) }) },
  }
}

function rowConfigEntries(setup) {
  return setup.slots.registrations.filter((entry) => entry.options.name === 'plugins.row.config')
}

/** Resolve one keyed slot the way the Plugins page does: exact key equality. */
function dispatchRowConfig(setup, key) {
  const matches = rowConfigEntries(setup).filter((entry) => entry.options.key === key)
  assert.equal(matches.length, 1, `exactly one keyed entry for ${key}`)
  return matches[0]
}

async function mountConfigEntry(record, controller) {
  const form = () => ({
    state: controller.getSnapshot(),
    mutate: (ops, revision) => controller.mutate(ops, revision),
  })
  const element = () => h(record.component, { view: 'page', t, form: form() })
  let renderer = null
  await act(async () => { renderer = TestRenderer.create(element()) })
  return {
    get renderer() { return renderer },
    async update() { await act(async () => { renderer.update(element()) }) },
  }
}

test('three exact row-config keys are unique and each dispatches one shared entry', () => {
  const setup = install()
  setup.declare('plugins.row.config')
  const expected = [ROW_CONFIG_KEY, APOLLO_ROW_CONFIG_KEY, SCOPED_APOLLO_ROW_CONFIG_KEY]
  const rows = rowConfigEntries(setup)
  assert.equal(rows.length, 3, 'each assembly variant registers one row-config entry')
  assert.deepEqual(rows.map((entry) => entry.options.key).sort(), [...expected].sort())
  assert.equal(new Set(rows.map((entry) => entry.options.key)).size, 3, 'the three keys never collide')
  for (const key of expected) {
    const entry = dispatchRowConfig(setup, key)
    assert.equal(entry.options.locale, 'better-goal')
    assert.equal(entry.component, dispatchRowConfig(setup, expected[0]).component)
  }
})

test('standalone, legacy Apollo, and scoped Apollo keys dispatch the same page over one config store', async () => {
  const setup = install()
  setup.declare('plugins.row.config')
  const keys = [ROW_CONFIG_KEY, APOLLO_ROW_CONFIG_KEY, SCOPED_APOLLO_ROW_CONFIG_KEY]
  const entries = keys.map((key) => dispatchRowConfig(setup, key))
  assert.equal(new Set(entries.map((entry) => entry.component)).size, 1)

  // One host form controller stands in for the single plugin row config store.
  const controller = makeConfigForm({
    value: { roundLimitMode: 'agent', roundLimit: 256, questionTimeoutSeconds: 120 },
  })
  const pages = new Map()
  for (const [index, key] of keys.entries()) pages.set(key, await mountConfigEntry(entries[index], controller))
  for (const key of keys) {
    assert.equal(byId(pages.get(key).renderer, 'dsh-better-goal-round-limit-mode').props.value, 'agent')
  }
  assert.equal(controller.calls.length, 0, 'three mounted keys neither activate nor write the shared store')

  // A save through the scoped Apollo key writes the shared form exactly once.
  const scoped = pages.get(SCOPED_APOLLO_ROW_CONFIG_KEY)
  await act(async () => {
    byId(scoped.renderer, 'dsh-better-goal-round-limit-mode').props.onChange({ target: { value: 'fixed' } })
  })
  await act(async () => {
    byId(scoped.renderer, 'dsh-better-goal-round-limit').props.onChange({ target: { value: '512' } })
  })
  await act(async () => { primaryButton(scoped.renderer).props.onClick() })
  assert.equal(controller.calls.length, 1, 'one click writes once, not once per registered key')
  assert.deepEqual(controller.calls[0], {
    ops: [
      { op: 'set', path: ['roundLimitMode'], value: 'fixed' },
      { op: 'set', path: ['roundLimit'], value: 512 },
    ],
    revision: 3,
  })
  await act(async () => { controller.finish(true); await Promise.resolve() })

  // The host mirror's next revision reaches every keyed page unchanged.
  controller.getSnapshot = () => ({
    status: 'ready',
    value: { roundLimitMode: 'fixed', roundLimit: 512, questionTimeoutSeconds: 120 },
    base: undefined,
    user: undefined,
    revision: 4,
    writable: true,
  })
  for (const key of keys) await pages.get(key).update()
  for (const key of keys) {
    assert.equal(byId(pages.get(key).renderer, 'dsh-better-goal-round-limit-mode').props.value, 'fixed')
    assert.equal(byId(pages.get(key).renderer, 'dsh-better-goal-round-limit').props.value, '512')
  }

  // A save through the standalone key writes the same shared form.
  const standalone = pages.get(ROW_CONFIG_KEY)
  await act(async () => {
    byId(standalone.renderer, 'dsh-better-goal-question-timeout').props.onChange({ target: { value: '-1' } })
  })
  await act(async () => { primaryButton(standalone.renderer).props.onClick() })
  assert.equal(controller.calls.length, 2)
  assert.deepEqual(controller.calls[1], {
    ops: [{ op: 'set', path: ['questionTimeoutSeconds'], value: -1 }],
    revision: 4,
  })
  await act(async () => { controller.finish(true); await Promise.resolve() })
})

test('settings page exposes defaults, fixed mode input, validation, and atomic save', async () => {
  const page = await mountSettings({
    value: { roundLimitMode: 'agent', roundLimit: 256, questionTimeoutSeconds: 120 },
  })
  assert.equal(byId(page.renderer, 'dsh-better-goal-round-limit-mode').props.value, 'agent')
  assert.equal(byId(page.renderer, 'dsh-better-goal-round-limit'), undefined)
  assert.equal(byId(page.renderer, 'dsh-better-goal-question-timeout').props.value, '120')
  assert.equal(
    page.renderer.root.findAll((node) => isHost(node) && node.type === 'style' && node.props?.['data-plugin-css'] === 'dsh-better-goal/settings.css').length,
    1,
  )
  assert.equal(primaryButton(page.renderer).props.disabled, true)

  await act(async () => {
    byId(page.renderer, 'dsh-better-goal-round-limit-mode').props.onChange({ target: { value: 'fixed' } })
  })
  const limit = byId(page.renderer, 'dsh-better-goal-round-limit')
  assert.equal(limit.props.value, '256')

  await act(async () => { limit.props.onChange({ target: { value: '0' } }) })
  assert.match(pageText(page.renderer), /invalidRoundLimit/)
  assert.equal(primaryButton(page.renderer).props.disabled, true)

  await act(async () => { byId(page.renderer, 'dsh-better-goal-round-limit').props.onChange({ target: { value: '1024' } }) })
  await act(async () => {
    byId(page.renderer, 'dsh-better-goal-question-timeout').props.onChange({ target: { value: '-1' } })
  })
  assert.equal(primaryButton(page.renderer).props.disabled, false)
  assert.match(pageText(page.renderer), /questionTimeoutNever/)

  await act(async () => { primaryButton(page.renderer).props.onClick() })
  assert.equal(page.controller.calls.length, 1)
  assert.deepEqual(page.controller.calls[0], {
    ops: [
      { op: 'set', path: ['roundLimitMode'], value: 'fixed' },
      { op: 'set', path: ['roundLimit'], value: 1024 },
      { op: 'set', path: ['questionTimeoutSeconds'], value: -1 },
    ],
    revision: 3,
  })
  await act(async () => {
    page.controller.finish(true)
    await Promise.resolve()
  })
  assert.match(pageText(page.renderer), /saved/)
})

test('settings page refuses invalid timeout text and keeps the save disabled', async () => {
  const page = await mountSettings({
    value: { roundLimitMode: 'unlimited', roundLimit: 256, questionTimeoutSeconds: 120 },
  })
  await act(async () => {
    byId(page.renderer, 'dsh-better-goal-question-timeout').props.onChange({ target: { value: '0' } })
  })
  assert.match(pageText(page.renderer), /invalidQuestionTimeout/)
  assert.equal(primaryButton(page.renderer).props.disabled, true)
  assert.equal(page.controller.calls.length, 0)
})

test('settings summary view and unavailable/read-only states', async () => {
  const setup = install()
  const record = setup.declare('plugins.row.config')
  let renderer = null
  await act(async () => {
    renderer = TestRenderer.create(h(record.component, { view: 'summary', t }))
  })
  assert.match(pageText(renderer), /summary/)

  const unavailable = makeConfigForm()
  unavailable.getSnapshot = () => ({ ...makeConfigForm().getSnapshot(), status: 'unavailable', writable: false })
  const page = await mountSettings({ controller: unavailable })
  assert.match(pageText(page.renderer), /unavailable/)
  assert.equal(primaryButton(page.renderer), undefined)
})

test('exported form helpers normalize defaults and validate drafts strictly', () => {
  const { shapeConfig, parseDraft, diffOps } = install().exports
  assert.deepEqual(shapeConfig(undefined), DEFAULTS)
  assert.deepEqual(shapeConfig({ roundLimitMode: 'nope', roundLimit: 0, questionTimeoutSeconds: 0 }), DEFAULTS)
  assert.deepEqual(shapeConfig({ roundLimitMode: 'fixed', roundLimit: UNLIMITED, questionTimeoutSeconds: -1 }), {
    roundLimitMode: 'fixed',
    roundLimit: UNLIMITED,
    questionTimeoutSeconds: -1,
  })
  assert.deepEqual(parseDraft({ roundLimitMode: 'fixed', roundLimit: '1.5', questionTimeoutSeconds: '120' }, { roundLimit: 256 }), {
    error: 'invalidRoundLimit',
  })
  assert.deepEqual(parseDraft({ roundLimitMode: 'agent', roundLimit: 'ignored', questionTimeoutSeconds: '-1' }, { roundLimit: 256 }), {
    value: { roundLimitMode: 'agent', roundLimit: 256, questionTimeoutSeconds: -1 },
  })
  assert.deepEqual(diffOps(
    { roundLimitMode: 'agent', roundLimit: 256, questionTimeoutSeconds: 120 },
    { roundLimitMode: 'fixed', roundLimit: 10, questionTimeoutSeconds: 120 },
  ), [
    { op: 'set', path: ['roundLimitMode'], value: 'fixed' },
    { op: 'set', path: ['roundLimit'], value: 10 },
  ])
})
