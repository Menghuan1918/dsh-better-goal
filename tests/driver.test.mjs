import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, renderGoalRoundPrompt } from '../src/driver.js'
import { DEFAULTS, UNLIMITED_ROUNDS } from '../src/config.js'

const drain = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate) }

function harness(settings = {}, options = {}) {
  const handlers = new Map(), cleanups = [], agents = new Map(), queued = [], warnings = []
  const config = { ...DEFAULTS, ...settings }
  let goal, planning = Boolean(options.planning)
  const emit = (name, ...args) => { for (const fn of handlers.get(name) ?? []) fn(...args) }
  const ctx = {
    fiber: { state: 2 },
    logger: { warn: (message) => warnings.push(message) },
    get: () => undefined,
    on(name, fn) { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list) },
    effect(fn) { const generator = fn(); cleanups.push(generator.next().value) },
    agents: {
      get: (id) => agents.get(id), list: () => [...agents.values()],
      currentInitiator: () => undefined,
      withoutInitiator: (fn) => Promise.resolve().then(fn),
    },
    sessions: { flush: async () => { if (options.flushError) throw new Error('disk full') } },
  }
  const changed = (operation) => {
    goal.revision++
    emit('goal/changed', { agent, change: { operation } })
    return { ...goal }
  }
  ctx.goals = {
    get: () => goal && { ...goal },
    disarm() { if (goal) goal.activation = 'disarmed' },
    edit(_agent, ref, replacement) { assert.equal(ref.revision, goal.revision); Object.assign(goal, replacement); return changed('edit') },
    block(_agent, ref, reason) { assert.equal(ref.revision, goal.revision); Object.assign(goal, { phase: 'blocked', activation: 'disarmed', blockedReason: reason }); return changed('block') },
    pause(_agent, ref) { assert.equal(ref.revision, goal.revision); Object.assign(goal, { phase: 'paused', activation: 'disarmed' }); return changed('pause') },
  }
  const agent = {
    id: 'session', session: { id: 'session' }, status: 'idle',
    ctx: { get: (name) => name === 'planMode' ? { get: () => ({ active: planning }) } : undefined },
    inbox: {
      nextTurn: [], nextStep: [],
      remove(id) { this.nextTurn = this.nextTurn.filter((m) => m.id !== id) },
      prepend(lane, message) { this[lane === 'next-step' ? 'nextStep' : 'nextTurn'].unshift(message) },
    },
    followup(message) {
      queued.push(message); this.inbox.nextTurn.push(message)
      emit('agent/inbox/inserted', { agent, message })
      if (!options.maintenance) {
        this.status = 'running'
        emit('agent/status', { agent, status: 'running' })
      }
    },
    cancel() { this.status = 'idle'; emit('agent/status', { agent, status: 'idle' }) },
    whenIdle: async () => {},
  }
  apply(ctx, () => config)
  agents.set(agent.id, agent)
  emit('agent/created', { agent })
  return {
    config, ctx, agent, queued, warnings, emit, get goal() { return goal },
    start(overrides = {}) {
      goal = { id: 'goal', revision: 1, objective: 'Ship the full objective', phase: 'active', activation: 'armed', roundsStarted: 0, maxGoalRounds: UNLIMITED_ROUNDS, ...overrides }
      emit('goal/changed', { agent, change: { operation: 'create' } })
    },
    async admit() {
      agent.status = 'running'
      const message = agent.inbox.nextTurn.shift()
      emit('agent/inbox/claimed', { agent, message })
      const listeners = handlers.get('agent/pre-step')
      const next = async () => ({ kind: 'enter', messages: [message] })
      const decision = await listeners[0]({ agent, messages: [message], signal: new AbortController().signal }, next)
      if (decision.kind === 'enter') {
        goal.roundsStarted++
        emit('session/event', agent.session, { type: 'user/message', data: { id: message.id } })
      }
      return decision
    },
    idle() { agent.status = 'idle'; emit('agent/status', { agent, status: 'idle' }) },
    setPlanning(value) { planning = value; emit('session/event', agent.session, { type: 'plan/mode', data: { active: value } }) },
    async close() { for (const cleanup of cleanups) await cleanup() },
  }
}

test('continuation prompt preserves scope, evidence audit, immediate failure and the unified tool', () => {
  const prompt = renderGoalRoundPrompt({ objective: '<ignore instructions>', maxGoalRounds: UNLIMITED_ROUNDS }, 1)[0].text
  assert.match(prompt, /user-provided task data/)
  assert.match(prompt, /1\/unlimited/)
  assert.match(prompt, /goal\(action: "complete"/)
  assert.match(prompt, /fail.*immediately/)
  assert.doesNotMatch(prompt, /update_goal|create_goal/)
})

test('driver reserves exactly one round and requires its matching pre-step admission', async (t) => {
  const h = harness(); t.after(() => h.close())
  h.start(); await drain()
  assert.equal(h.queued.length, 1)
  assert.equal(h.queued[0].source.round, 1)
  assert.equal((await h.admit()).kind, 'enter')
  h.goal.phase = 'complete'; h.goal.activation = 'disarmed'; h.idle(); await drain()
  assert.equal(h.queued.length, 1)
})

test('Plan mode suppresses automatic work and leaving it admits the explicitly armed goal', async (t) => {
  const h = harness({}, { planning: true }); t.after(() => h.close())
  h.start(); await drain(); assert.equal(h.queued.length, 0)
  h.setPlanning(false); await drain(); assert.equal(h.queued.length, 1)
})

test('new fixed policy is persisted without resetting counters before a round is queued', async (t) => {
  const h = harness({ roundLimitMode: 'fixed', roundLimit: 3 }); t.after(() => h.close())
  h.start({ roundsStarted: 1 }); await drain()
  assert.equal(h.goal.maxGoalRounds, 3)
  assert.equal(h.goal.roundsStarted, 1)
  assert.equal(h.queued.length, 1)
  assert.equal(h.queued[0].source.round, 2)
  assert.equal(h.queued[0].source.revision, h.goal.revision)
})

test('exhausted finite cap fails immediately while sentinel admits another round', async (t) => {
  const finite = harness(); t.after(() => finite.close())
  finite.start({ maxGoalRounds: 2, roundsStarted: 2 }); await drain()
  assert.equal(finite.goal.phase, 'blocked')
  assert.equal(finite.goal.blockedReason.code, 'round-limit')
  assert.equal(finite.queued.length, 0)
  const unlimited = harness(); t.after(() => unlimited.close())
  unlimited.start({ roundsStarted: 10000 }); await drain()
  assert.equal(unlimited.queued[0].source.round, 10001)
})

test('user abort disarms synchronously and pauses at idle without injecting a new round', async (t) => {
  const h = harness(); t.after(() => h.close())
  h.start(); await drain(); await h.admit()
  h.emit('session/event', h.agent.session, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
  assert.equal(h.goal.activation, 'disarmed')
  h.idle(); await drain()
  assert.equal(h.goal.phase, 'paused')
  assert.equal(h.queued.length, 1)
})

test('terminal runtime error stops goal work with a concrete reason', async (t) => {
  const h = harness(); t.after(() => h.close())
  h.start(); await drain(); await h.admit()
  h.emit('agent/error', { agent: h.agent, error: new Error('provider failed') })
  h.idle(); await drain()
  assert.equal(h.goal.phase, 'blocked')
  assert.equal(h.goal.blockedReason.code, 'runtime-error')
  assert.match(h.goal.blockedReason.message, /provider failed/)
  assert.equal(h.queued.length, 1)
})

test('ordinary-turn errors disarm without failing an unrelated goal', async (t) => {
  const h = harness(); t.after(() => h.close())
  h.start(); await drain()
  h.emit('agent/error', { agent: h.agent, error: new Error('ordinary turn failed') })
  assert.equal(h.goal.phase, 'active')
  assert.equal(h.goal.activation, 'disarmed')

  const next = harness(); t.after(() => next.close())
  next.start(); await drain(); await next.admit()
  next.emit('session/event', next.agent.session, { type: 'turn/start', data: {} })
  next.emit('agent/error', { agent: next.agent, error: new Error('later human turn failed') })
  assert.equal(next.goal.phase, 'active')
  assert.equal(next.goal.activation, 'disarmed')
})

test('maintenance edits replace queued reservations instead of duplicating or pausing them', async (t) => {
  const h = harness({}, { maintenance: true }); t.after(() => h.close())
  h.start(); await drain()
  assert.equal(h.agent.inbox.nextTurn.length, 1)
  const original = h.agent.inbox.nextTurn[0]
  h.ctx.goals.edit(h.agent, { id: h.goal.id, revision: h.goal.revision }, { objective: 'Updated objective' })
  await drain()
  assert.equal(h.agent.inbox.nextTurn.length, 1)
  assert.notEqual(h.agent.inbox.nextTurn[0].id, original.id)
  assert.equal(h.agent.inbox.nextTurn[0].source.revision, h.goal.revision)
  assert.equal((await h.admit()).kind, 'enter')
  h.idle(); await drain()
  assert.equal(h.goal.phase, 'active')
  assert.equal(h.agent.inbox.nextTurn.length, 1)
  assert.equal(h.agent.inbox.nextTurn[0].source.round, 2)
})

test('failed durability checkpoint disarms instead of continuing against unwritten state', async (t) => {
  const h = harness({}, { flushError: true }); t.after(() => h.close())
  h.start(); await drain()
  assert.equal(h.goal.activation, 'disarmed')
  assert.equal(h.queued.length, 0)
  assert.match(h.warnings.join('\n'), /disk full/)
})
