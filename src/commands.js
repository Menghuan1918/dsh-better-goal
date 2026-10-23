import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { executeGoalAction } from './tool.js'
import { isUnlimitedCap } from './config.js'

export function parseGoalCommand(rawInput) {
  const input = rawInput.trim()
  if (!input) return { action: 'get' }
  const controls = { on: 'resume', off: 'pause', get: 'get', pause: 'pause', resume: 'resume', clear: 'clear', complete: 'complete' }
  if (controls[input.toLowerCase()]) return { action: controls[input.toLowerCase()] }
  const match = /^(edit|create|fail)\s+([\s\S]+)$/iu.exec(input)
  if (match) return match[1].toLowerCase() === 'fail'
    ? { action: 'fail', reason: match[2] }
    : { action: match[1].toLowerCase(), objective: match[2] }
  if (/^(edit|create|fail)$/iu.test(input)) throw new TypeError(`${input} requires text`)
  return { action: 'create', objective: input }
}

export function executeGoalCommand(ctx, invocation, readConfig) {
  try {
    const args = parseGoalCommand(invocation.rawInput)
    const current = ctx.get('goals').get(invocation.agent)
    // Native command semantics: editing a completed goal replaces it with a
    // new goal instead of mutating the completed one. The tool's `edit` action
    // keeps its in-place semantics.
    if (args.action === 'edit' && current?.phase === 'complete') args.action = 'create'
    if (invocation.attachments?.length && !['create', 'edit'].includes(args.action)) throw new TypeError('Attachments require a goal objective')
    if (current && !['get', 'create'].includes(args.action)) Object.assign(args, { goal_id: current.id, revision: current.revision })
    if (args.action === 'clear' && !current) return { kind: 'success', text: 'No goal to clear.' }
    const value = executeGoalAction(ctx, invocation.agent, args, readConfig())
    if (invocation.attachments?.length) invocation.agent.followup(createUserMessage({
      content: [...invocation.attachments, { type: 'text', text: 'Reference attachments for the goal objective.' }],
      source: { kind: 'user' },
    }))
    if (!value.goal) return { kind: 'success', text: args.action === 'clear' ? 'Goal cleared.' : 'No goal is set. Use /goal <objective>.' }
    const goal = value.goal
    return {
      kind: 'success',
      text: [
        `Goal: ${goal.objective}`,
        `Status: ${goal.phase}${goal.phase === 'active' && goal.activation === 'disarmed' ? ' (waiting for explicit resume)' : ''}`,
        `Rounds: ${goal.roundsStarted}/${isUnlimitedCap(goal.maxGoalRounds) ? 'unlimited' : goal.maxGoalRounds}`,
        ...(goal.blockedReason ? [`Reason: ${goal.blockedReason.message}`] : []),
      ].join('\n'),
    }
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
    input: { hint: '[<objective>|edit <objective>|pause|resume|clear]', attachments: true },
    handler: (invocation) => executeGoalCommand(ctx, invocation, readConfig),
  })
}
