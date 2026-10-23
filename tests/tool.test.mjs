/** Behaviour tests against the real goal service, projections and session log. */
import assert from 'node:assert/strict'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'

import { GoalService } from '../src/service.js'
import { createGoalTool, executeGoalAction, GOAL_ACTIONS } from '../src/tool.js'
import { executeGoalCommand, parseGoalCommand, registerGoalCommand } from '../src/commands.js'
import { DEFAULTS, UNLIMITED_ROUNDS, readConfig } from '../src/config.js'

let sessionCounter = 0

function config(mode = DEFAULTS.roundLimitMode, roundLimit = DEFAULTS.roundLimit) {
  return { roundLimitMode: mode, roundLimit, questionTimeoutSeconds: DEFAULTS.questionTimeoutSeconds }
}

async function createHarness(initialConfig = config(), { hostPolicy = true } = {}) {
  const ctx = new Context()
  const agents = new Map()
  let initiator
  ctx.provide('agents', {
    get: (id) => agents.get(id),
    roots: () => [...agents.values()],
    currentInitiator: () => initiator,
  })
  const liveConfig = { ...initialConfig }
  const readLiveConfig = () => readConfig(liveConfig)
  if (hostPolicy) ctx.provide('betterGoalConfig', { get: readLiveConfig })

  const storeFork = ctx.plugin(SessionStore)
  const projectionFork = ctx.plugin(SessionProjectionRegistry)
  await Promise.all([storeFork, projectionFork])
  const goalFork = ctx.plugin(GoalService, { defaultMaxGoalRounds: UNLIMITED_ROUNDS })
  await goalFork

  sessionCounter += 1
  const session = ctx.sessions.create(`tool-session-${sessionCounter}`, { meta: { cwd: '/tmp' } })
  const followups = []
  const agent = {
    id: session.id,
    session,
    status: 'running',
    followup: (message) => { followups.push(message) },
  }
  agents.set(agent.id, agent)
  initiator = agent
  const makeExec = (overrides = {}) => ({
    agent,
    callId: 'goal-call',
    signal: new AbortController().signal,
    ...overrides,
  })
  return {
    ctx, session, agent, followups, readLiveConfig, makeExec,
    makeTool: () => createGoalTool(ctx, readLiveConfig),
    invoke: (tool, args) => tool.execute(args, makeExec()),
    getGoal: () => ctx.goals.get(agent),
    setConfig: (patch) => Object.assign(liveConfig, patch),
    setInitiator: (value) => { initiator = value },
    close: async () => {
      for (const fork of [goalFork, storeFork, projectionFork]) {
        try { await fork.dispose() } catch {}
      }
    },
  }
}

// Only native service calls use refs; model invocations never need a CAS field.
function nativeRef(goal) {
  return { id: goal.id, revision: goal.revision }
}

function admitGoalRound(h, goal, round = goal.roundsStarted + 1) {
  h.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `Continue the goal (round ${round}).` }],
    source: { kind: 'goal', goalId: goal.id, revision: goal.revision, round },
  }), { surfaceOp: 'append' })
}

function command(h, rawInput, attachments) {
  return executeGoalCommand(h.ctx, { rawInput, agent: h.agent, attachments }, h.readLiveConfig)
}

async function rejectsWithoutWrites(h, tool, args, check) {
  const events = h.session.snapshotEvents()
  const current = h.getGoal()
  const followups = [...h.followups]
  await assert.rejects(async () => h.invoke(tool, args), check)
  assert.deepEqual(h.session.snapshotEvents(), events)
  assert.deepEqual(h.getGoal(), current)
  assert.deepEqual(h.followups, followups)
}

test('model schema contains exactly five actions, no CAS, and agent-only optional cap', () => {
  assert.deepEqual(GOAL_ACTIONS, ['get', 'set', 'fail', 'complete', 'resume'])
  for (const mode of ['agent', 'fixed', 'unlimited']) {
    const tool = createGoalTool({}, () => readConfig(config(mode, 7)))
    assert.equal(tool.name, 'goal')
    assert.deepEqual(tool.parameters.properties.action.enum, ['get', 'set', 'fail', 'complete', 'resume'])
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(),
      (mode === 'agent' ? ['action', 'objective', 'reason', 'max_goal_rounds'] : ['action', 'objective', 'reason']).sort())
    assert.deepEqual(tool.parameters.required, ['action'])
    assert.ok(!('goal_id' in tool.parameters.properties))
    assert.ok(!('revision' in tool.parameters.properties))
    assert.match(tool.description, /fully replaces/)
    assert.match(tool.parameters.properties.objective.description, /entire user-requested scope/)
  }
})

test('get returns null without a goal and reads the native view without writes', async (t) => {
  const h = await createHarness()
  t.after(() => h.close())
  const tool = h.makeTool()
  const emptyEvents = h.session.snapshotEvents()
  assert.deepEqual(await h.invoke(tool, { action: 'get' }), { goal: null })
  assert.deepEqual(h.session.snapshotEvents(), emptyEvents)
  const { goal } = await h.invoke(tool, { action: 'set', objective: 'Deliver the full scope' })
  const events = h.session.snapshotEvents()
  assert.deepEqual(await h.invoke(tool, { action: 'get' }), { goal })
  assert.deepEqual(h.session.snapshotEvents(), events)
})

for (const phase of ['active', 'paused', 'blocked', 'complete']) {
  test(`set fully replaces a ${phase} goal with a fresh armed goal and full scope`, async (t) => {
    const h = await createHarness()
    t.after(() => h.close())
    const tool = h.makeTool()
    const scope = 'Deliver API, UI, tests and documentation'
    const { goal: first } = await h.invoke(tool, { action: 'set', objective: scope, max_goal_rounds: 5 })
    admitGoalRound(h, first)
    if (phase === 'paused') h.ctx.goals.pause(h.agent, nativeRef(h.getGoal()))
    if (phase === 'blocked') await h.invoke(tool, { action: 'fail', reason: 'A required credential is unavailable' })
    if (phase === 'complete') await h.invoke(tool, { action: 'complete' })
    const previous = h.getGoal()
    const offset = h.session.snapshotEvents().length
    const objective = `${scope}, with fresh acceptance evidence`
    const { goal } = await h.invoke(tool, { action: 'set', objective })
    assert.notEqual(goal.id, previous.id)
    assert.equal(goal.objective, objective)
    assert.equal(goal.revision, 1)
    assert.equal(goal.roundsStarted, 0)
    assert.equal(goal.phase, 'active')
    assert.equal(goal.activation, 'armed')
    assert.equal(goal.maxGoalRounds, UNLIMITED_ROUNDS)
    assert.equal(goal.blockedReason, undefined)
    assert.deepEqual(h.getGoal(), goal)
    const operations = h.session.snapshotEvents().slice(offset).map((event) => event.data.operation)
    assert.deepEqual(operations, phase === 'complete' ? ['create'] : ['clear', 'create'])
  })
}

test('an automatic goal round can set, fail at round zero, resume and complete without human input', async (t) => {
  const h = await createHarness()
  t.after(() => h.close())
  const tool = h.makeTool()
  const { goal: first } = await h.invoke(tool, { action: 'set', objective: 'Initial scope', max_goal_rounds: 5 })
  admitGoalRound(h, first)
  const { goal: fresh } = await h.invoke(tool, { action: 'set', objective: 'Initial scope with evidence', max_goal_rounds: 5 })
  assert.equal(fresh.roundsStarted, 0)
  const { goal: failed } = await h.invoke(tool, { action: 'fail', reason: ' A required provider is unavailable. ' })
  assert.equal(failed.phase, 'blocked')
  assert.equal(failed.activation, 'disarmed')
  assert.equal(failed.roundsStarted, 0)
  assert.deepEqual(failed.blockedReason, { code: 'model-reported', message: 'A required provider is unavailable.' })
  const { goal: resumed } = await h.invoke(tool, { action: 'resume' })
  assert.equal(resumed.id, fresh.id)
  assert.equal(resumed.objective, fresh.objective)
  assert.equal(resumed.phase, 'active')
  assert.equal(resumed.activation, 'armed')
  assert.equal(resumed.blockedReason, undefined)
  const { goal: completed } = await h.invoke(tool, { action: 'complete' })
  assert.equal(completed.id, fresh.id)
  assert.equal(completed.phase, 'complete')
  assert.equal(completed.activation, 'disarmed')
  const messages = h.session.snapshotEvents().filter((event) => event.type === 'user/message')
  assert.equal(messages.length, 1)
  assert.ok(messages.every((event) => event.data.source.kind === 'goal'))
})

for (const phase of ['paused', 'blocked', 'disarmed']) {
  test(`resume from ${phase} can raise an exhausted cap while preserving identity, objective and count`, async (t) => {
    const h = await createHarness()
    t.after(() => h.close())
    const tool = h.makeTool()
    const { goal: first } = await h.invoke(tool, { action: 'set', objective: 'Preserve API, UI and evidence', max_goal_rounds: 1 })
    admitGoalRound(h, first)
    if (phase === 'paused') h.ctx.goals.pause(h.agent, nativeRef(h.getGoal()))
    if (phase === 'blocked') await h.invoke(tool, { action: 'fail', reason: 'Temporary blocker' })
    if (phase === 'disarmed') h.ctx.goals.disarm(h.agent)
    const previous = h.getGoal()
    const { goal } = await h.invoke(tool, { action: 'resume', max_goal_rounds: 3 })
    assert.equal(goal.id, previous.id)
    assert.equal(goal.objective, previous.objective)
    assert.equal(goal.roundsStarted, 1)
    assert.equal(goal.maxGoalRounds, 3)
    assert.equal(goal.phase, 'active')
    assert.equal(goal.activation, 'armed')
    assert.equal(goal.revision, previous.revision + 2)
    assert.equal(goal.createdAt, previous.createdAt)
  })
}

test('executeGoalAction derives each native CAS ref from live state, with no caller CAS', async (t) => {
  const h = await createHarness()
  t.after(() => h.close())
  const goals = h.ctx.goals
  const calls = []
  for (const name of ['clear', 'edit', 'resume', 'block', 'complete']) {
    const original = goals[name]
    t.mock.method(goals, name, function (agent, ref, ...rest) {
      assert.deepEqual(ref, nativeRef(goals.get(agent)))
      calls.push({ name, ref: { ...ref } })
      return original.call(this, agent, ref, ...rest)
    })
  }
  const execute = (args) => executeGoalAction(h.ctx, h.agent, args, h.readLiveConfig())
  const { goal: first } = execute({ action: 'set', objective: 'First scope', max_goal_rounds: 5 })
  // A native human edit may change the revision after the model's last read.
  goals.edit(h.agent, nativeRef(first), { objective: 'Full live scope' })
  const { goal: failed } = execute({ action: 'fail', reason: 'External blocker' })
  assert.equal(failed.objective, 'Full live scope')
  const { goal: resumed } = execute({ action: 'resume', max_goal_rounds: 8 })
  const { goal: completed } = execute({ action: 'complete' })
  assert.equal(completed.revision, resumed.revision + 1)
  execute({ action: 'set', objective: 'Next scope' })
  const { goal: replacement } = execute({ action: 'set', objective: 'Replacement full scope' })
  assert.notEqual(replacement.id, completed.id)
  assert.ok(calls.some((call) => call.name === 'clear'))
  assert.ok(calls.some((call) => call.name === 'edit'))
  assert.ok(calls.some((call) => call.name === 'resume'))
  assert.ok(calls.some((call) => call.name === 'block'))
  assert.ok(calls.some((call) => call.name === 'complete'))
})

test('removed model actions and caller CAS fields are rejected, not treated as successful aliases', async (t) => {
  const h = await createHarness()
  t.after(() => h.close())
  const tool = h.makeTool()
  await h.invoke(tool, { action: 'set', objective: 'Keep this scope' })
  for (const action of ['create', 'edit', 'pause', 'clear', 'on', 'off', 'unknown']) {
    await rejectsWithoutWrites(h, tool, { action }, (error) => error.code === 'INVALID_ARGS')
    assert.throws(() => executeGoalAction(h.ctx, h.agent, { action }, h.readLiveConfig()),
      (error) => error.code === 'GOAL_INVALID_ACTION')
  }
  for (const extra of [{ goal_id: h.getGoal().id }, { revision: h.getGoal().revision }]) {
    await rejectsWithoutWrites(h, tool, { action: 'complete', ...extra },
      (error) => error.code === 'GOAL_INVALID_ACTION' && /Unknown goal parameter/.test(error.message))
    assert.throws(() => executeGoalAction(h.ctx, h.agent, { action: 'complete', ...extra }, h.readLiveConfig()),
      (error) => error.code === 'GOAL_INVALID_ACTION' && /Unknown goal parameter/.test(error.message))
  }
})

test('missing-goal mutations instruct set and never write', async (t) => {
  const h = await createHarness()
  t.after(() => h.close())
  const tool = h.makeTool()
  for (const args of [{ action: 'fail', reason: 'Concrete blocker' }, { action: 'complete' }, { action: 'resume' }]) {
    await rejectsWithoutWrites(h, tool, args,
      (error) => error.code === 'GOAL_INVALID_ACTION' && /use set first/.test(error.message) && !/create|edit/.test(error.message))
  }
})

test('strict empty-string and zero filler remains compatible across the five actions', async (t) => {
  const h = await createHarness()
  t.after(() => h.close())
  const tool = h.makeTool()
  const filler = { objective: '', reason: '', max_goal_rounds: 0 }
  assert.deepEqual(await h.invoke(tool, { action: 'get', ...filler }), { goal: null })
  const { goal: first } = await h.invoke(tool, { action: 'set', ...filler, objective: 'Whole scope', max_goal_rounds: 5 })
  const { goal: failed } = await h.invoke(tool, { action: 'fail', ...filler, reason: 'Concrete blocker' })
  assert.equal(failed.phase, 'blocked')
  const { goal: resumed } = await h.invoke(tool, { action: 'resume', ...filler })
  assert.equal(resumed.maxGoalRounds, 5)
  assert.equal(resumed.revision, failed.revision + 1)
  const { goal: completed } = await h.invoke(tool, { action: 'complete', ...filler })
  assert.equal(completed.phase, 'complete')
  const { goal: replacement } = await h.invoke(tool, { action: 'set', ...filler, objective: 'Whole new scope' })
  assert.notEqual(replacement.id, first.id)
  assert.equal(replacement.maxGoalRounds, UNLIMITED_ROUNDS)
  await rejectsWithoutWrites(h, tool, { action: 'set', ...filler },
    (error) => error.code === 'GOAL_INVALID_ACTION' && /set requires a non-empty objective/.test(error.message))
  await rejectsWithoutWrites(h, tool, { action: 'fail', ...filler },
    (error) => error.code === 'GOAL_INVALID_ACTION' && /fail requires a concrete reason/.test(error.message))
})

test('action-specific arguments are validated before any mutation, including set/get early paths', async (t) => {
  const h = await createHarness()
  t.after(() => h.close())
  const tool = h.makeTool()
  await h.invoke(tool, { action: 'set', objective: 'Preserve the original scope', max_goal_rounds: 5 })
  const cases = [
    { action: 'set', objective: 'Would replace', reason: 'Unrelated reason' },
    { action: 'set', objective: '   ' },
    { action: 'set' },
    { action: 'get', objective: 'Unrelated objective' },
    { action: 'get', reason: 'Unrelated reason' },
    { action: 'get', max_goal_rounds: 2 },
    { action: 'fail', reason: 'Blocker', objective: 'Unrelated objective' },
    { action: 'fail', reason: 'Blocker', max_goal_rounds: 2 },
    { action: 'fail', reason: '   ' },
    { action: 'fail' },
    { action: 'complete', objective: 'Unrelated objective' },
    { action: 'complete', reason: 'Unrelated reason' },
    { action: 'complete', max_goal_rounds: 2 },
    { action: 'resume', objective: 'Unrelated objective' },
    { action: 'resume', reason: 'Unrelated reason' },
  ]
  for (const args of cases) await rejectsWithoutWrites(h, tool, args, (error) => error.code === 'GOAL_INVALID_ACTION')
  for (const action of ['set', 'resume']) {
    for (const cap of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await rejectsWithoutWrites(h, tool, {
        action, ...(action === 'set' ? { objective: 'Would replace' } : {}), max_goal_rounds: cap,
      }, (error) => error instanceof TypeError || error.code === 'INVALID_ARGS')
    }
  }
})

for (const state of ['armed', 'complete', 'exhausted']) {
  test(`rejected ${state} resume leaves cap, revision, activation and log untouched`, async (t) => {
    const h = await createHarness()
    t.after(() => h.close())
    const tool = h.makeTool()
    const { goal } = await h.invoke(tool, { action: 'set', objective: 'Keep complete scope', max_goal_rounds: 5 })
    if (state === 'complete') await h.invoke(tool, { action: 'complete' })
    if (state === 'exhausted') {
      admitGoalRound(h, goal)
      h.ctx.goals.pause(h.agent, nativeRef(h.getGoal()))
    }
    await rejectsWithoutWrites(h, tool, { action: 'resume', max_goal_rounds: state === 'exhausted' ? 1 : 9 },
      (error) => error.code === 'GOAL_INVALID_TRANSITION')
  })
}

test('invalid native fail/complete transitions do not write', async (t) => {
  const h = await createHarness()
  t.after(() => h.close())
  const tool = h.makeTool()
  await h.invoke(tool, { action: 'set', objective: 'Transition target' })
  h.ctx.goals.pause(h.agent, nativeRef(h.getGoal()))
  await rejectsWithoutWrites(h, tool, { action: 'fail', reason: 'Cannot block a paused goal' },
    (error) => error.code === 'GOAL_INVALID_TRANSITION')
  await h.invoke(tool, { action: 'complete' })
  await rejectsWithoutWrites(h, tool, { action: 'complete' }, (error) => error.code === 'GOAL_INVALID_TRANSITION')
})

for (const mode of ['fixed', 'unlimited']) {
  test(`live ${mode} host policy overrides stale supplied caps for set and exhausted resume`, async (t) => {
    const h = await createHarness()
    t.after(() => h.close())
    const tool = h.makeTool()
    assert.ok('max_goal_rounds' in tool.parameters.properties)
    const { goal } = await h.invoke(tool, { action: 'set', objective: 'Policy scope', max_goal_rounds: 1 })
    admitGoalRound(h, goal)
    h.ctx.goals.pause(h.agent, nativeRef(h.getGoal()))
    h.setConfig({ roundLimitMode: mode, roundLimit: 9 })
    const expected = mode === 'fixed' ? 9 : UNLIMITED_ROUNDS
    const { goal: resumed } = await h.invoke(tool, { action: 'resume', max_goal_rounds: 1 })
    assert.equal(resumed.maxGoalRounds, expected)
    assert.equal(resumed.roundsStarted, 1)
    assert.equal(resumed.objective, goal.objective)
    const { goal: replacement } = await h.invoke(tool, { action: 'set', objective: 'Full replacement scope', max_goal_rounds: 999 })
    assert.equal(replacement.maxGoalRounds, expected)
    assert.equal(replacement.roundsStarted, 0)
    assert.notEqual(replacement.id, resumed.id)
    for (const cap of [-1, 1.5]) {
      await rejectsWithoutWrites(h, tool, { action: 'set', objective: 'Invalid replacement', max_goal_rounds: cap },
        (error) => error instanceof TypeError || error.code === 'INVALID_ARGS')
    }
  })
}

test('native host policy wins over a stale adapter snapshot before resume/set writes', async (t) => {
  const h = await createHarness()
  t.after(() => h.close())
  const stale = h.readLiveConfig()
  const tool = h.makeTool()
  const { goal } = await h.invoke(tool, { action: 'set', objective: 'Live host scope', max_goal_rounds: 5 })
  admitGoalRound(h, goal)
  h.ctx.goals.pause(h.agent, nativeRef(h.getGoal()))
  h.setConfig({ roundLimitMode: 'fixed', roundLimit: 1 })
  const events = h.session.snapshotEvents()
  const current = h.getGoal()
  assert.throws(() => executeGoalAction(h.ctx, h.agent, { action: 'resume', max_goal_rounds: 9 }, stale),
    (error) => error.code === 'GOAL_INVALID_TRANSITION')
  assert.deepEqual(h.session.snapshotEvents(), events)
  assert.deepEqual(h.getGoal(), current)
  h.setConfig({ roundLimit: 7 })
  const { goal: replacement } = executeGoalAction(h.ctx, h.agent,
    { action: 'set', objective: 'Full new scope', max_goal_rounds: 999 }, stale)
  assert.equal(replacement.maxGoalRounds, 7)
})

test('invalid host create policy fails before set can clear the existing goal', async (t) => {
  const h = await createHarness()
  t.after(() => h.close())
  const tool = h.makeTool()
  await h.invoke(tool, { action: 'set', objective: 'Preserve existing scope' })
  const stale = h.readLiveConfig()
  h.setConfig({ roundLimitMode: 'fixed', roundLimit: -1 })
  const events = h.session.snapshotEvents()
  const current = h.getGoal()
  assert.throws(() => executeGoalAction(h.ctx, h.agent, { action: 'set', objective: 'Rejected replacement' }, stale), TypeError)
  assert.deepEqual(h.session.snapshotEvents(), events)
  assert.deepEqual(h.getGoal(), current)
})

test('strict zero cap follows live policy: set gets fresh default, resume preserves agent cap', async (t) => {
  const h = await createHarness()
  t.after(() => h.close())
  const tool = h.makeTool()
  await h.invoke(tool, { action: 'set', objective: 'Zero cap target', max_goal_rounds: 5 })
  h.ctx.goals.pause(h.agent, nativeRef(h.getGoal()))
  const { goal: resumed } = await h.invoke(tool, { action: 'resume', max_goal_rounds: 0 })
  assert.equal(resumed.maxGoalRounds, 5)
  const { goal: fresh } = await h.invoke(tool, { action: 'set', objective: 'Zero cap fresh scope', max_goal_rounds: 0 })
  assert.equal(fresh.maxGoalRounds, UNLIMITED_ROUNDS)
  h.setConfig({ roundLimitMode: 'fixed', roundLimit: 7 })
  const { goal: fixed } = await h.invoke(tool, { action: 'set', objective: 'Zero cap fixed scope', max_goal_rounds: 0 })
  assert.equal(fixed.maxGoalRounds, 7)
})

test('tool and commands still work without the optional service policy provider', async (t) => {
  const h = await createHarness(config('fixed', 7), { hostPolicy: false })
  t.after(() => h.close())
  const tool = h.makeTool()
  const { goal } = await h.invoke(tool, { action: 'set', objective: 'Standalone policy scope' })
  assert.equal(goal.maxGoalRounds, 7)
  assert.equal(command(h, 'off').kind, 'success')
  h.setConfig({ roundLimit: 9 })
  const { goal: resumed } = await h.invoke(tool, { action: 'resume' })
  assert.equal(resumed.maxGoalRounds, 9)
  assert.equal(command(h, 'edit Same full scope with evidence').kind, 'success')
  assert.equal(h.getGoal().id, goal.id)
  assert.equal(h.getGoal().maxGoalRounds, 9)
})

test('liveGoalAgent rejects missing, copied, stopped and wrong-initiator callers without writes', async (t) => {
  const h = await createHarness()
  t.after(() => h.close())
  const tool = h.makeTool()
  await h.invoke(tool, { action: 'set', objective: 'Keep live ownership' })
  const events = h.session.snapshotEvents()
  const current = h.getGoal()
  for (const agent of [undefined, { ...h.agent }]) {
    await assert.rejects(async () => tool.execute({ action: 'set', objective: 'Unauthorized replacement' }, h.makeExec({ agent })),
      (error) => error.code === 'GOAL_CALLER_NOT_LIVE')
  }
  h.agent.status = 'idle'
  await assert.rejects(async () => h.invoke(tool, { action: 'complete' }), (error) => error.code === 'GOAL_CALLER_NOT_LIVE')
  h.agent.status = 'running'
  h.setInitiator({ ...h.agent })
  await assert.rejects(async () => h.invoke(tool, { action: 'complete' }), (error) => error.code === 'GOAL_CALLER_NOT_LIVE')
  h.setInitiator(h.agent)
  assert.deepEqual(h.session.snapshotEvents(), events)
  assert.deepEqual(h.getGoal(), current)
})

test('slash parser preserves old controls and exposes explicit set without model aliases', () => {
  for (const [input, expected] of [
    ['', { action: 'get' }], ['get', { action: 'get' }], ['off', { action: 'pause' }], ['ON', { action: 'resume' }],
    ['pause', { action: 'pause' }], ['resume', { action: 'resume' }], ['clear', { action: 'clear' }], ['complete', { action: 'complete' }],
    ['create Scope', { action: 'create', objective: 'Scope' }], ['set Scope', { action: 'set', objective: 'Scope' }],
    ['edit Scope', { action: 'edit', objective: 'Scope' }], ['fail Blocker', { action: 'fail', reason: 'Blocker' }],
    ['Whole objective', { action: 'create', objective: 'Whole objective' }],
  ]) assert.deepEqual(parseGoalCommand(input), expected)
  for (const input of ['create', 'set', 'edit', 'fail']) assert.throws(() => parseGoalCommand(input), /requires text/)
})

test('human create/edit/on/off/pause/clear retain native compatibility and attachments', async (t) => {
  const h = await createHarness()
  t.after(() => h.close())
  const tool = h.makeTool()
  assert.equal(command(h, 'clear').text, 'No goal to clear.')
  const attachments = [{ type: 'text', text: 'Acceptance notes' }]
  assert.equal(command(h, 'create API and UI', attachments).kind, 'success')
  const first = h.getGoal()
  admitGoalRound(h, first)
  assert.equal(command(h, 'off').kind, 'success')
  assert.equal(h.getGoal().phase, 'paused')
  const paused = h.getGoal()
  assert.equal(command(h, 'edit API and UI with evidence', attachments).kind, 'success')
  const edited = h.getGoal()
  assert.equal(edited.id, first.id)
  assert.equal(edited.roundsStarted, 1)
  assert.equal(edited.phase, 'paused')
  assert.equal(edited.activation, 'disarmed')
  assert.equal(edited.revision, paused.revision + 1)
  assert.equal(command(h, 'on').kind, 'success')
  assert.equal(h.getGoal().activation, 'armed')
  assert.equal(command(h, 'pause').kind, 'success')
  assert.equal(command(h, 'resume').kind, 'success')
  const { goal: completed } = await h.invoke(tool, { action: 'complete' })
  assert.equal(command(h, 'edit API and UI v2', attachments).kind, 'success')
  const replacement = h.getGoal()
  assert.notEqual(replacement.id, completed.id)
  assert.equal(replacement.revision, 1)
  assert.equal(replacement.roundsStarted, 0)
  assert.equal(replacement.phase, 'active')
  assert.equal(replacement.activation, 'armed')
  assert.equal(replacement.maxGoalRounds, UNLIMITED_ROUNDS)
  assert.equal(h.followups.length, 3)
  for (const message of h.followups) {
    assert.equal(message.source.kind, 'user')
    assert.deepEqual(message.content[0], attachments[0])
    assert.equal(message.content.at(-1).text, 'Reference attachments for the goal objective.')
  }
  assert.equal(command(h, 'clear').text, 'Goal cleared.')
  assert.equal(h.getGoal(), undefined)
  assert.equal(command(h, 'New free-text objective').kind, 'success')
  assert.equal(h.getGoal().objective, 'New free-text objective')
})

test('human set/create replacements and fail/get/complete commands share the five-action state', async (t) => {
  const h = await createHarness()
  t.after(() => h.close())
  assert.equal(command(h, 'set Full original scope').kind, 'success')
  const first = h.getGoal()
  assert.equal(command(h, 'create Full replacement scope').kind, 'success')
  assert.notEqual(h.getGoal().id, first.id)
  assert.equal(command(h, 'fail External dependency').kind, 'success')
  assert.equal(h.getGoal().phase, 'blocked')
  assert.match(command(h, 'get').text, /Reason: External dependency/)
  assert.equal(command(h, 'resume').kind, 'success')
  assert.equal(command(h, 'complete').kind, 'success')
  assert.equal(h.getGoal().phase, 'complete')
})

test('slash failures validate attachments and missing state before writes or followups', async (t) => {
  const h = await createHarness()
  t.after(() => h.close())
  for (const rawInput of ['edit Scope', 'pause', 'off', 'resume', 'on', 'complete', 'fail Blocker']) {
    const result = command(h, rawInput)
    assert.equal(result.kind, 'error')
    assert.match(result.text, /set/)
  }
  assert.equal(command(h, '').kind, 'success')
  assert.match(command(h, '').text, /set/)
  command(h, 'set Preserve complete scope')
  const attachments = [{ type: 'text', text: 'Disallowed control attachment' }]
  const events = h.session.snapshotEvents()
  const current = h.getGoal()
  for (const rawInput of ['get', 'pause', 'off', 'resume', 'clear', 'complete', 'fail Blocker']) {
    const result = command(h, rawInput, attachments)
    assert.equal(result.kind, 'error')
    assert.match(result.text, /Attachments require a goal objective/)
  }
  for (const rawInput of ['set', 'create', 'edit', 'fail']) assert.equal(command(h, rawInput, attachments).kind, 'error')
  assert.deepEqual(h.session.snapshotEvents(), events)
  assert.deepEqual(h.getGoal(), current)
  assert.deepEqual(h.followups, [])
})

test('slash registration retains an actionable hint and attachment capability', () => {
  let registration
  const dispose = () => {}
  const ctx = { get: (key) => key === 'commands' ? { register: (value) => { registration = value; return dispose } } : undefined }
  assert.equal(registerGoalCommand(ctx, () => config()), dispose)
  assert.equal(registration.name, 'goal')
  assert.equal(registration.definitionId, 'dsh-better-goal')
  assert.equal(registration.input.attachments, true)
  for (const syntax of ['<objective>', 'edit <objective>', 'pause', 'resume', 'clear', 'set <objective>']) {
    assert.ok(registration.input.hint.includes(syntax))
  }
})
