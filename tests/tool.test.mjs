/**
 * Behaviour tests for the independent goal tool and human command adapters.
 *
 * These use the real GoalService, SessionStore, and SessionProjectionRegistry
 * with a small faithful agents registry. They intentionally do not mirror
 * implementation internals: every assertion is on observable tool/service or
 * command output.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'

import { GoalService } from '../src/service.js'
import {
  createGoalTool,
  executeGoalAction,
  GOAL_ACTIONS,
} from '../src/tool.js'
import { executeGoalCommand, parseGoalCommand } from '../src/commands.js'
import {
  DEFAULTS,
  UNLIMITED_ROUNDS,
  readConfig,
} from '../src/config.js'

let sessionCounter = 0

function config(mode = DEFAULTS.roundLimitMode, roundLimit = DEFAULTS.roundLimit) {
  return {
    roundLimitMode: mode,
    roundLimit,
    questionTimeoutSeconds: DEFAULTS.questionTimeoutSeconds,
  }
}

async function createHarness(initialConfig = config()) {
  const ctx = new Context()
  const agents = new Map()
  let initiator
  ctx.provide('agents', {
    get: (id) => agents.get(id),
    roots: () => [...agents.values()],
    currentInitiator: () => initiator,
  })

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

  const liveConfig = { ...initialConfig }
  const readLiveConfig = () => readConfig(liveConfig)
  const makeTool = () => createGoalTool(ctx, readLiveConfig)
  const makeExec = (overrides = {}) => ({
    agent,
    callId: 'goal-call',
    signal: new AbortController().signal,
    ...overrides,
  })
  const invoke = (tool, args) => tool.execute(args, makeExec())
  const getGoal = () => ctx.goals.get(agent)
  const setConfig = (patch) => Object.assign(liveConfig, patch)

  return {
    ctx,
    session,
    agent,
    followups,
    readLiveConfig,
    makeTool,
    makeExec,
    invoke,
    getGoal,
    setConfig,
    close: async () => {
      for (const fork of [goalFork, storeFork, projectionFork]) {
        try { await fork.dispose() } catch {}
      }
    },
  }
}

function goalArgs(goal, action, extra = {}) {
  return { action, goal_id: goal.id, revision: goal.revision, ...extra }
}

function admitGoalRound(h, goal, round = 1) {
  h.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `Continue the goal (round ${round}).` }],
    source: {
      kind: 'goal',
      goalId: goal.id,
      revision: goal.revision,
      round,
    },
  }), { surfaceOp: 'append' })
}

test('goal schema exposes max_goal_rounds only in agent mode', () => {
  const agentTool = createGoalTool({}, () => readConfig(config('agent')))
  const fixedTool = createGoalTool({}, () => readConfig(config('fixed', 7)))
  const unlimitedTool = createGoalTool({}, () => readConfig(config('unlimited')))

  assert.equal(agentTool.name, 'goal')
  assert.equal(fixedTool.name, 'goal')
  assert.equal(unlimitedTool.name, 'goal')
  assert.deepEqual(agentTool.parameters.properties.action.enum, GOAL_ACTIONS)
  assert.ok('max_goal_rounds' in agentTool.parameters.properties)
  assert.ok(!('max_goal_rounds' in fixedTool.parameters.properties))
  assert.ok(!('max_goal_rounds' in unlimitedTool.parameters.properties))
  assert.ok(!(agentTool.parameters.required ?? []).includes('max_goal_rounds'))
  assert.deepEqual(agentTool.parameters.required, ['action'])
})

test('an automatic goal round can create, edit, pause, resume, fail, complete, and clear without human input', async (t) => {
  const h = await createHarness(config('agent'))
  t.after(() => h.close())
  const tool = h.makeTool()

  assert.deepEqual(await h.invoke(tool, { action: 'get' }), { goal: null })

  const created = await h.invoke(tool, {
    action: 'create',
    objective: 'Ship the complete feature',
    max_goal_rounds: 5,
  })
  assert.equal(created.goal.phase, 'active')
  assert.equal(created.goal.activation, 'armed')
  assert.equal(created.goal.maxGoalRounds, 5)
  assert.equal(created.goal.roundsStarted, 0)

  // This is the admitted automatic goal round, not a human turn.
  h.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Continue the goal.' }],
    source: {
      kind: 'goal',
      goalId: created.goal.id,
      revision: created.goal.revision,
      round: 1,
    },
  }), { surfaceOp: 'append' })
  const roundGoal = h.getGoal()
  assert.equal(roundGoal.activation, 'armed')
  assert.equal(roundGoal.roundsStarted, 1)

  const edited = await h.invoke(tool, goalArgs(roundGoal, 'edit', {
    objective: 'Ship the complete feature with evidence',
  }))
  assert.equal(edited.goal.objective, 'Ship the complete feature with evidence')
  assert.equal(edited.goal.revision, roundGoal.revision + 1)
  assert.equal(edited.goal.roundsStarted, 1)

  await assert.rejects(
    () => h.invoke(tool, goalArgs(roundGoal, 'edit', { objective: 'stale edit' })),
    (error) => error.code === 'GOAL_STALE_REF',
  )
  assert.equal(h.getGoal().objective, 'Ship the complete feature with evidence')

  const paused = await h.invoke(tool, goalArgs(edited.goal, 'pause'))
  assert.equal(paused.goal.phase, 'paused')
  assert.equal(paused.goal.activation, 'disarmed')

  // Paused by the Agent, then resumed by the Agent in a later automatic round.
  const resumed = await h.invoke(tool, goalArgs(paused.goal, 'resume'))
  assert.equal(resumed.goal.phase, 'active')
  assert.equal(resumed.goal.activation, 'armed')
  assert.equal(resumed.goal.revision, paused.goal.revision + 1)

  const failed = await h.invoke(tool, goalArgs(resumed.goal, 'fail', {
    reason: 'The external credentials are unavailable.',
  }))
  assert.equal(failed.goal.phase, 'blocked')
  assert.equal(failed.goal.activation, 'disarmed')
  assert.deepEqual(failed.goal.blockedReason, {
    code: 'model-reported',
    message: 'The external credentials are unavailable.',
  })

  const resumedFromBlocked = await h.invoke(tool, goalArgs(failed.goal, 'resume'))
  assert.equal(resumedFromBlocked.goal.phase, 'active')
  assert.equal(resumedFromBlocked.goal.activation, 'armed')

  const completed = await h.invoke(tool, goalArgs(resumedFromBlocked.goal, 'complete'))
  assert.equal(completed.goal.phase, 'complete')
  assert.equal(completed.goal.activation, 'disarmed')

  const cleared = await h.invoke(tool, goalArgs(completed.goal, 'clear'))
  assert.deepEqual(cleared, { goal: null })
  assert.equal(h.getGoal(), undefined)

  const replacement = await h.invoke(tool, {
    action: 'create',
    objective: 'A fresh goal after clear',
  })
  assert.equal(replacement.goal.phase, 'active')
  assert.equal(replacement.goal.activation, 'armed')
  assert.equal(replacement.goal.roundsStarted, 0)

  const messages = h.session.snapshotEvents().filter((event) => event.type === 'user/message')
  assert.equal(messages.length, 1)
  assert.equal(messages[0].data.source.kind, 'goal')
  assert.ok(messages.every((event) => event.data.source.kind !== 'user'))
})

test('fail at round zero is accepted immediately with the durable blocker', async (t) => {
  const h = await createHarness(config('agent'))
  t.after(() => h.close())
  const tool = h.makeTool()

  const created = await h.invoke(tool, {
    action: 'create',
    objective: 'Immediate failure',
    max_goal_rounds: 5,
  })
  assert.equal(created.goal.roundsStarted, 0)

  const failed = await h.invoke(tool, goalArgs(created.goal, 'fail', {
    reason: 'A required provider is unavailable.',
  }))
  assert.equal(failed.goal.phase, 'blocked')
  assert.equal(failed.goal.roundsStarted, 0)
  assert.deepEqual(failed.goal.blockedReason, {
    code: 'model-reported',
    message: 'A required provider is unavailable.',
  })
  assert.equal(h.session.snapshotEvents().filter((event) => event.type === 'user/message').length, 0)
})

test('fixed and unlimited settings override stale schema values; agent omission uses the sentinel', async (t) => {
  const sentinelHarness = await createHarness(config('agent'))
  t.after(() => sentinelHarness.close())
  const sentinelTool = sentinelHarness.makeTool()
  const sentinelGoal = await sentinelHarness.invoke(sentinelTool, {
    action: 'create',
    objective: 'Agent omitted cap',
  })
  assert.equal(sentinelGoal.goal.maxGoalRounds, UNLIMITED_ROUNDS)
  assert.ok('max_goal_rounds' in sentinelTool.parameters.properties)

  const suppliedHarness = await createHarness(config('agent'))
  t.after(() => suppliedHarness.close())
  const suppliedTool = suppliedHarness.makeTool()
  const suppliedGoal = await suppliedHarness.invoke(suppliedTool, {
    action: 'create',
    objective: 'Agent supplied cap',
    max_goal_rounds: 5,
  })
  assert.equal(suppliedGoal.goal.maxGoalRounds, 5)

  const fixedHarness = await createHarness(config('fixed', 7))
  t.after(() => fixedHarness.close())
  const fixedTool = fixedHarness.makeTool()
  assert.ok(!('max_goal_rounds' in fixedTool.parameters.properties))
  const fixedGoal = await fixedHarness.invoke(fixedTool, {
    action: 'create',
    objective: 'Fixed setting',
  })
  assert.equal(fixedGoal.goal.maxGoalRounds, 7)

  // A tool captured under the old agent-mode schema still sees the execution
  // policy read live config; the stale supplied value cannot win.
  const staleHarness = await createHarness(config('agent'))
  t.after(() => staleHarness.close())
  const staleTool = staleHarness.makeTool()
  assert.ok('max_goal_rounds' in staleTool.parameters.properties)
  staleHarness.setConfig({ roundLimitMode: 'fixed', roundLimit: 7 })
  const fixedOverride = await staleHarness.invoke(staleTool, {
    action: 'create',
    objective: 'Fixed overrides stale schema',
    max_goal_rounds: 999,
  })
  assert.equal(fixedOverride.goal.maxGoalRounds, 7)

  const unlimitedHarness = await createHarness(config('agent'))
  t.after(() => unlimitedHarness.close())
  const unlimitedTool = unlimitedHarness.makeTool()
  unlimitedHarness.setConfig({ roundLimitMode: 'unlimited' })
  const unlimitedOverride = await unlimitedHarness.invoke(unlimitedTool, {
    action: 'create',
    objective: 'Unlimited overrides stale schema',
    max_goal_rounds: 999,
  })
  assert.equal(unlimitedOverride.goal.maxGoalRounds, UNLIMITED_ROUNDS)

  const fixedResumeHarness = await createHarness(config('agent'))
  t.after(() => fixedResumeHarness.close())
  const fixedResumeTool = fixedResumeHarness.makeTool()
  const fixedBase = await fixedResumeHarness.invoke(fixedResumeTool, {
    action: 'create',
    objective: 'Resume policy',
    max_goal_rounds: 3,
  })
  const fixedPaused = await fixedResumeHarness.invoke(fixedResumeTool, goalArgs(fixedBase.goal, 'pause'))
  fixedResumeHarness.setConfig({ roundLimitMode: 'fixed', roundLimit: 9 })
  const fixedResumed = await fixedResumeHarness.invoke(fixedResumeTool, goalArgs(fixedPaused.goal, 'resume'))
  assert.equal(fixedResumed.goal.maxGoalRounds, 9)
  assert.equal(fixedResumed.goal.phase, 'active')
})

test('human edit and on/off commands share the same live goal state', async (t) => {
  const h = await createHarness(config('agent'))
  t.after(() => h.close())
  const tool = h.makeTool()

  const created = await h.invoke(tool, { action: 'create', objective: 'Command goal', max_goal_rounds: 5 })
  assert.equal(created.goal.phase, 'active')
  assert.deepEqual(parseGoalCommand('off'), { action: 'pause' })
  assert.deepEqual(parseGoalCommand('on'), { action: 'resume' })

  const off = executeGoalCommand(h.ctx, { rawInput: 'off', agent: h.agent }, h.readLiveConfig)
  assert.equal(off.kind, 'success')
  assert.equal(h.getGoal().phase, 'paused')

  const on = executeGoalCommand(h.ctx, { rawInput: 'on', agent: h.agent }, h.readLiveConfig)
  assert.equal(on.kind, 'success')
  assert.equal(h.getGoal().phase, 'active')
  assert.equal(h.getGoal().activation, 'armed')

  const current = h.getGoal()
  const edit = executeGoalCommand(h.ctx, { rawInput: 'edit Updated objective', agent: h.agent }, h.readLiveConfig)
  assert.equal(edit.kind, 'success')
  assert.equal(h.getGoal().objective, 'Updated objective')
  assert.equal(h.getGoal().revision, current.revision + 1)
  const pause = executeGoalCommand(h.ctx, { rawInput: 'pause', agent: h.agent }, h.readLiveConfig)
  assert.equal(pause.kind, 'success')
  assert.equal(h.getGoal().phase, 'paused')
})

test('executeGoalAction rejects a stale ref even without the tool wrapper', async (t) => {
  const h = await createHarness(config('agent'))
  t.after(() => h.close())

  const created = executeGoalAction(h.ctx, h.agent, {
    action: 'create',
    objective: 'Shared action',
  }, h.readLiveConfig())
  assert.equal(created.goal.phase, 'active')

  const edited = executeGoalAction(h.ctx, h.agent, goalArgs(created.goal, 'edit', {
    objective: 'Edited objective',
  }), h.readLiveConfig())
  assert.equal(edited.goal.revision, created.goal.revision + 1)

  assert.throws(
    () => executeGoalAction(h.ctx, h.agent, goalArgs(created.goal, 'pause'), h.readLiveConfig()),
    (error) => error.code === 'GOAL_STALE_REF',
  )
  assert.equal(h.getGoal().phase, 'active')
  assert.equal(h.getGoal().objective, 'Edited objective')
})

test('resume preflights native transitions before writing a cap edit', async (t) => {
  // A paused goal with one admitted round and cap 5 must not rewrite its cap
  // to 1 (revision + 1) before discovering that resume is exhausted.
  const exhaustedHarness = await createHarness(config('agent'))
  t.after(() => exhaustedHarness.close())
  const exhaustedTool = exhaustedHarness.makeTool()
  const exhaustedCreated = await exhaustedHarness.invoke(exhaustedTool, {
    action: 'create',
    objective: 'Resume with a stale lower cap',
    max_goal_rounds: 5,
  })
  admitGoalRound(exhaustedHarness, exhaustedCreated.goal)
  const exhaustedPaused = await exhaustedHarness.invoke(
    exhaustedTool,
    goalArgs(exhaustedCreated.goal, 'pause'),
  )
  assert.equal(exhaustedPaused.goal.roundsStarted, 1)
  assert.equal(exhaustedPaused.goal.maxGoalRounds, 5)
  const exhaustedEvents = exhaustedHarness.session.snapshotEvents().length
  await assert.rejects(
    () => exhaustedHarness.invoke(
      exhaustedTool,
      goalArgs(exhaustedPaused.goal, 'resume', { max_goal_rounds: 1 }),
    ),
    (error) => error.code === 'GOAL_INVALID_TRANSITION' && /exhausted 1 goal rounds/.test(error.message),
  )
  assert.equal(exhaustedHarness.session.snapshotEvents().length, exhaustedEvents)
  assert.deepEqual(exhaustedHarness.getGoal(), exhaustedPaused.goal)

  // An active and armed goal must not lower its cap before resume reports that
  // it is already armed.
  const armedHarness = await createHarness(config('agent'))
  t.after(() => armedHarness.close())
  const armedTool = armedHarness.makeTool()
  const armedCreated = await armedHarness.invoke(armedTool, {
    action: 'create',
    objective: 'Already armed',
    max_goal_rounds: 5,
  })
  const armedEvents = armedHarness.session.snapshotEvents().length
  await assert.rejects(
    () => armedHarness.invoke(armedTool, goalArgs(armedCreated.goal, 'resume', { max_goal_rounds: 9 })),
    (error) => error.code === 'GOAL_INVALID_TRANSITION' && /already active and armed/.test(error.message),
  )
  assert.equal(armedHarness.session.snapshotEvents().length, armedEvents)
  assert.deepEqual(armedHarness.getGoal(), armedCreated.goal)

  // A completed goal must not be edited in place before resume reports the
  // invalid phase transition.
  const completeHarness = await createHarness(config('agent'))
  t.after(() => completeHarness.close())
  const completeTool = completeHarness.makeTool()
  const completeCreated = await completeHarness.invoke(completeTool, {
    action: 'create',
    objective: 'Already complete',
    max_goal_rounds: 5,
  })
  const completed = await completeHarness.invoke(completeTool, goalArgs(completeCreated.goal, 'complete'))
  const completeEvents = completeHarness.session.snapshotEvents().length
  await assert.rejects(
    () => completeHarness.invoke(completeTool, goalArgs(completed.goal, 'resume', { max_goal_rounds: 9 })),
    (error) => error.code === 'GOAL_INVALID_TRANSITION' && /cannot resume goal .* from phase "complete"/.test(error.message),
  )
  assert.equal(completeHarness.session.snapshotEvents().length, completeEvents)
  assert.deepEqual(completeHarness.getGoal(), completed.goal)

  // A valid resume still applies the supplied cap and arms the goal.
  const resumeHarness = await createHarness(config('agent'))
  t.after(() => resumeHarness.close())
  const resumeTool = resumeHarness.makeTool()
  const resumeCreated = await resumeHarness.invoke(resumeTool, {
    action: 'create',
    objective: 'Valid raised cap',
    max_goal_rounds: 5,
  })
  admitGoalRound(resumeHarness, resumeCreated.goal)
  const resumePaused = await resumeHarness.invoke(resumeTool, goalArgs(resumeCreated.goal, 'pause'))
  const resumed = await resumeHarness.invoke(
    resumeTool,
    goalArgs(resumePaused.goal, 'resume', { max_goal_rounds: 9 }),
  )
  assert.equal(resumed.goal.phase, 'active')
  assert.equal(resumed.goal.activation, 'armed')
  assert.equal(resumed.goal.maxGoalRounds, 9)
  assert.equal(resumed.goal.roundsStarted, 1)
  assert.equal(resumed.goal.revision, resumePaused.goal.revision + 2)

  // Fixed and unlimited settings keep overriding a stale supplied cap during
  // resume, including in the preflight budget check.
  const fixedHarness = await createHarness(config('agent'))
  t.after(() => fixedHarness.close())
  const fixedTool = fixedHarness.makeTool()
  const fixedCreated = await fixedHarness.invoke(fixedTool, {
    action: 'create',
    objective: 'Fixed resume override',
    max_goal_rounds: 5,
  })
  admitGoalRound(fixedHarness, fixedCreated.goal)
  const fixedPaused = await fixedHarness.invoke(fixedTool, goalArgs(fixedCreated.goal, 'pause'))
  fixedHarness.setConfig({ roundLimitMode: 'fixed', roundLimit: 9 })
  const fixedResumed = await fixedHarness.invoke(
    fixedTool,
    goalArgs(fixedPaused.goal, 'resume', { max_goal_rounds: 1 }),
  )
  assert.equal(fixedResumed.goal.phase, 'active')
  assert.equal(fixedResumed.goal.maxGoalRounds, 9)

  const unlimitedHarness = await createHarness(config('agent'))
  t.after(() => unlimitedHarness.close())
  const unlimitedTool = unlimitedHarness.makeTool()
  const unlimitedCreated = await unlimitedHarness.invoke(unlimitedTool, {
    action: 'create',
    objective: 'Unlimited resume override',
    max_goal_rounds: 5,
  })
  admitGoalRound(unlimitedHarness, unlimitedCreated.goal)
  const unlimitedPaused = await unlimitedHarness.invoke(unlimitedTool, goalArgs(unlimitedCreated.goal, 'pause'))
  unlimitedHarness.setConfig({ roundLimitMode: 'unlimited' })
  const unlimitedResumed = await unlimitedHarness.invoke(
    unlimitedTool,
    goalArgs(unlimitedPaused.goal, 'resume', { max_goal_rounds: 1 }),
  )
  assert.equal(unlimitedResumed.goal.phase, 'active')
  assert.equal(unlimitedResumed.goal.maxGoalRounds, UNLIMITED_ROUNDS)
})

test('human /goal edit replaces a completed goal while the tool edit stays in place', async (t) => {
  const h = await createHarness(config('agent'))
  t.after(() => h.close())
  const tool = h.makeTool()

  const created = await h.invoke(tool, {
    action: 'create',
    objective: 'Ship v1',
    max_goal_rounds: 5,
  })
  const completed = await h.invoke(tool, goalArgs(created.goal, 'complete'))

  const attachments = [{ type: 'text', text: 'Attached acceptance notes' }]
  const command = executeGoalCommand(h.ctx, {
    rawInput: 'edit Ship v2',
    agent: h.agent,
    attachments,
  }, h.readLiveConfig)
  assert.equal(command.kind, 'success')

  const replacement = h.getGoal()
  assert.notEqual(replacement.id, completed.goal.id)
  assert.equal(replacement.objective, 'Ship v2')
  assert.equal(replacement.phase, 'active')
  assert.equal(replacement.activation, 'armed')
  assert.equal(replacement.revision, 1)
  assert.equal(replacement.roundsStarted, 0)
  assert.equal(replacement.maxGoalRounds, UNLIMITED_ROUNDS)
  assert.equal(h.followups.length, 1)
  assert.equal(h.followups[0].source.kind, 'user')
  assert.deepEqual(h.followups[0].content[0], attachments[0])
  assert.equal(h.followups[0].content.at(-1).text, 'Reference attachments for the goal objective.')

  // The model-facing tool keeps ordinary edit semantics on a complete goal.
  const completedReplacement = await h.invoke(tool, goalArgs(replacement, 'complete'))
  const edited = await h.invoke(tool, goalArgs(completedReplacement.goal, 'edit', {
    objective: 'In-place complete edit',
  }))
  assert.equal(edited.goal.id, replacement.id)
  assert.equal(edited.goal.phase, 'complete')
  assert.equal(edited.goal.objective, 'In-place complete edit')
  assert.equal(edited.goal.revision, completedReplacement.goal.revision + 1)
})

test('model tool ignores strict-schema empty filler on optional fields', async (t) => {
  const h = await createHarness(config('agent'))
  t.after(() => h.close())
  const tool = h.makeTool()
  const filler = { objective: '', reason: '', max_goal_rounds: 0 }

  const created = await h.invoke(tool, {
    action: 'create',
    objective: 'Strict filler lifecycle',
    max_goal_rounds: 5,
  })
  const got = await h.invoke(tool, { action: 'get', ...filler })
  assert.equal(got.goal.id, created.goal.id)
  assert.equal(got.goal.revision, created.goal.revision)

  const paused = await h.invoke(tool, { ...goalArgs(created.goal, 'pause'), ...filler })
  assert.equal(paused.goal.phase, 'paused')
  assert.equal(paused.goal.maxGoalRounds, 5)

  const resumed = await h.invoke(tool, { ...goalArgs(paused.goal, 'resume'), ...filler })
  assert.equal(resumed.goal.phase, 'active')
  assert.equal(resumed.goal.activation, 'armed')
  assert.equal(resumed.goal.maxGoalRounds, 5)
  assert.equal(resumed.goal.revision, paused.goal.revision + 1)

  const completed = await h.invoke(tool, { ...goalArgs(resumed.goal, 'complete'), ...filler })
  assert.equal(completed.goal.phase, 'complete')

  const cleared = await h.invoke(tool, { ...goalArgs(completed.goal, 'clear'), ...filler })
  assert.deepEqual(cleared, { goal: null })

  // Empty required values are still missing after normalization.
  await assert.rejects(
    () => h.invoke(tool, { action: 'create', objective: '', reason: '', max_goal_rounds: 0 }),
    (error) => error.code === 'GOAL_INVALID_ACTION' && error.message === 'create requires a non-empty objective',
  )

  const target = await h.invoke(tool, {
    action: 'create',
    objective: 'Strict filler validation target',
    max_goal_rounds: 5,
  })
  await assert.rejects(
    () => h.invoke(tool, { ...goalArgs(target.goal, 'fail'), objective: '', reason: '', max_goal_rounds: 0 }),
    (error) => error.code === 'GOAL_INVALID_ACTION' && error.message === 'fail requires a concrete reason',
  )

  // Meaningful values are not filler: irrelevant non-empty fields still fail.
  await assert.rejects(
    () => h.invoke(tool, { ...goalArgs(target.goal, 'pause'), objective: 'not allowed' }),
    (error) => error.code === 'GOAL_INVALID_ACTION' && /objective is only valid/.test(error.message),
  )
  await assert.rejects(
    () => h.invoke(tool, { ...goalArgs(target.goal, 'complete'), reason: 'not allowed' }),
    (error) => error.code === 'GOAL_INVALID_ACTION' && /reason is only valid/.test(error.message),
  )
  await assert.rejects(
    () => h.invoke(tool, { ...goalArgs(target.goal, 'complete'), max_goal_rounds: 20 }),
    (error) => error.code === 'GOAL_INVALID_ACTION' && /max_goal_rounds is only valid/.test(error.message),
  )

  // Negative and fractional caps stay invalid.
  await assert.rejects(
    () => h.invoke(tool, { ...goalArgs(target.goal, 'resume'), max_goal_rounds: -1 }),
    (error) => error.name === 'TypeError',
  )
  await assert.rejects(
    () => h.invoke(tool, { ...goalArgs(target.goal, 'resume'), max_goal_rounds: 1.5 }),
    (error) => error.code === 'INVALID_ARGS',
  )

  // A valid fail still works with the same filler around its concrete reason.
  const failed = await h.invoke(tool, {
    ...goalArgs(target.goal, 'fail'),
    objective: '',
    reason: 'A concrete blocker',
    max_goal_rounds: 0,
  })
  assert.equal(failed.goal.phase, 'blocked')
  assert.deepEqual(failed.goal.blockedReason, { code: 'model-reported', message: 'A concrete blocker' })

  // Exact reported shape: resume with empty-string filler plus a real cap.
  const resumedWithCap = await h.invoke(tool, {
    ...goalArgs(failed.goal, 'resume'),
    objective: '',
    reason: '',
    max_goal_rounds: 20,
  })
  assert.equal(resumedWithCap.goal.phase, 'active')
  assert.equal(resumedWithCap.goal.activation, 'armed')
  assert.equal(resumedWithCap.goal.maxGoalRounds, 20)
})

test('strict zero round cap follows the host cap policy', async (t) => {
  const agentHarness = await createHarness(config('agent'))
  t.after(() => agentHarness.close())
  const agentTool = agentHarness.makeTool()

  const five = await agentHarness.invoke(agentTool, {
    action: 'create',
    objective: 'Zero cap edit target',
    max_goal_rounds: 5,
  })
  const edited = await agentHarness.invoke(agentTool, {
    ...goalArgs(five.goal, 'edit'),
    objective: 'Zero cap edit target updated',
    max_goal_rounds: 0,
  })
  assert.equal(edited.goal.objective, 'Zero cap edit target updated')
  assert.equal(edited.goal.maxGoalRounds, 5)
  assert.equal(edited.goal.revision, five.goal.revision + 1)

  await agentHarness.invoke(agentTool, goalArgs(edited.goal, 'clear'))
  const sentinel = await agentHarness.invoke(agentTool, {
    action: 'create',
    objective: 'Zero cap create',
    max_goal_rounds: 0,
  })
  assert.equal(sentinel.goal.maxGoalRounds, UNLIMITED_ROUNDS)

  const fixedHarness = await createHarness(config('fixed', 7))
  t.after(() => fixedHarness.close())
  const fixedTool = fixedHarness.makeTool()
  const fixedCreated = await fixedHarness.invoke(fixedTool, {
    action: 'create',
    objective: 'Zero cap fixed create',
    max_goal_rounds: 0,
  })
  assert.equal(fixedCreated.goal.maxGoalRounds, 7)

  fixedHarness.setConfig({ roundLimit: 9 })
  const fixedEdited = await fixedHarness.invoke(fixedTool, {
    ...goalArgs(fixedCreated.goal, 'edit'),
    objective: 'Zero cap fixed edit',
    max_goal_rounds: 0,
  })
  assert.equal(fixedEdited.goal.maxGoalRounds, 9)
})
