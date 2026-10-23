import { defineTool } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { resolveRoundLimit } from './config.js'

export const LEGACY_GOAL_TOOLS = ['get_goal', 'create_goal', 'update_goal']
export const GOAL_ACTIONS = ['get', 'create', 'edit', 'pause', 'resume', 'complete', 'fail', 'clear']

export function goalRef(goal) {
  return { id: goal.id, revision: goal.revision }
}

function invalid(message) {
  throw new HarnessError(message, 'GOAL_INVALID_ACTION')
}

const RESUMABLE_PHASES = ['active', 'paused', 'blocked']

/**
 * Preflight the native resume state machine before any edit can be committed.
 * `resume` may carry a round-cap edit; checking first keeps a rejected resume
 * from leaving a phantom revision (or lowered cap) in the session log.
 */
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

/**
 * Strict function schemas materialize omitted optional fields as `""` / `0`.
 * Treat those placeholders as absent at the model tool boundary, matching the
 * native goal tool's `hasText` / `hasRoundCap`. Required inputs still fail when
 * their normalized value is absent, and meaningful values stay validated.
 */
function stripStrictFiller(args) {
  const normalized = { ...args }
  if (normalized.objective === '') delete normalized.objective
  if (normalized.reason === '') delete normalized.reason
  if (normalized.max_goal_rounds === 0) delete normalized.max_goal_rounds
  return normalized
}

/** One action path shared by tools and commands; all writes retain native CAS. */
export function executeGoalAction(ctx, agent, args, config) {
  if (!GOAL_ACTIONS.includes(args.action)) invalid('Unknown goal action')
  const goals = ctx.get('goals')
  const current = goals.get(agent)
  if (args.action === 'get') return { goal: current ?? null }
  if (args.action === 'create') {
    if (typeof args.objective !== 'string' || !args.objective.trim()) invalid('create requires a non-empty objective')
    const goal = goals.create(agent, {
      objective: args.objective,
      maxGoalRounds: resolveRoundLimit(config, args.max_goal_rounds),
    })
    return { goal }
  }
  if (!current) invalid('No goal is set; create one first')
  if (args.goal_id !== current.id || args.revision !== current.revision) {
    throw new HarnessError('Goal changed; read it again before modifying it', 'GOAL_STALE_REF')
  }
  if (args.action !== 'edit' && args.objective !== undefined) invalid('objective is only valid for create/edit')
  if (args.action !== 'fail' && args.reason !== undefined) invalid('reason is only valid for fail')
  if (args.action !== 'edit' && args.action !== 'resume' && args.max_goal_rounds !== undefined) invalid('max_goal_rounds is only valid for create/edit/resume')
  let goal = current
  if (args.action === 'edit' || args.action === 'resume') {
    const cap = resolveRoundLimit(config, args.max_goal_rounds, current.maxGoalRounds)
    if (args.action === 'resume') assertResumeAllowed(current, cap)
    const changes = {
      ...(args.objective !== undefined ? { objective: args.objective } : {}),
      ...(cap !== current.maxGoalRounds ? { maxGoalRounds: cap } : {}),
    }
    if (Object.keys(changes).length) goal = goals.edit(agent, goalRef(current), changes)
    else if (args.action === 'edit') invalid('edit requires a changed objective or round limit')
    if (args.action === 'edit') return { goal }
  }
  const ref = goalRef(goal)
  switch (args.action) {
    case 'pause': return { goal: goals.pause(agent, ref) }
    case 'resume': return { goal: goals.resume(agent, ref) }
    case 'complete': return { goal: goals.complete(agent, ref) }
    case 'fail': {
      if (typeof args.reason !== 'string' || !args.reason.trim()) invalid('fail requires a concrete reason')
      return { goal: goals.block(agent, ref, { code: 'model-reported', message: args.reason }) }
    }
    case 'clear': goals.clear(agent, ref); return { goal: null }
    default: invalid('Unknown goal action')
  }
}

/** Schema is refreshed between steps; the execution policy always reads live config. */
export function createGoalTool(ctx, readConfig) {
  const parameters = {
    action: { type: 'string', required: true, enum: GOAL_ACTIONS, description: 'Read, create, edit, pause, resume, complete, fail or clear the current goal. You control every lifecycle action.' },
    objective: { type: 'string', description: 'The full completion objective; required for create, optional for edit. Preserve the user-requested scope.' },
    goal_id: { type: 'string', description: 'Exact current goal id; required for mutations other than create.' },
    revision: { type: 'integer', description: 'Exact current goal revision; required for mutations other than create.' },
    reason: { type: 'string', description: 'Required for fail: the concrete blocker or reason the goal cannot be achieved.' },
  }
  if (readConfig().roundLimitMode === 'agent') parameters.max_goal_rounds = {
    type: 'integer', description: 'Optional positive safe-integer round cap for create/edit/resume. On create, omitting it selects no policy cap; on edit/resume, omission preserves the existing cap.',
  }
  return defineTool({
    name: 'goal',
    description: 'Manage the persistent goal for this session. A goal is the overall objective; use todo_write for steps. You can explicitly control every goal state, including resume after pause, without requiring a new human message. Creating/resuming arms automatic continuation; ordinary session reopen/fork does not. Complete only after current evidence proves the entire objective. If external conditions or required human input prevent further meaningful work, fail immediately with a concrete reason. Never shrink an objective to claim completion.',
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute(args, exec) {
      const agent = liveGoalAgent(ctx, exec)
      return Promise.resolve(executeGoalAction(ctx, agent, stripStrictFiller(args), readConfig()))
    },
    presentCall: (args) => ({ card: 'generic', title: `${args.action} goal`, kind: args.action === 'get' ? 'read' : 'other' }),
  })
}
