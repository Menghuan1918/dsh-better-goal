import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { apply, inject } from '../src/index.js'
import { GoalService } from '../src/service.js'
import { DEFAULTS, UNLIMITED_ROUNDS } from '../src/config.js'
import { handleConfig, CONFIG_PATH } from '../src/settings.js'

const drain = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate) }
const hostRoot = process.env.DSH_PACKAGE_ROOT
const nativeTest = hostRoot ? test : test.skip

async function harness(t, config = {}, loader) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const agents = new Map()
  const queue = []
  const routes = new Map()
  let initiator
  ctx.provide('agents', {
    get: (id) => agents.get(id), list: () => [...agents.values()], roots: () => [...agents.values()],
    currentInitiator: () => initiator,
    withoutInitiator: (fn) => Promise.resolve().then(fn),
  })
  ctx.provide('connection', { requestRejection: () => undefined })
  ctx.provide('webServer', { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } })
  if (loader) ctx.provide('loader', loader)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(CommandRuntime)
  // Retain the same config object the Loader's volatile references update.
  const live = { ...DEFAULTS, ...config }
  const fiber = ctx.plugin({ name: 'goal-test', inject, apply: (inner) => apply(inner, live) })
  await fiber
  await drain()
  assert.ok(ctx.get('goals'), 'goal service must actually mount')
  function addAgent() {
    const session = ctx.sessions.create('index-' + Math.random(), { meta: { cwd: '/tmp' } })
    const agent = {
      id: session.id, ctx, session, status: 'running',
      inbox: { nextStep: [], nextTurn: [], remove(id) { this.nextTurn = this.nextTurn.filter((message) => message.id !== id) } },
      followup(message) { queue.push(message); this.inbox.nextTurn.push(message); this.status = 'running' },
      cancel() { this.status = 'idle' }, whenIdle: async () => {},
    }
    agents.set(agent.id, agent)
    ctx.emit('agent/created', { agent })
    return agent
  }
  return { ctx, fiber, live, agents, queue, routes, addAgent, setInitiator(agent) { initiator = agent } }
}

async function hostLoader() {
  // Use the host's real public import API, as production does. No native mocks.
  const require = createRequire(pathToFileURL(hostRoot + '/package.json'))
  const { Loader } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis-plugin-loader')))
  const importContext = new Context()
  const loader = new Loader(importContext, { baseUrl: pathToFileURL(hostRoot + '/package.json').href })
  // Keep Loader's own context: a plain test provider has no profile baseUrl.
  return { loader: { import: (name) => loader.import(name), entries: () => loader.entries() }, close: () => importContext.fiber.dispose() }
}

function response() {
  return { headers: {}, setHeader(key, value) { this.headers[key] = value }, end(body) { this.body = body } }
}

test('better backend owns one service, one tool and one continuation; saves do not switch it', async (t) => {
  const h = await harness(t)
  assert.ok(h.ctx.goals instanceof GoalService)
  const agent = h.addAgent()
  h.setInitiator(agent)
  const tool = h.ctx.tools.get('goal', agent)
  assert.ok(tool)
  for (const name of ['get_goal', 'create_goal', 'update_goal']) assert.equal(h.ctx.tools.get(name, agent), undefined)
  assert.equal(h.ctx.commands.list(agent).filter((command) => command.name === 'goal').length, 1)
  const { goal } = await tool.execute({ action: 'set', objective: 'Keep the complete task' }, { agent })
  assert.equal(goal.maxGoalRounds, UNLIMITED_ROUNDS)
  const before = agent.session.seq
  h.live.implementation = 'native'
  h.live.roundLimitMode = 'fixed'
  h.live.roundLimit = 9
  const status = h.ctx.get('betterGoalConfig').status()
  assert.equal(status.requiresReload, true)
  assert.equal(status.activeConfig.implementation, 'enhanced')
  assert.equal(status.savedConfig.implementation, 'native')
  assert.equal(status.activeConfig.roundLimit, 9)
  assert.equal(status.loadedConfig.roundLimit, 256)
  assert.equal(status.runtime.implementation, 'enhanced')
  assert.equal(Object.isFrozen(h.ctx.get('betterGoalConfig').snapshot()), true)
  assert.equal(agent.session.seq, before, 'saving selection writes no goal events')
  assert.equal(h.ctx.goals.get(agent).activation, 'armed')
  assert.equal(h.ctx.tools.get('goal', agent), tool)
  h.ctx.goals.edit(agent, { id: goal.id, revision: goal.revision }, { objective: goal.objective })
  agent.status = 'idle'
  h.ctx.emit('agent/status', { agent, status: 'idle' })
  await drain()
  assert.equal(h.queue.length, 1, 'exactly one continuation driver queues a round')
  assert.equal(h.ctx.goals.get(agent).maxGoalRounds, 9, 'existing hot round policy still applies')
  const active = h.ctx.goals.get(agent)
  h.ctx.goals.pause(agent, { id: active.id, revision: active.revision })
  await h.fiber.dispose()
  assert.equal(h.ctx.get('goals'), undefined)
  assert.equal(h.ctx.tools.get('goal', agent), undefined)
  assert.equal(h.routes.has(CONFIG_PATH), false)
})

test('configuration endpoint uses host fence, GET only, current snapshots and no cache', async (t) => {
  const h = await harness(t)
  const handler = h.routes.get(CONFIG_PATH).handler
  const res = response()
  handler({ method: 'GET' }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(JSON.parse(res.body).capabilities.questionTimeout, false)
  const post = response()
  handler({ method: 'POST' }, post)
  assert.equal(post.statusCode, 405)
  assert.equal(post.headers.allow, 'GET')
  let reads = 0
  for (const rejection of [401, 403]) {
    const denied = response()
    handleConfig({ get: () => ({ requestRejection: () => rejection }) }, () => { reads++; return {} }, { method: 'GET' }, denied)
    assert.equal(denied.statusCode, rejection)
  }
  const unavailable = response()
  handleConfig({ get: () => undefined }, () => { reads++; return {} }, { method: 'GET' }, unavailable)
  assert.equal(unavailable.statusCode, 503)
  assert.equal(reads, 0)
})

test('ownership conflicts and unavailable native imports fail before mounting anything', async () => {
  const mounted = []
  for (const ctx of [
    { get: (name) => name === 'goals' ? {} : undefined },
    { get: (name) => name === 'loader' ? { entries: () => [{ id: 'goal-round-driver', disabled: false }] } : undefined },
  ]) {
    await assert.rejects(apply({ ...ctx, plugin: (...args) => mounted.push(args) }), /ownership|remain disabled/)
  }
  await assert.rejects(apply({ get: () => undefined, plugin: (...args) => mounted.push(args) }, { implementation: 'native' }), /Loader import API/)
  await assert.rejects(apply({ get: (name) => name === 'loader' ? { import: async () => { throw new Error('native module missing') } } : undefined, plugin: (...args) => mounted.push(args) }, { implementation: 'native' }), /native module missing/)
  assert.deepEqual(mounted, [])
})

nativeTest('existing implementation:native loads the actual native service, tools, command and one driver through Host Loader', async (t) => {
  const host = await hostLoader()
  t.after(host.close)
  const h = await harness(t, { implementation: 'native', nativeDefaultMaxGoalRounds: 17, nativeBlockedAfterConsecutiveRounds: 2, roundLimitMode: 'fixed', roundLimit: 1 }, host.loader)
  const { GoalService: NativeGoalService } = await host.loader.import('@deepseek-ai/dsh-goal')
  assert.ok(h.ctx.goals instanceof NativeGoalService)
  assert.equal(h.ctx.goals instanceof GoalService, false)
  const agent = h.addAgent()
  await drain()
  assert.equal(h.ctx.tools.get('goal', agent), undefined)
  for (const name of ['get_goal', 'create_goal', 'update_goal']) assert.ok(h.ctx.tools.get(name, agent))
  assert.equal(h.ctx.commands.list(agent).filter((command) => command.name === 'goal').length, 1)
  const goal = h.ctx.goals.create(agent, { objective: 'Native task' })
  assert.equal(goal.maxGoalRounds, 17, 'configured native default is applied; enhanced fixed policy is inactive')
  assert.equal(h.ctx.sessionProjections.stateOf(agent.session, 'better-goal-history').view.entries.length, 1)
  const before = agent.session.seq
  h.live.implementation = 'enhanced'
  const status = h.ctx.get('betterGoalConfig').status()
  assert.equal(status.activeConfig.implementation, 'native')
  assert.equal(status.savedConfig.implementation, 'enhanced')
  assert.equal(status.runtime.implementation, 'native')
  assert.equal(status.capabilities.roundLimitPolicy, false)
  assert.equal(status.requiresReload, true)
  assert.equal(agent.session.seq, before)
  agent.status = 'idle'
  h.ctx.emit('agent/status', { agent, status: 'idle' })
  await drain()
  assert.equal(h.queue.length, 1)
  assert.match(h.queue[0].content[0].text, /Follow the configured goal-tool policy/)
  h.ctx.goals.pause(agent, { id: goal.id, revision: goal.revision })
  await h.fiber.dispose()
  assert.equal(h.ctx.get('goals'), undefined)
  for (const name of ['get_goal', 'create_goal', 'update_goal']) assert.equal(h.ctx.tools.get(name, agent), undefined)
})

nativeTest('native parameters retain their load snapshot and enforce the configured blocking gate', async (t) => {
  const host = await hostLoader()
  t.after(host.close)
  const h = await harness(t, {
    implementation: 'native', nativeDefaultMaxGoalRounds: 23, nativeBlockedAfterConsecutiveRounds: 2,
  }, host.loader)
  const { turnBoundaryProjectionDefinition } = await host.loader.import('@deepseek-ai/dsh-agent-loop')
  h.ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
  const { createUserMessage } = await host.loader.import('@deepseek-ai/dsh-llm')
  const agent = h.addAgent()
  h.setInitiator(agent)
  await drain()
  h.live.nativeDefaultMaxGoalRounds = 31
  h.live.nativeBlockedAfterConsecutiveRounds = 1
  const status = h.ctx.get('betterGoalConfig').status()
  assert.equal(status.requiresReload, true)
  assert.equal(status.activeConfig.nativeDefaultMaxGoalRounds, 23)
  assert.equal(status.activeConfig.nativeBlockedAfterConsecutiveRounds, 2)
  assert.equal(status.savedConfig.nativeDefaultMaxGoalRounds, 31)
  assert.equal(status.savedConfig.nativeBlockedAfterConsecutiveRounds, 1)
  assert.equal(status.loadedConfig.nativeBlockedAfterConsecutiveRounds, 2)
  const goal = h.ctx.goals.create(agent, { objective: 'Native parameter behavior' })
  assert.equal(goal.maxGoalRounds, 23, 'saved native defaults wait for reload')
  const tool = h.ctx.tools.get('update_goal', agent)
  const deferred = []
  const exec = { agent, deferContext: (message) => deferred.push(message) }
  const args = { goal_id: goal.id, revision: goal.revision, action: 'blocked', blocked_reason: 'Missing required user secret' }
  for (let round = 1; round <= 2; round++) {
    agent.session.append('turn/start', { turn: round })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Automatic goal round' }],
      source: { kind: 'goal', goalId: goal.id, revision: goal.revision, round },
    }), { surfaceOp: 'append' })
    assert.equal(h.ctx.goals.get(agent).roundsStarted, round)
    if (round === 1) {
      await assert.rejects(tool.execute(args, exec), (error) => error.code === 'GOAL_TOOL_BLOCK_THRESHOLD' && /at least 2/.test(error.message))
      assert.equal(h.ctx.goals.get(agent).phase, 'active')
    } else {
      const result = await tool.execute(args, exec)
      assert.equal(result.goal.phase, 'blocked', 'configured threshold 2 allows round 2; default 3 would reject')
      assert.equal(h.ctx.goals.get(agent).blockedReason.code, 'model-reported')
      assert.equal(deferred.length, 1)
    }
  }
})

nativeTest('isolated real profile switches both backends and preserves the same durable goal', async (t) => {
  const { mkdtemp, mkdir, cp, symlink, readFile, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join, dirname, resolve } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const home = await mkdtemp(join(tmpdir(), 'better-goal-native-test-'))
  const previousHome = process.env.DSH_HOME
  const previousTelemetry = process.env.DSH_TELEMETRY_DISABLED
  process.env.DSH_HOME = home
  process.env.DSH_TELEMETRY_DISABLED = '1'
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousTelemetry === undefined) delete process.env.DSH_TELEMETRY_DISABLED
    else process.env.DSH_TELEMETRY_DISABLED = previousTelemetry
  })
  const require = createRequire(pathToFileURL(hostRoot + '/package.json'))
  const A = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')))
  const profile = A.resolveProfileDir('native-test', home)
  A.initProfile(profile, [...A.PROFILE_TEMPLATES.headless.bundles, 'dsh-better-goal'])
  const modules = join(profile, 'node_modules')
  const plugin = join(modules, 'dsh-better-goal')
  await mkdir(plugin, { recursive: true })
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  for (const name of ['package.json', 'src', 'cordis.patch.yml']) await cp(join(root, name), join(plugin, name), { recursive: true })
  await symlink(dirname(hostRoot), join(modules, '@deepseek-ai'))
  const localRequire = createRequire(import.meta.url)
  await symlink(dirname(localRequire.resolve('zod/package.json')), join(modules, 'zod'))
  await symlink(dirname(localRequire.resolve('react/package.json')), join(modules, 'react'))
  const manifestPath = join(profile, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.dependencies['dsh-better-goal'] = 'file:' + plugin
  await writeFile(manifestPath, JSON.stringify(manifest))
  const patchPath = join(profile, 'cordis.patch.yml')
  const patch = [
    ...A.loadOverlayPatches('native-test', join(dirname(hostRoot), 'dsh-web-app/presets/standard.patch.yml')),
    { id: 'headless-startup', disabled: true }, { id: 'headless-runner', disabled: true },
    { id: 'credentials', disabled: false, config: { watch: false } },
    { id: 'dsh-better-goal', config: { implementation: 'native', nativeDefaultMaxGoalRounds: 17, nativeBlockedAfterConsecutiveRounds: 2 } },
    { insert: [
      { id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'standard' } },
      { id: 'subagent-model-selection-settings', name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings', config: { enabled: true, allowedModels: [{ provider: 'test-native', model: 'test' }] } },
      { id: 'workspace', name: '@deepseek-ai/dsh-workspace' },
      { id: 'connection', name: '@deepseek-ai/dsh-client-connection' },
      { id: 'file-upload', name: '@deepseek-ai/dsh-client-file-upload' },
      { id: 'file-reference-local', name: '@deepseek-ai/dsh-file-reference-local' },
      { id: 'session-controller', name: '@deepseek-ai/dsh-api-session-controller' },
      { id: 'schedule', name: '@deepseek-ai/dsh-schedule' },
    ] },
  ]
  await writeFile(patchPath, JSON.stringify(patch))
  const { runProfile } = await import(pathToFileURL(join(hostRoot, 'lib/profile-boot.js')))
  const boot = () => runProfile({ profile: 'native-test', patchFiles: [], args: [], environment: A.loadLayeredEnv('dsh') })
  const first = await boot()
  const dispose = (ctx) => ctx.fiber.dispose()
  let firstOpen = true
  t.after(async () => { if (firstOpen) await dispose(first.ctx) })
  const ctx = first.ctx
  const { GoalService: NativeGoalService } = await ctx.loader.import('@deepseek-ai/dsh-goal')
  assert.ok(ctx.goals instanceof NativeGoalService)
  assert.equal(ctx.get('betterGoalConfig').status().runtime.implementation, 'native')
  const created = await ctx.agents.create({
    sessionId: 'native-profile-session', meta: { cwd: home, agentPreset: 'standard' },
    agentOptions: { provider: 'test-native', model: 'test' },
    setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'standard') },
  })
  const agent = created.agent
  for (const name of ['get_goal', 'create_goal', 'update_goal']) assert.ok(ctx.tools.get(name, agent))
  assert.equal(ctx.tools.get('goal', agent), undefined)
  assert.equal(ctx.commands.list(agent).filter((command) => command.name === 'goal').length, 1)
  const goal = ctx.goals.create(agent, { objective: 'Preserve native session data' })
  assert.equal(goal.maxGoalRounds, 17, 'existing canonical native default passes through the real profile Loader')
  const paused = ctx.goals.pause(agent, { id: goal.id, revision: goal.revision })
  await ctx.sessions.flush(agent.session)
  await dispose(ctx)
  firstOpen = false
  patch.find((row) => row.id === 'dsh-better-goal').config.implementation = 'enhanced'
  await writeFile(patchPath, JSON.stringify(patch))
  const second = await boot()
  let secondOpen = true
  t.after(async () => { if (secondOpen) await dispose(second.ctx) })
  const reopened = await second.ctx.agents.resume({
    resumeSessionId: 'native-profile-session', agentOptions: { provider: 'test-native', model: 'test' },
    setup: async (agentCtx) => { await second.ctx.agentPresets.mount(agentCtx, 'standard') },
  })
  const restored = second.ctx.goals.get(reopened.agent)
  assert.equal(second.ctx.get('betterGoalConfig').status().runtime.implementation, 'enhanced')
  assert.equal(restored.id, paused.id)
  assert.equal(restored.revision, paused.revision)
  assert.equal(restored.objective, paused.objective)
  assert.equal(restored.maxGoalRounds, 17)
  assert.equal(restored.roundsStarted, paused.roundsStarted)
  assert.equal(restored.phase, 'paused')
  assert.equal(restored.activation, 'disarmed')
  assert.ok(second.ctx.tools.get('goal', reopened.agent))
  for (const name of ['get_goal', 'create_goal', 'update_goal']) assert.equal(second.ctx.tools.get(name, reopened.agent), undefined)
  const edited = second.ctx.goals.edit(reopened.agent, { id: restored.id, revision: restored.revision }, { objective: 'Preserve better edits when returning to native' })
  await second.ctx.sessions.flush(reopened.agent.session)
  await dispose(second.ctx)
  secondOpen = false
  Object.assign(patch.find((row) => row.id === 'dsh-better-goal').config, {
    implementation: 'native', nativeDefaultMaxGoalRounds: 31, nativeBlockedAfterConsecutiveRounds: 5,
  })
  await writeFile(patchPath, JSON.stringify(patch))
  const third = await boot()
  t.after(() => dispose(third.ctx))
  const nativeAgain = await third.ctx.agents.resume({
    resumeSessionId: 'native-profile-session', agentOptions: { provider: 'test-native', model: 'test' },
    setup: async (agentCtx) => { await third.ctx.agentPresets.mount(agentCtx, 'standard') },
  })
  const nativeRestored = third.ctx.goals.get(nativeAgain.agent)
  assert.equal(third.ctx.get('betterGoalConfig').status().runtime.implementation, 'native')
  assert.equal(nativeRestored.id, edited.id)
  assert.equal(nativeRestored.revision, edited.revision)
  assert.equal(nativeRestored.objective, edited.objective)
  assert.equal(nativeRestored.maxGoalRounds, edited.maxGoalRounds)
  assert.equal(nativeRestored.phase, 'paused')
  assert.equal(nativeRestored.activation, 'disarmed')
  assert.equal(third.ctx.sessionProjections.stateOf(nativeAgain.agent.session, 'better-goal-history').view.entries[0].objective, edited.objective)
  const nativeStatus = third.ctx.get('betterGoalConfig').status()
  assert.equal(nativeStatus.activeConfig.nativeDefaultMaxGoalRounds, 31)
  assert.equal(nativeStatus.activeConfig.nativeBlockedAfterConsecutiveRounds, 5)
  assert.equal(nativeStatus.requiresReload, false)
  third.ctx.goals.complete(nativeAgain.agent, { id: nativeRestored.id, revision: nativeRestored.revision })
  const next = third.ctx.goals.create(nativeAgain.agent, { objective: 'Use the reloaded native default' })
  assert.equal(next.maxGoalRounds, 31)
  third.ctx.goals.pause(nativeAgain.agent, { id: next.id, revision: next.revision })
})
