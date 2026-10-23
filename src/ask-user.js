/**
 * Goal-scoped timed `ask_user_question` shadow.
 *
 * The root plugin keeps this definition stable whenever the composition
 * already registered an ask tool. Execution delegates to that tool outside
 * an active, armed goal. The definition reuses that live tool's `questions`
 * schema, declares the native timed-wait marker, and uses the host's volatile
 * `questionTimeoutSeconds` setting for every NEW wait. Writes and goal state
 * remain outside this module.
 *
 * The tool deliberately does not import `@deepseek-ai/dsh-tool-ask-user`:
 * only the public user-questions service and the native marker are used, so
 * this plugin never depends on the host tool's runtime row.
 *
 * @module dsh-better-goal/ask-user
 */
import {
  ToolArgsError,
  validateJsonSchemaValue,
} from '@deepseek-ai/dsh-tools'
import { TIMED_WAIT_PARAMETER } from '@deepseek-ai/dsh-user-questions'

/** Default foreground goal-question wait in seconds. */
export const DEFAULT_QUESTION_TIMEOUT_SECONDS = 120

/** Largest question wait a native platform timer can represent, in seconds. */
export const MAX_QUESTION_TIMEOUT_SECONDS = 2147483

/**
 * Model-visible notice carried by a timed-out (still answerable) result. This
 * is intentionally the native tool's wording: the recorded text is re-read by
 * the `userQuestions` projection and the client question row, and a pending
 * result must never read as human authorization.
 */
export const PENDING_QUESTION_NOTICE = 'No answer batch arrived before the timeout. This is pending, not a skipped answer. Continue useful independent work. The user can still answer; their reply will be a user message identified as answer_to_pending_question with this callId and the original questions. Do not treat this as permission.'

/** Native timed ask-tool description, with the host-controlled wait made explicit. */
const TIMED_ASK_DESCRIPTION = 'Ask brief, direct, self-contained questions about missing information, preferences, or decisions. Use user-facing terms; assume no knowledge of background work or internal names. Use distinct stable question IDs. A submitted skipped question is an answer item with empty selected and no custom; pending instead means no answer batch arrived before the timeout and the user can still answer. While a goal is active and armed, the host controls the wait duration and ignores timeout arguments. Otherwise the existing question tool behavior is preserved.'

/** The native timed-wait marker; its presence in the logged schema makes a call answerable after a timeout. */
const TIMED_WAIT_PARAMETER_SCHEMA = {
  type: 'integer',
  description: 'Compatibility wait field. The host goal-question timeout controls every new wait; any value supplied here is ignored.',
}

/** Native answers branch of the timed tool's output schema. */
const ANSWER_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answers'],
  properties: {
    answers: {
      type: 'array',
      description: 'Submitted answer batch with one item per question. A skipped question has empty selected and no custom; unlike pending, the user has completed the batch.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'selected'],
        properties: {
          id: {
            type: 'string',
            description: 'Stable question id echoed from the request.',
          },
          selected: {
            type: 'array',
            items: { type: 'string' },
            description: 'Selected option labels. Empty with no custom means the user explicitly skipped this question.',
          },
          custom: {
            type: 'string',
            description: 'Optional free-form answer; omitted for a skipped question.',
          },
        },
      },
    },
  },
}

/** Native pending branch of the timed tool's output schema. */
const PENDING_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pending', 'callId', 'message'],
  properties: {
    pending: {
      type: 'boolean',
      enum: [true],
      description: 'True when the foreground wait expired before the user submitted an answer batch. The questions remain answerable; this is not a skipped answer.',
    },
    callId: {
      type: 'string',
      description: 'Tool call whose unanswered questions remain pending.',
    },
    message: {
      type: 'string',
      description: 'How to continue while the questions stay answerable.',
    },
  },
}

/** Native timed output shape: a real answer batch or a pending, still-answerable result. */
const OUTPUT_SCHEMA = {
  oneOf: [PENDING_OUTPUT_SCHEMA, ANSWER_OUTPUT_SCHEMA],
}

/** Check one configured timeout value without coercing it. */
function validateTimeoutSeconds(seconds) {
  if (seconds !== -1 && (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_QUESTION_TIMEOUT_SECONDS)) {
    throw new TypeError(`questionTimeoutSeconds must be -1 or a positive integer up to ${MAX_QUESTION_TIMEOUT_SECONDS} seconds`)
  }
  return seconds
}

/** Read the live setting once per new wait; volatile references are unwrapped without caching. */
function readQuestionTimeoutSeconds(readConfig) {
  const config = typeof readConfig === 'function' ? readConfig() : undefined
  const raw = config?.questionTimeoutSeconds
  const value = raw !== null && typeof raw === 'object' && typeof raw.get === 'function'
    ? raw.get()
    : raw
  return validateTimeoutSeconds(value ?? DEFAULT_QUESTION_TIMEOUT_SECONDS)
}

/** Reject duplicate question ids within one call. */
function validateQuestionIds(questions) {
  const ids = new Set()
  for (const question of questions) {
    if (ids.has(question.id)) throw new Error(`question id ${JSON.stringify(question.id)} must be unique within this call`)
    ids.add(question.id)
  }
}

/** Translate the model schema into the service request without changing ownership. */
function questionRequest(questions, exec) {
  return {
    questions: questions.map((question) => ({
      id: question.id,
      question: question.question,
      ...(question.header !== undefined ? { header: question.header } : {}),
      ...(question.options !== undefined ? { options: question.options.map((option) => ({ ...option })) } : {}),
      ...(question.multi_select !== undefined ? { multiSelect: question.multi_select } : {}),
    })),
    ...(exec.agent !== undefined ? { agent: exec.agent } : {}),
    signal: exec.signal,
  }
}

/** Copy service-owned answer arrays into the model-facing result. */
function answerResult(result) {
  return {
    answers: result.answers.map((answer) => ({
      id: answer.id,
      selected: [...answer.selected],
      ...(answer.custom !== undefined ? { custom: answer.custom } : {}),
    })),
  }
}

/** Build the scoped shadow definition from the currently registered ask tool. */
export function createGoalAskTool(ctx, baseDefinition, readConfig) {
  if (baseDefinition?.name !== 'ask_user_question') {
    throw new TypeError('createGoalAskTool requires the existing ask_user_question definition')
  }
  const baseQuestions = baseDefinition.parameters?.properties?.questions
  if (baseQuestions === undefined) {
    throw new TypeError('createGoalAskTool requires the base definition to declare a questions parameter')
  }

  const parameters = {
    ...baseDefinition.parameters,
    properties: {
      ...baseDefinition.parameters.properties,
      [TIMED_WAIT_PARAMETER]: TIMED_WAIT_PARAMETER_SCHEMA,
    },
  }

  const execute = async (args, exec) => {
    const violations = validateJsonSchemaValue(parameters, args, '')
    if (violations.length > 0) throw new ToolArgsError(violations)
    validateQuestionIds(args.questions)

    const goal = exec.agent && ctx.get('goals')?.get(exec.agent)
    if (goal?.phase !== 'active' || goal.activation !== 'armed') {
      const baseArgs = { ...args }
      if (!(TIMED_WAIT_PARAMETER in baseDefinition.parameters.properties)) delete baseArgs[TIMED_WAIT_PARAMETER]
      return baseDefinition.execute(baseArgs, exec)
    }

    const seconds = readQuestionTimeoutSeconds(readConfig)
    const userQuestions = ctx.get('userQuestions')
    if (userQuestions === undefined) throw new Error('ask_user_question requires the userQuestions service')
    const request = questionRequest(args.questions, exec)

    if (seconds === -1) {
      return answerResult(await userQuestions.ask({
        ...request,
        wait: { callId: exec.callId },
      }))
    }

    if (exec.agent === undefined) throw new Error('timed questions require a live agent')
    const result = await userQuestions.askTimed({
      ...request,
      agent: exec.agent,
    }, exec.callId, seconds * 1000)
    return 'pending' in result
      ? { ...result, message: PENDING_QUESTION_NOTICE }
      : answerResult(result)
  }

  return {
    ...baseDefinition,
    description: TIMED_ASK_DESCRIPTION,
    parameters,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute,
  }
}

export default createGoalAskTool
