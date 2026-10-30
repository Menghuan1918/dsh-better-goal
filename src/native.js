import GoalService from '@deepseek-ai/dsh-goal'
import * as Driver from '@deepseek-ai/dsh-goal-round-driver'
import * as Tools from '@deepseek-ai/dsh-tool-goal'
import * as Command from '@deepseek-ai/dsh-command-goal'

/** Mount the upstream domain and controls without any enhanced goal registrations. */
export function mountNative(ctx, config) {
  ctx.plugin(GoalService, { defaultMaxGoalRounds: config.nativeDefaultMaxGoalRounds })
  ctx.plugin(Driver)
  ctx.plugin(Command)
  const fibers = new Map()
  const setup = (agent) => {
    if (fibers.has(agent)) return
    // Presets may already contribute the native tools to the Agent's scope.
    const tools = agent.ctx.get('tools')
    if (['get_goal', 'create_goal', 'update_goal'].every((name) => tools.get(name, agent))) return
    fibers.set(agent, agent.ctx.plugin(Tools, { blockedAfterConsecutiveRounds: config.nativeBlockedAfterConsecutiveRounds }))
  }
  ctx.on('agent/created', ({ agent }) => setup(agent))
  ctx.on('agent/disposed', ({ agent }) => {
    fibers.get(agent)?.dispose()
    fibers.delete(agent)
  })
  for (const agent of ctx.agents.list()) setup(agent)
  ctx.effect(() => () => {
    for (const fiber of fibers.values()) fiber.dispose()
    fibers.clear()
  }, 'better-goal: native agent tools')
}
