import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, cp, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dsh = process.env.DSH_PACKAGE_ROOT
if (!dsh) throw new Error('Set DSH_PACKAGE_ROOT to the installed @deepseek-ai/dsh package')
const mode = process.env.GOAL_SMOKE_MODE ?? 'standalone'
const hot = process.env.GOAL_SMOKE_HOT === '1'
assert.ok(['standalone', 'apollo', 'both'].includes(mode))
const home = await mkdtemp(join(tmpdir(), 'dsh-better-goal-smoke-'))
process.env.DSH_HOME = home
process.env.DSH_TELEMETRY_DISABLED = '1'
const A = await import(pathToFileURL(join(dirname(dsh), 'dsh-app-boot/lib/index.js')))
const { symbols } = await import(pathToFileURL(join(dirname(dsh), 'cordis/lib/index.js')))
const dir = A.resolveProfileDir('it', home)
const bundles = [...A.PROFILE_TEMPLATES.headless.bundles, ...(mode === 'standalone' ? ['dsh-better-goal'] : mode === 'apollo' ? ['dsh-apollo'] : ['dsh-apollo', 'dsh-better-goal'])]
A.initProfile(dir, bundles)
const packageFile = join(dir, 'package.json')
const manifest = JSON.parse(await readFile(packageFile, 'utf8'))
const modules = join(dir, 'node_modules')
await mkdir(modules, { recursive: true })
// Exercise a published layout: copy only shipped files, with peers resolved
// from the same runtime used by the host. No copied node_modules or .git.
const plugin = join(modules, 'dsh-better-goal')
await mkdir(plugin)
for (const name of ['package.json', 'src', 'docs', 'cordis.patch.yml', 'LICENSE', 'README.md', 'third-party']) {
  await cp(join(root, name), join(plugin, name), { recursive: true })
}
await symlink(dirname(dsh), join(modules, '@deepseek-ai'))
await symlink(join(root, 'node_modules/zod'), join(modules, 'zod'))
await symlink(join(root, 'node_modules/react'), join(modules, 'react'))
manifest.dependencies['dsh-better-goal'] = `file:${plugin}`
if (mode !== 'standalone') {
  const apolloRoot = resolve(process.env.APOLLO_PACKAGE_ROOT ?? join(root, '../dsh-apollo'))
  const apollo = join(modules, 'dsh-apollo')
  await mkdir(apollo)
  for (const name of ['package.json', 'src', 'docs', 'skills', 'presets', 'cordis.patch.yml', 'README.md', 'LICENSE', 'third-party']) await cp(join(apolloRoot, name), join(apollo, name), { recursive: true })
  manifest.dependencies['dsh-apollo'] = `file:${apollo}`
  // Transitive-only dependency path: a selected Apollo bundle discovers this
  // package through its dependency closure, not through selected goal bundles.
  if (mode === 'apollo') delete manifest.dependencies['dsh-better-goal']
}
await writeFile(packageFile, JSON.stringify(manifest, null, 2))
const preset = mode === 'standalone' ? 'standard' : 'eng'
await writeFile(join(dir, 'cordis.patch.yml'), JSON.stringify([
  ...(mode === 'standalone' ? A.loadOverlayPatches('better-goal-smoke', join(dirname(dsh), 'dsh-web-app/presets/standard.patch.yml')) : []),
  { id: 'headless-startup', disabled: true }, { id: 'headless-runner', disabled: true },
  { id: 'credentials', disabled: false, config: { watch: false } },
  { insert: [
    { id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: preset } },
    { id: 'subagent-model-selection-settings', name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings', config: { enabled: true, allowedModels: [{ provider: 'it-noop', model: 'noop' }] } },
    { id: 'workspace', name: '@deepseek-ai/dsh-workspace' },
    { id: 'connection', name: '@deepseek-ai/dsh-client-connection' },
    { id: 'file-upload', name: '@deepseek-ai/dsh-client-file-upload' },
    { id: 'file-reference-local', name: '@deepseek-ai/dsh-file-reference-local' },
    { id: 'session-controller', name: '@deepseek-ai/dsh-api-session-controller' },
    { id: 'schedule', name: '@deepseek-ai/dsh-schedule' },
  ] },
]))
const { runProfile } = await import(pathToFileURL(join(dsh, 'lib/profile-boot.js')))
let ctx
try {
  const booted = await runProfile({ profile: 'it', patchFiles: [], args: [], environment: A.loadLayeredEnv('dsh') })
  ctx = booted.ctx
  let scripted = []
  let askCallId
  const adapter = {
    providerInfo: (id) => ({ id, name: 'Goal integration scripted adapter' }), providerRetryPolicy: () => undefined, imageRequestPricing: () => undefined,
    listModels: async () => [{ provider: 'it-noop', id: 'noop', name: 'Noop', inputModalities: ['text'] }],
    resolveModel: async (provider, id) => ({ provider, id, name: id, inputModalities: ['text'] }),
    async prepareCall(provider, model) { return { model: await adapter.resolveModel(provider, model), stream: (options) => adapter.stream(options) } },
    async *stream() {
      const step = scripted.shift()
      if (step) {
        const { $tool = 'goal', ...args } = step()
        const block = { type: 'tool-call', id: `it-${randomUUID()}`, name: $tool, arguments: JSON.stringify(args) }
        if ($tool === 'ask_user_question') askCallId = block.id
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Integration response.' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Integration response.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  ctx.llm.registerAdapter(['it-noop'], adapter)
  const setup = async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, preset) }
  const created = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: home, agentPreset: preset }, agentOptions: { provider: 'it-noop', model: 'noop' }, setup })
  const agent = created.agent
  assert.ok(ctx.get('goals'))
  const goalTool = ctx.tools.get('goal', agent)
  assert.ok(goalTool, 'unified tool must be visible')
  assert.deepEqual(goalTool.parameters.properties.action.enum, ['get', 'set', 'fail', 'complete', 'resume'])
  assert.equal('goal_id' in goalTool.parameters.properties, false)
  assert.equal('revision' in goalTool.parameters.properties, false)
  for (const name of ['get_goal', 'create_goal', 'update_goal']) assert.equal(ctx.tools.get(name, agent), undefined, name)
  assert.equal(ctx.commands.find(agent, 'goal')?.definitionId, 'dsh-better-goal')
  const plan = agent.ctx.get('planMode')
  assert.ok(plan, 'native plan mode is available in headless')
  plan.set(agent, true)
  const command = async (line) => {
    const result = await ctx.commands.execute(agent, line, [], new AbortController().signal)
    assert.equal(result?.result.kind, 'success', JSON.stringify(result))
    return result
  }
  await command('/goal Verify the real profile assembly')
  assert.equal(ctx.goals.get(agent).activation, 'armed')
  await command('/goal off')
  assert.equal(ctx.goals.get(agent).phase, 'paused')
  await command('/goal on')
  assert.equal(ctx.goals.get(agent).activation, 'armed')
  await command('/goal complete')
  assert.equal(ctx.goals.get(agent).phase, 'complete')
  await command('/goal clear')
  assert.equal(ctx.goals.get(agent), undefined)
  const peer = { id: 'goal-smoke', ctx, principal: { kind: 'owner' }, signal: new AbortController().signal, interactions: 'answer', dispose: async () => {} }
  const rpc = (method, args) => ctx.get('typertGateway').invoke({ namespace: 'goals', method, args, peer })
  assert.equal(await rpc('get', { agentId: agent.id }), undefined)
  const createdRpc = await rpc('create', { agentId: agent.id, request: { objective: 'Verify native GoalBar RPC', maxGoalRounds: 4 } })
  const pausedRpc = await rpc('pause', { agentId: agent.id, ref: createdRpc.ref })
  const editedRpc = await rpc('edit', { agentId: agent.id, ref: { id: pausedRpc.id, revision: pausedRpc.revision }, request: { objective: 'Updated through the native API' } })
  const resumedRpc = await rpc('resume', { agentId: agent.id, ref: { id: editedRpc.id, revision: editedRpc.revision } })
  const completedRpc = await rpc('complete', { agentId: agent.id, ref: { id: resumedRpc.id, revision: resumedRpc.revision } })
  await rpc('clear', { agentId: agent.id, ref: { id: completedRpc.id, revision: completedRpc.revision } })
  assert.equal(await rpc('get', { agentId: agent.id }), undefined)
  plan.set(agent, false)
  const control = (action, extra = {}) => () => ({ action, ...extra })
  const lifecycle = [
    control('set', { objective: 'Establish the initial integration objective', max_goal_rounds: 2 }),
    control('set', { objective: 'Exercise real automatic goal continuation', max_goal_rounds: 2 }),
    null,
    control('get'), control('fail', { reason: 'Integration blocker at the first goal round' }),
    control('resume'), control('complete'), null,
  ]
  const { createUserMessage } = await import(pathToFileURL(join(dirname(dsh), 'dsh-llm/lib/index.js')))
  const primed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error('Timed out committing native plan mode exit')) }, 15000)
    const off = ctx.on('session/event', (session, event) => {
      if (session.id !== agent.id || event.type !== 'turn/end') return
      clearTimeout(timer); off(); resolve()
    })
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Commit the collaboration mode selection.' }], source: { kind: 'user' } }))
  await primed
  await agent.whenIdle()
  assert.equal(plan.get(agent).active, false)
  scripted = lifecycle
  const complete = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error('Timed out waiting for scripted goal lifecycle')) }, 15000)
    const off = ctx.on('session/event', (session, event) => {
      if (session.id !== agent.id || event.type !== 'turn/end') return
      if (event.data.reason.kind !== 'completed') { clearTimeout(timer); off(); reject(new Error(JSON.stringify(event.data))); return }
      if (ctx.goals.get(agent)?.phase === 'complete') { clearTimeout(timer); off(); resolve() }
    })
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Exercise the goal tool lifecycle.' }], source: { kind: 'user' } }))
  await complete
  await agent.whenIdle()
  assert.equal(scripted.length, 0)
  assert.equal(ctx.goals.get(agent).roundsStarted, 1, 'only one automatic round must be admitted')
  if (hot) {
    console.log('HOT_SETTINGS_BEGIN')
    const settings = ctx.get('settings')
    assert.ok(settings, 'formal settings service is available')
    const row = (await settings.describe()).find((entry) => entry.ns === 'dsh-better-goal')
    assert.ok(row, 'goal row exposes its formal Config')
    console.log('HOT_SETTINGS_DESCRIBED')
    const service = ctx.get('goals')
    await settings.update('dsh-better-goal', { roundLimitMode: 'fixed', roundLimit: 3, questionTimeoutSeconds: 1 }, row.revision)
    assert.equal(ctx.get('goals')[symbols.original], service[symbols.original], 'volatile settings do not remount the goal state service')
    const saved = (await settings.describe()).find((entry) => entry.ns === 'dsh-better-goal')
    assert.equal(saved.value.questionTimeoutSeconds, 1)
    let pending = false, loggedTimed = false, loggedFixed = false, latestTools = []
    const observe = ctx.on('session/event', (session, event) => {
      if (session.id !== agent.id) return
      if (event.type === 'request/header' && event.data.header.tools) latestTools = event.data.header.tools
      if (event.type === 'tool/call') {
        if (event.data.name === 'goal') loggedFixed = !('max_goal_rounds' in latestTools.find((tool) => tool.name === 'goal').parameters.properties)
        if (event.data.name === 'ask_user_question') loggedTimed = 'timeout' in latestTools.find((tool) => tool.name === 'ask_user_question').parameters.properties
      }
      if (event.type !== 'tool/result' || event.data.message.toolCallId !== askCallId) return
      const text = event.data.message.content.find((block) => block.type === 'text')?.text
      try { pending = JSON.parse(text).pending === true } catch {}
    })
    assert.ok(ctx.tools.get('ask_user_question', agent), 'the selected preset provides questions')
    scripted = [
      () => ({ action: 'set', objective: 'Verify hot goal settings and unanswered questions' }),
      () => ({ $tool: 'ask_user_question', timeout: -1, questions: [{ id: 'it-q', question: 'Integration question awaiting a later answer.' }] }),
      control('complete'), null,
    ]
    const finished = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('Timed out waiting for hot-settings question')) }, 15000)
      const off = ctx.on('session/event', (session, event) => {
        if (session.id !== agent.id || event.type !== 'turn/end') return
        clearTimeout(timer); off(); resolve()
      })
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Verify the newly saved goal settings.' }], source: { kind: 'user' } }))
    await finished
    await agent.whenIdle()
    observe()
    assert.equal(scripted.length, 0)
    assert.equal(ctx.goals.get(agent).maxGoalRounds, 3)
    assert.equal(pending, true, 'the new one-second host setting overrides a model request to wait forever')
    assert.equal('max_goal_rounds' in ctx.tools.get('goal', agent).parameters.properties, false)
    assert.equal(loggedFixed, true, 'the first hot-updated request header hides the fixed round parameter')
    assert.equal(loggedTimed, true, 'the first timed call is logged with the stable timed marker')
    const questions = ctx.sessionProjections.stateOf(agent.session, 'userQuestions')
    assert.ok(questions.questions.active.some((question) => question.callId === askCallId && question.state === 'continued'))
    const answered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('Timed out accepting the late answer')) }, 15000)
      const off = ctx.on('session/event', (session, event) => {
        if (session.id !== agent.id || event.type !== 'turn/end') return
        clearTimeout(timer); off(); resolve()
      })
    })
    assert.equal(ctx.get('userQuestions').answer(agent, askCallId, { answers: [{ id: 'it-q', selected: [], custom: 'Late integration answer' }] }), true)
    await answered
    await agent.whenIdle()
    assert.equal(ctx.sessionProjections.stateOf(agent.session, 'userQuestions').questions.active.some((question) => question.callId === askCallId), false)
  }
  ctx.goals.create(agent, { objective: 'Persist an active goal across a cold host restart', maxGoalRounds: 8 })
  ctx.goals.disarm(agent)
  await ctx.sessions.flush(agent.session)
  const persistedId = agent.id
  await ctx.fiber.dispose()
  ctx = undefined
  ctx = (await runProfile({ profile: 'it', patchFiles: [], args: [], environment: A.loadLayeredEnv('dsh') })).ctx
  ctx.llm.registerAdapter(['it-noop'], adapter)
  const restored = (await ctx.agents.resume({ resumeSessionId: persistedId, agentOptions: { provider: 'it-noop', model: 'noop' }, setup })).agent
  assert.equal(ctx.goals.get(restored).phase, 'active')
  assert.equal(ctx.goals.get(restored).activation, 'disarmed')
  assert.equal(restored.status, 'idle')
  const forkValue = await ctx.get('sessionController').fork({ sessionId: restored.id, atSeq: restored.session.seq - 1 })
  const forked = ctx.agents.get(forkValue.sessionId)
  assert.ok(forked, 'Session API fork publishes its live child Agent')
  await forked.whenIdle()
  assert.equal(ctx.goals.get(forked).objective, ctx.goals.get(restored).objective)
  assert.equal(ctx.goals.get(forked).activation, 'disarmed')
  assert.equal(forked.status, 'idle')
  if (mode !== 'standalone') {
    const noask = (await ctx.agents.create({
      sessionId: randomUUID(), meta: { cwd: home, agentPreset: 'eng-noask' },
      agentOptions: { provider: 'it-noop', model: 'noop' },
      setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'eng-noask') },
    })).agent
    assert.ok(ctx.tools.get('goal', noask))
    assert.equal(ctx.tools.get('ask_user_question', noask), undefined, 'goal does not add a missing question tool')
  }
  const result = { passed: true, mode, hotSettings: hot, home, checks: ['real-profile-boot', 'single-goal-tool', 'legacy-tools-hidden', 'scoped-command', 'create-pause-resume-complete-clear', 'real-tool-dispatch', 'native-goal-rpc', 'automatic-round', 'cold-restore-disarmed', 'fork-disarmed', 'agent-full-state-control-without-human-input'] }
  result.checks.push('five-action-model-schema', 'model-mutations-without-caller-refs')
  if (hot) result.checks.push('hot-settings-persisted-without-remount', 'first-request-schema-updated', 'pending-question-late-answer')
  if (mode !== 'standalone') result.checks.push('noask-preserved')
  await writeFile(join(home, 'results.json'), JSON.stringify(result, null, 2))
  console.log('BETTER_GOAL_RUNTIME_SMOKE_PASSED', JSON.stringify(result))
} finally {
  if (ctx) await ctx.fiber.dispose()
}
