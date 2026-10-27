import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { executeGoalAction, goalRef } from './tool.js'
import { isUnlimitedCap, resolveRoundLimit } from './config.js'

export function parseGoalCommand(rawInput) {
  const input = rawInput.trim()
  if (!input) return { action: 'get' }
  const controls = { on: 'resume', off: 'pause', get: 'get', pause: 'pause', resume: 'resume', clear: 'clear', complete: 'complete' }
  if (controls[input.toLowerCase()]) return { action: controls[input.toLowerCase()] }
  const match = /^(edit|create|fail|set)\s+([\s\S]+)$/iu.exec(input)
  if (match) return match[1].toLowerCase() === 'fail'
    ? { action: 'fail', reason: match[2] }
    : { action: match[1].toLowerCase(), objective: match[2] }
  if (/^(edit|create|fail|set)$/iu.test(input)) throw new TypeError(`${input} requires text`)
  return { action: 'create', objective: input }
}

function renderGoal(goal) {
  return [
    `Goal: ${goal.objective}`,
    `Status: ${goal.phase}${goal.phase === 'active' && goal.activation === 'disarmed' ? ' (waiting for explicit resume)' : ''}`,
    `Rounds: ${goal.roundsStarted}/${isUnlimitedCap(goal.maxGoalRounds) ? 'unlimited' : goal.maxGoalRounds}`,
    ...(goal.blockedReason ? [`Reason: ${goal.blockedReason.message}`] : []),
  ].join('\n')
}

export function executeGoalCommand(ctx, invocation, readConfig) {
  try {
    const goals = ctx.get('goals')
    const args = parseGoalCommand(invocation.rawInput)
    const current = goals.get(invocation.agent)
    const attachments = invocation.attachments ?? []
    const requested = args.action
    if (attachments.length && !['create', 'set', 'edit'].includes(requested)) {
      throw new TypeError('Attachments require a goal objective')
    }
    // `create` is the human alias for the model-facing `set` write path, and
    // `set` itself is now an explicit command. Editing a completed goal starts
    // a new goal; editing any other goal stays the native in-place edit.
    if (args.action === 'create' || (args.action === 'edit' && current?.phase === 'complete')) args.action = 'set'
    if (args.action === 'clear' && !current) return { kind: 'success', text: 'No goal to clear.' }
    if (!current && ['edit', 'pause', 'resume', 'complete', 'fail'].includes(args.action)) {
      return { kind: 'error', text: 'No goal is set. Use /goal set <objective> first.' }
    }

    let goal
    if (args.action === 'edit') {
      goal = goals.edit(invocation.agent, goalRef(current), {
        objective: args.objective,
        maxGoalRounds: resolveRoundLimit(readConfig(), undefined, current.maxGoalRounds),
      })
    } else if (args.action === 'pause') {
      goal = goals.pause(invocation.agent, goalRef(current))
    } else if (args.action === 'fail') {
      // Human-only blocker: the model pauses instead, so this keeps a durable reason.
      goal = goals.block(invocation.agent, goalRef(current), { code: 'user-reported', message: args.reason.trim() })
    } else if (args.action === 'clear') {
      goals.clear(invocation.agent, goalRef(current))
      return { kind: 'success', text: 'Goal cleared.' }
    } else {
      goal = executeGoalAction(ctx, invocation.agent, args, readConfig()).goal
    }

    if (attachments.length) invocation.agent.followup(createUserMessage({
      content: [...attachments, { type: 'text', text: 'Reference attachments for the goal objective.' }],
      source: { kind: 'user' },
    }))
    if (!goal) return { kind: 'success', text: 'No goal is set. Use /goal set <objective>.' }
    return { kind: 'success', text: renderGoal(goal) }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

export function registerGoalCommand(ctx, readConfig) {
  const commands = ctx.get('commands')
  if (!commands) return () => {}
  return commands.register({
    definitionId: 'dsh-better-goal',
    name: 'goal',
    description: 'View or control the persistent goal',
    input: { hint: '[<objective>|edit <objective>|pause|resume|clear|set <objective>|create <objective>|fail <reason>|complete]', attachments: true },
    handler: (invocation) => executeGoalCommand(ctx, invocation, readConfig),
  })
}
