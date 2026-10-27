import { defineTool } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { resolveRoundLimit } from './config.js'

export const LEGACY_GOAL_TOOLS = ['get_goal', 'create_goal', 'update_goal']
export const GOAL_ACTIONS = ['get', 'set', 'pause', 'complete', 'resume']

export function goalRef(goal) {
  return { id: goal.id, revision: goal.revision }
}

function invalid(message) {
  throw new HarnessError(message, 'GOAL_INVALID_ACTION')
}

const RESUMABLE_PHASES = ['active', 'paused', 'blocked']

/** Check every native resume guard before committing a round-cap edit. */
function assertResumeAllowed(goal, maxGoalRounds) {
  if (!RESUMABLE_PHASES.includes(goal.phase)) {
    throw new HarnessError(
      `cannot resume goal "${goal.id}" from phase "${goal.phase}"; expected ${RESUMABLE_PHASES.join(' or ')}`,
      'GOAL_INVALID_TRANSITION',
    )
  }
  if (goal.phase === 'active' && goal.activation === 'armed') {
    throw new HarnessError(`goal "${goal.id}" is already active and armed`, 'GOAL_INVALID_TRANSITION')
  }
  if (goal.roundsStarted >= maxGoalRounds) {
    throw new HarnessError(
      `goal "${goal.id}" exhausted ${maxGoalRounds} goal rounds; increase maxGoalRounds before resuming`,
      'GOAL_INVALID_TRANSITION',
    )
  }
}

/** Authenticate execution ownership, without imposing human-message authority. */
export function liveGoalAgent(ctx, exec) {
  const agent = exec.agent
  if (!agent || ctx.agents.get(agent.id) !== agent || agent.status !== 'running' || ctx.agents.currentInitiator() !== agent) {
    throw new HarnessError('goal requires the exact live calling Agent inside its running turn', 'GOAL_CALLER_NOT_LIVE')
  }
  return agent
}

/** Strict schemas fill omitted optional text/caps with empty strings/zero. */
function stripStrictFiller(args) {
  const normalized = { ...args }
  if (normalized.objective === '') delete normalized.objective
  if (normalized.max_goal_rounds === 0) delete normalized.max_goal_rounds
  return normalized
}

/** Resolve the same live host policy the native service will apply. */
function roundPolicy(ctx, config) {
  const provider = ctx.get('betterGoalConfig')
  if (provider === undefined) return config
  if (typeof provider.get !== 'function') throw new TypeError('betterGoalConfig provider must expose get()')
  return provider.get()
}

/** Five model actions; native mutations receive refs derived from live state. */
export function executeGoalAction(ctx, agent, input, config) {
  const args = stripStrictFiller(input)
  if (!GOAL_ACTIONS.includes(args.action)) invalid('Unknown goal action')
  for (const key of Object.keys(args)) {
    if (!['action', 'objective', 'max_goal_rounds'].includes(key)) invalid(`Unknown goal parameter: ${key}`)
  }
  if (args.action !== 'set' && args.objective !== undefined) invalid('objective is only valid for set')
  if (!['set', 'resume'].includes(args.action) && args.max_goal_rounds !== undefined) invalid('max_goal_rounds is only valid for set/resume')
  if (args.action === 'set' && (typeof args.objective !== 'string' || !args.objective.trim())) invalid('set requires a non-empty objective')
  if (args.max_goal_rounds !== undefined && (!Number.isSafeInteger(args.max_goal_rounds) || args.max_goal_rounds < 1)) {
    throw new TypeError('max_goal_rounds must be a positive safe integer')
  }

  const goals = ctx.get('goals')
  const current = goals.get(agent)
  if (args.action === 'get') return { goal: current ?? null }
  if (args.action === 'set') {
    // Validate the entire create request and live host policy before clearing.
    // Native create supplies a fresh identity, zero rounds and armed activation.
    const request = {
      objective: args.objective,
      maxGoalRounds: resolveRoundLimit(roundPolicy(ctx, config), args.max_goal_rounds),
    }
    if (current && current.phase !== 'complete') goals.clear(agent, goalRef(current))
    return { goal: goals.create(agent, request) }
  }
  if (!current) invalid('No goal is set; use set first')
  if (args.action === 'resume') {
    const cap = resolveRoundLimit(roundPolicy(ctx, config), args.max_goal_rounds, current.maxGoalRounds)
    assertResumeAllowed(current, cap)
    const goal = cap === current.maxGoalRounds
      ? current
      : goals.edit(agent, goalRef(current), { maxGoalRounds: cap })
    return { goal: goals.resume(agent, goalRef(goal)) }
  }
  const ref = goalRef(current)
  if (args.action === 'complete') return { goal: goals.complete(agent, ref) }
  // pause keeps the native record shape: no reason is stored; the agent states
  // what it needs in its reply.
  return { goal: goals.pause(agent, ref) }
}

/** Schema is refreshed between steps; the execution policy always reads live config. */
export function createGoalTool(ctx, readConfig) {
  const parameters = {
    action: { type: 'string', required: true, enum: GOAL_ACTIONS, description: 'Get the current goal, set a replacement goal, pause continuation when the user is needed, complete with proof, or resume continuation.' },
    objective: { type: 'string', description: 'Required for set: the full replacement completion objective. Preserve the entire user-requested scope; set creates a fresh goal and resets its rounds.' },
  }
  if (readConfig().roundLimitMode === 'agent') parameters.max_goal_rounds = {
    type: 'integer', description: 'Optional positive safe-integer round cap for set/resume. On set, omission selects no policy cap; on resume, omission preserves the existing cap.',
  }
  return defineTool({
    name: 'goal',
    description: "Manage this session's persistent goal (the overall objective; use todo_write for steps). get reads it; set fully replaces it with a fresh armed goal; pause stops automatic continuation and keeps the goal resumable; resume continues it without a new human message; complete records verified success. Complete only when current evidence proves the entire objective. If progress needs the user (missing secret, credential, permission or decision), pause and say exactly what is needed; never fake, stub, skip or narrow work to finish.",
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute(args, exec) {
      const agent = liveGoalAgent(ctx, exec)
      return Promise.resolve(executeGoalAction(ctx, agent, args, readConfig()))
    },
    presentCall: (args) => ({ card: 'generic', title: `${args.action} goal`, kind: args.action === 'get' ? 'read' : 'other' }),
  })
}
