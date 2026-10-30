import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { GoalService, goalProjectionDefinition } from '../src/service.js'
import { createGoalHistoryDefinition } from '../src/history.js'

const ref = (goal) => ({ id: goal.id, revision: goal.revision })

test('real registry restores completed and cleared goals and admitted round counts from the session prefix', async (context) => {
  const ctx = new Context()
  const agents = new Map()
  ctx.provide('agents', { get: (id) => agents.get(id), currentInitiator: () => undefined })
  const store = ctx.plugin(SessionStore)
  const projections = ctx.plugin(SessionProjectionRegistry)
  await Promise.all([store, projections])
  const history = createGoalHistoryDefinition(goalProjectionDefinition)
  const unregister = ctx.sessionProjections.register(history)
  const goals = ctx.plugin(GoalService)
  await goals
  context.after(async () => { unregister(); await goals.dispose(); await projections.dispose(); await store.dispose() })
  const events = []
  ctx.on('session/event', (session, event) => { if (session.id === 'history-source') events.push(event) })
  const session = ctx.sessions.create('history-source', { meta: { cwd: '/tmp' } })
  const agent = { id: session.id, session, status: 'idle' }
  agents.set(agent.id, agent)
  let first = ctx.goals.create(agent, { objective: 'First release', maxGoalRounds: 8 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Continue' }], source: { kind: 'goal', goalId: first.id, revision: first.revision, round: 1 } }), { surfaceOp: 'append' })
  first = ctx.goals.complete(agent, ref(first))
  let second = ctx.goals.create(agent, { objective: 'Second release', maxGoalRounds: 4 })
  second = ctx.goals.edit(agent, ref(second), { objective: 'Revised second release' })
  ctx.goals.clear(agent, ref(second))
  const view = ctx.sessionProjections.snapshot(session).values['better-goal-history']
  assert.equal(view.error, null)
  assert.deepEqual(view.entries.map(({ objective, phase, roundsStarted, cleared }) => ({ objective, phase, roundsStarted, cleared })), [
    { objective: 'First release', phase: 'complete', roundsStarted: 1, cleared: false },
    { objective: 'Revised second release', phase: 'active', roundsStarted: 0, cleared: true },
  ])
  assert.equal(ctx.sessionProjections.snapshot(session).values.goal, null, 'history does not restore a cleared active goal')
  history.wire.viewSchema.parse(view)
  const restored = ctx.sessions.create('history-restored', { seed: events, meta: { cwd: '/tmp' } })
  assert.deepEqual(ctx.sessionProjections.snapshot(restored).values['better-goal-history'], view)
  const state = ctx.sessionProjections.stateOf(restored, 'better-goal-history')
  history.stateSchema.parse(state)
  assert.equal(history.apply(state, { type: 'unrelated', seq: 99, data: {} }), state, 'unrelated events preserve the observable reference')
})

test('history reports invalid goal replay and retains the last trustworthy entries', () => {
  const history = createGoalHistoryDefinition(goalProjectionDefinition)
  const empty = history.init()
  const failed = history.apply(empty, { type: 'goal/change', seq: 0, data: { kind: 'goal/change', version: 99 } })
  assert.match(failed.view.error, /unsupported goal change version/)
  assert.deepEqual(failed.view.entries, [])
  assert.equal(history.apply(failed, { type: 'unrelated', seq: 1, data: {} }), failed)
})
