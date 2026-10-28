import { Config, readConfig as snapshotConfig, UNLIMITED_ROUNDS } from './config.js'
import { GoalService } from './service.js'
import { createGoalTool, LEGACY_GOAL_TOOLS } from './tool.js'
import { registerGoalCommand } from './commands.js'
import { apply as mountDriver } from './driver.js'
import { mountSettings } from './settings.js'

export { Config }
export const name = 'dsh-better-goal'
export const inject = ['agents', 'sessions', 'sessionProjections', 'tools', 'systemPrompt']

export function apply(ctx, config = {}) {
  const readConfig = () => snapshotConfig(config)
  ctx.provide('betterGoalConfig', { get: readConfig })
  ctx.plugin(GoalService, { defaultMaxGoalRounds: UNLIMITED_ROUNDS })
  mountSettings(ctx)
  ctx.inject(['goals'], (runtime) => {
    const states = new Map()
    function refresh(state) {
      const tools = state.actor.get('tools')
      // Preset generations can change before the first turn. Recheck inherited
      // tools instead of retaining an ask tool from a previous generation.
      const visibleLegacy = LEGACY_GOAL_TOOLS.filter((name) => tools.get(name, state.agent))
      if (visibleLegacy.length) {
        state.restrictDispose?.()
        const legacy = LEGACY_GOAL_TOOLS.filter((name) => tools.get(name, state.agent))
        state.restrictDispose = tools.restrict({ deny: legacy })
      }
      const settings = readConfig()
      if (state.mode !== settings.roundLimitMode) {
        state.goalDispose?.()
        state.goalDispose = tools.register(createGoalTool(state.actor, readConfig))
        state.mode = settings.roundLimitMode
      }
    }
    function setup(agent) {
      if (states.has(agent)) return states.get(agent)
      const actor = agent.ctx
      const state = { agent, actor, mode: undefined }
      state.commandDispose = registerGoalCommand(actor, readConfig)
      state.promptDispose = actor.systemPrompt.section({
        name: 'tool:goal',
        order: actor.systemPrompt.getSectionOrder('TOOL_GOAL'),
        interpolate: false,
        text: 'Use goal for the persistent overall objective and todo_write for steps. Actions: get, set (replace the whole objective; never to reset limits or drop scope), pause (stop automatic continuation, keep the goal), resume (continue without a new human message), complete. Reopening or forking a session does not resume work. Complete only when current evidence proves every requirement. Never force completion: if progress needs the user, such as a missing secret, credential, permission, account or decision, pause and state exactly what is needed instead of mocking, hard-coding, skipping checks or narrowing scope. Keep doing independent work first. A timed-out question is still pending and never grants permission. Host settings govern round limits and question waits.',
      })
      states.set(agent, state)
      refresh(state)
      return state
    }
    function cleanup(state) {
      state.goalDispose?.()
      state.commandDispose?.()
      state.restrictDispose?.()
      state.promptDispose?.()
    }
    runtime.on('agent/created', ({ agent }) => { setup(agent) })
    runtime.on('agent/disposed', ({ agent }) => {
      const state = states.get(agent)
      if (state) cleanup(state)
      states.delete(agent)
    })
    // pre-step runs AFTER prompt assembly in DSH. Update both our registry
    // definitions and their exact assembled schemas in the assembly waterfall.
    runtime.on('system-prompt/assemble', (assembly, context, next) => {
      const state = states.get(context.scope)
      if (!state) return next()
      refresh(state)
      const schemas = new Map(state.actor.get('tools').schemas(state.agent).map((tool) => [tool.name, tool]))
      assembly.tools = assembly.tools.flatMap((tool) => {
        if (LEGACY_GOAL_TOOLS.includes(tool.name)) return []
        if (tool.name === 'goal') {
          const schema = schemas.get(tool.name)
          return schema ? [schema] : []
        }
        return [tool]
      })
      return next()
    })
    for (const agent of runtime.agents.list()) setup(agent)
    runtime.effect(() => () => {
      for (const state of states.values()) cleanup(state)
      states.clear()
    }, 'better-goal: per-agent controls')
    mountDriver(runtime, readConfig)
  })
}
