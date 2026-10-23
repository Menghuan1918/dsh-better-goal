import assert from 'node:assert/strict'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { ToolArgsError, assertSupportedJsonSchema, defineTool, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import {
  TIMED_WAIT_PARAMETER,
  UserQuestionError,
  UserQuestionService,
  isTimedAskUserQuestionSchema,
} from '@deepseek-ai/dsh-user-questions'

import {
  createGoalAskTool,
  DEFAULT_QUESTION_TIMEOUT_SECONDS,
  MAX_QUESTION_TIMEOUT_SECONDS,
  PENDING_QUESTION_NOTICE,
} from '../src/ask-user.js'

const QUESTION = Object.freeze({
  id: 'mode',
  question: 'Which mode should I use?',
  header: 'Choose Mode',
  options: [
    { label: 'Fast', description: 'Start immediately.' },
    { label: 'Safe' },
  ],
  multi_select: true,
})

function createBaseDefinition() {
  return defineTool({
    name: 'ask_user_question',
    description: 'Ask the user a concise question before proceeding.',
    parameters: {
      questions: {
        type: 'array',
        required: true,
        description: 'Questions to ask the user.',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string', required: true },
            question: { type: 'string', required: true },
            header: { type: 'string' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  label: { type: 'string', required: true },
                  description: { type: 'string' },
                },
              },
            },
            multi_select: { type: 'boolean' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                selected: { type: 'array', required: true, items: { type: 'string' } },
                custom: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async () => ({ answers: [] }),
  })
}

function fakeUserQuestions({ timed, answer } = {}) {
  const calls = { timed: [], ask: [] }
  return {
    calls,
    service: {
      async askTimed(request, callId, timeoutMs) {
        calls.timed.push({ request, callId, timeoutMs })
        if (typeof timed === 'function') return timed(request, callId, timeoutMs)
        return timed ?? { answers: [{ id: 'mode', selected: ['Fast'] }] }
      },
      async ask(request) {
        calls.ask.push(request)
        if (typeof answer === 'function') return answer(request)
        return answer ?? { answers: [{ id: 'mode', selected: ['Safe'] }] }
      },
    },
  }
}

function fakeCtx(service, goal = { phase: 'active', activation: 'armed' }) {
  return {
    get(name) {
      if (name === 'userQuestions') return service
      if (name === 'goals') return { get: () => goal }
      return undefined
    },
  }
}

function makeExec(overrides = {}) {
  const controller = overrides.controller ?? new AbortController()
  return {
    callId: 'call-1',
    agent: { id: 'agent-1', session: {}, status: 'running' },
    signal: controller.signal,
    ...overrides,
  }
}

test('builds a native timed shadow from the currently registered questions schema', () => {
  const base = createBaseDefinition()
  const baseParameters = structuredClone(base.parameters)
  const tool = createGoalAskTool(fakeCtx(fakeUserQuestions().service), base, () => ({ questionTimeoutSeconds: 120 }))

  assert.equal(tool.name, 'ask_user_question')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.properties.questions, baseParameters.properties.questions)
  assert.ok(tool.parameters.properties[TIMED_WAIT_PARAMETER])
  assert.equal(tool.parameters.properties[TIMED_WAIT_PARAMETER].type, 'integer')
  assert.ok(!(tool.parameters.required ?? []).includes(TIMED_WAIT_PARAMETER))
  assert.equal(isTimedAskUserQuestionSchema({ name: tool.name, parameters: tool.parameters }), true)
  assert.equal(isTimedAskUserQuestionSchema({ name: base.name, parameters: base.parameters }), false)
  assert.deepEqual(base.parameters, baseParameters)
  assert.equal(typeof tool.output.render, 'function')
  assert.equal(typeof tool.execute, 'function')
  assert.doesNotThrow(() => assertSupportedJsonSchema(tool.parameters))
  assert.doesNotThrow(() => assertSupportedJsonSchema(tool.output.schema))
  assert.equal(DEFAULT_QUESTION_TIMEOUT_SECONDS, 120)
  assert.equal(MAX_QUESTION_TIMEOUT_SECONDS, 2147483)

  assert.throws(
    () => createGoalAskTool(fakeCtx(undefined), undefined, () => ({})),
    /existing ask_user_question definition/,
  )
  assert.throws(
    () => createGoalAskTool(fakeCtx(undefined), { name: 'other', parameters: { properties: { questions: {} } } }, () => ({})),
    /existing ask_user_question definition/,
  )
  assert.throws(
    () => createGoalAskTool(fakeCtx(undefined), { name: 'ask_user_question', parameters: { properties: {} } }, () => ({})),
    /questions parameter/,
  )
})

test('stable timed schema delegates non-goal questions without changing their behavior', async () => {
  for (const goal of [null, { phase: 'active', activation: 'disarmed' }, { phase: 'paused', activation: 'disarmed' }]) {
    const fake = fakeUserQuestions()
    const base = createBaseDefinition()
    let delegated
    base.execute = async (args, exec) => { delegated = { args, exec }; return { answers: [{ id: 'mode', selected: ['Safe'] }] } }
    const tool = createGoalAskTool(fakeCtx(fake.service, goal), base, () => ({ questionTimeoutSeconds: 1 }))
    const exec = makeExec()
    assert.equal(isTimedAskUserQuestionSchema(tool), true)
    assert.deepEqual(await tool.execute({ questions: [QUESTION], timeout: -1 }, exec), { answers: [{ id: 'mode', selected: ['Safe'] }] })
    assert.deepEqual(delegated.args, { questions: [QUESTION] })
    assert.equal(delegated.exec, exec)
    assert.equal(fake.calls.timed.length, 0)
    assert.equal(fake.calls.ask.length, 0)
  }
})

test('uses host timeout default, configured timeout, and -1 forever while mapping multi_select', async () => {
  const base = createBaseDefinition()

  const defaultFake = fakeUserQuestions()
  const defaultTool = createGoalAskTool(fakeCtx(defaultFake.service), base, () => ({}))
  const defaultExec = makeExec()
  const defaultResult = await defaultTool.execute(
    { questions: [QUESTION] },
    defaultExec,
  )
  assert.deepEqual(defaultResult, { answers: [{ id: 'mode', selected: ['Fast'] }] })
  assert.equal(defaultFake.calls.timed.length, 1)
  assert.equal(defaultFake.calls.timed[0].timeoutMs, DEFAULT_QUESTION_TIMEOUT_SECONDS * 1000)
  assert.equal(defaultFake.calls.timed[0].callId, 'call-1')
  assert.equal(defaultFake.calls.timed[0].request.agent, defaultExec.agent)
  assert.equal(defaultFake.calls.timed[0].request.signal, defaultExec.signal)
  assert.deepEqual(defaultFake.calls.timed[0].request.questions, [{
    id: 'mode',
    question: 'Which mode should I use?',
    header: 'Choose Mode',
    options: [
      { label: 'Fast', description: 'Start immediately.' },
      { label: 'Safe' },
    ],
    multiSelect: true,
  }])

  const configuredFake = fakeUserQuestions()
  const configuredTool = createGoalAskTool(fakeCtx(configuredFake.service), base, () => ({ questionTimeoutSeconds: 5 }))
  await configuredTool.execute({ questions: [QUESTION] }, makeExec())
  assert.equal(configuredFake.calls.timed[0].timeoutMs, 5000)

  const foreverFake = fakeUserQuestions()
  const foreverTool = createGoalAskTool(fakeCtx(foreverFake.service), base, () => ({ questionTimeoutSeconds: -1 }))
  const foreverExec = makeExec()
  const foreverResult = await foreverTool.execute({ questions: [QUESTION] }, foreverExec)
  assert.deepEqual(foreverResult, { answers: [{ id: 'mode', selected: ['Safe'] }] })
  assert.equal(foreverFake.calls.timed.length, 0)
  assert.equal(foreverFake.calls.ask.length, 1)
  assert.deepEqual(foreverFake.calls.ask[0].wait, { callId: 'call-1' })
  assert.equal(foreverFake.calls.ask[0].agent, foreverExec.agent)
  assert.equal(foreverFake.calls.ask[0].signal, foreverExec.signal)
  assert.equal(foreverFake.calls.ask[0].questions[0].multiSelect, true)
})

test('reads the timeout once per new call and never changes an already running wait', async () => {
  let config = { questionTimeoutSeconds: 120 }
  let resolveTimed
  const calls = []
  const service = {
    askTimed(request, callId, timeoutMs) {
      calls.push({ request, callId, timeoutMs })
      return new Promise((resolve) => { resolveTimed = resolve })
    },
    async ask() {
      throw new Error('unexpected indefinite ask')
    },
  }
  const tool = createGoalAskTool(fakeCtx(service), createBaseDefinition(), () => config)

  const running = tool.execute({ questions: [QUESTION], timeout: 1 }, makeExec())
  assert.equal(calls.length, 1)
  assert.equal(typeof resolveTimed, 'function')
  assert.equal(calls[0].timeoutMs, 120000)

  config = { questionTimeoutSeconds: -1 }
  resolveTimed({ answers: [{ id: 'mode', selected: ['Fast'] }] })
  assert.deepEqual(await running, { answers: [{ id: 'mode', selected: ['Fast'] }] })
  assert.equal(calls[0].timeoutMs, 120000)

  const nextFake = fakeUserQuestions()
  const nextTool = createGoalAskTool(fakeCtx(nextFake.service), createBaseDefinition(), () => config)
  await nextTool.execute({ questions: [QUESTION], timeout: 1 }, makeExec())
  assert.equal(nextFake.calls.timed.length, 0)
  assert.equal(nextFake.calls.ask.length, 1)
})

test('ignores a model-supplied timeout and rejects duplicate or malformed questions before asking', async () => {
  const fake = fakeUserQuestions()
  const tool = createGoalAskTool(fakeCtx(fake.service), createBaseDefinition(), () => ({ questionTimeoutSeconds: 120 }))
  const exec = makeExec()

  await tool.execute({ questions: [QUESTION], timeout: -1 }, exec)
  assert.equal(fake.calls.timed[0].timeoutMs, 120000)
  await tool.execute({ questions: [QUESTION], timeout: 999999 }, exec)
  assert.equal(fake.calls.timed[1].timeoutMs, 120000)

  const before = fake.calls.timed.length
  await assert.rejects(
    tool.execute({ questions: [{ ...QUESTION }, { ...QUESTION }] }, exec),
    /must be unique within this call/,
  )
  assert.equal(fake.calls.timed.length, before)

  await assert.rejects(
    tool.execute({ questions: 'not-an-array' }, exec),
    (error) => error instanceof ToolArgsError,
  )
  await assert.rejects(
    tool.execute({}, exec),
    (error) => error instanceof ToolArgsError,
  )

  const invalidTimeout = createGoalAskTool(fakeCtx(fake.service), createBaseDefinition(), () => ({ questionTimeoutSeconds: 0 }))
  await assert.rejects(
    invalidTimeout.execute({ questions: [QUESTION] }, exec),
    /questionTimeoutSeconds must be -1 or a positive integer/,
  )
})

test('returns the native pending JSON with a non-authorization notice and validates both output branches', async () => {
  const fake = fakeUserQuestions({ timed: { pending: true, callId: 'call-1' } })
  const tool = createGoalAskTool(fakeCtx(fake.service), createBaseDefinition(), () => ({ questionTimeoutSeconds: 120 }))

  const pending = await tool.execute({ questions: [QUESTION] }, makeExec())
  assert.deepEqual(pending, {
    pending: true,
    callId: 'call-1',
    message: PENDING_QUESTION_NOTICE,
  })
  assert.match(pending.message, /Do not treat this as permission\./)
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, pending, ''), [])
  const rendered = tool.output.render({}, pending)
  assert.deepEqual(JSON.parse(rendered[0].text), pending)

  const answer = { answers: [{ id: 'mode', selected: ['Fast'], custom: 'custom text' }] }
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, answer, ''), [])
})

async function makeRealQuestionService(agent) {
  const ctx = new Context()
  const agents = new Map([[agent.id, agent]])
  ctx.provide('agents', {
    get: (id) => agents.get(id),
    roots: () => [...agents.values()],
    currentInitiator: () => undefined,
  })
  const fork = ctx.plugin(UserQuestionService)
  await fork
  return { ctx, fork, service: ctx.userQuestions }
}

test('uses the original user-questions service abort behavior', async (t) => {
  const agent = { id: 'agent-1', session: {} }
  const real = await makeRealQuestionService(agent)
  t.after(async () => { await real.fork.dispose() })

  for (const questionTimeoutSeconds of [120, -1]) {
    const controller = new AbortController()
    controller.abort(new Error('cancelled by test'))
    const tool = createGoalAskTool(
      fakeCtx(real.service),
      createBaseDefinition(),
      () => ({ questionTimeoutSeconds }),
    )
    await assert.rejects(
      tool.execute(
        { questions: [QUESTION] },
        { callId: `call-abort-${questionTimeoutSeconds}`, agent, signal: controller.signal },
      ),
      (error) => error instanceof UserQuestionError && error.code === 'ASK_ABORTED',
    )
  }
})

async function makeProjectionHarness() {
  const ctx = new Context()
  const agent = {
    id: 'agent-late',
    session: undefined,
    inbox: { nextTurn: [], nextStep: [] },
    steered: [],
    steer(message) { this.steered.push(message) },
  }
  ctx.provide('agents', {
    get: (id) => (id === agent.id ? agent : undefined),
    roots: () => [agent],
    currentInitiator: () => undefined,
  })
  const storeFork = ctx.plugin(SessionStore)
  const projectionFork = ctx.plugin(SessionProjectionRegistry)
  await Promise.all([storeFork, projectionFork])
  const questionFork = ctx.plugin(UserQuestionService)
  await questionFork
  const session = ctx.sessions.create('session-ask-late', { meta: { cwd: '/tmp' } })
  agent.session = session
  return {
    ctx,
    agent,
    session,
    service: ctx.userQuestions,
    async close() {
      for (const fork of [questionFork, storeFork, projectionFork]) {
        try { await fork.dispose() } catch {}
      }
    },
  }
}

test('pending result stays answerable and the original service settles a late answer', async (t) => {
  const h = await makeProjectionHarness()
  t.after(() => h.close())

  const fake = fakeUserQuestions({ timed: { pending: true, callId: 'call-late' } })
  const tool = createGoalAskTool(fakeCtx(fake.service), createBaseDefinition(), () => ({ questionTimeoutSeconds: 120 }))
  const pending = await tool.execute({ questions: [QUESTION] }, {
    callId: 'call-late',
    agent: h.agent,
    signal: new AbortController().signal,
  })

  assert.equal(isTimedAskUserQuestionSchema({ name: tool.name, parameters: tool.parameters }), true)
  h.session.append('request/header', {
    header: {
      config: { provider: 'test-provider', model: 'test-model' },
      tools: [{ name: tool.name, description: tool.description, parameters: tool.parameters }],
    },
    reason: 'initial',
  })
  h.session.append('tool/call', {
    callId: 'call-late',
    name: 'ask_user_question',
    arguments: JSON.stringify({ questions: [QUESTION] }),
  })
  h.session.append('tool/result', {
    message: createToolResultMessage({
      callId: 'call-late',
      content: [{ type: 'text', text: JSON.stringify(pending) }],
      isError: false,
    }),
  }, { surfaceOp: 'append' })

  const before = h.ctx.sessionProjections.stateOf(h.session, 'userQuestions')
  assert.equal(before.questions.active.length, 1)
  assert.equal(before.questions.active[0].callId, 'call-late')
  assert.equal(before.questions.active[0].state, 'continued')
  assert.deepEqual(before.questions.active[0].questions, [{
    id: 'mode',
    question: 'Which mode should I use?',
    header: 'Choose Mode',
    options: [
      { label: 'Fast', description: 'Start immediately.' },
      { label: 'Safe' },
    ],
    multiSelect: true,
  }])
  assert.deepEqual(before.questions.settled, [])

  const answers = [{ id: 'mode', selected: ['Fast'] }]
  assert.equal(h.service.answer(h.agent, 'call-late', { answers }), true)
  assert.equal(h.agent.steered.length, 1)
  assert.equal(h.agent.steered[0].source.kind, 'user-question-reply')
  assert.equal(h.agent.steered[0].source.callId, 'call-late')
  assert.equal(h.agent.steered[0].source.outcome, 'answered')

  h.session.append('user/message', h.agent.steered[0], { surfaceOp: 'append' })
  const after = h.ctx.sessionProjections.stateOf(h.session, 'userQuestions')
  assert.deepEqual(after.questions.active, [])
  assert.deepEqual(after.questions.settled, [{
    callId: 'call-late',
    answers,
  }])
})

test('publishes the native timed description while preserving the base schema', () => {
  const fake = fakeUserQuestions()
  const ctx = fakeCtx(fake.service)
  const base = createBaseDefinition()
  const tool = createGoalAskTool(ctx, base, () => ({ questionTimeoutSeconds: 120 }))
  assert.notEqual(tool.description, base.description)
  assert.match(tool.description, /pending/)
  assert.match(tool.description, /host controls the wait duration/)
})
