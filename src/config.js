/**
 * dsh-better-goal — host-side plugin configuration.
 *
 * This file is the single source of truth for the independent goal plugin's
 * settings row. The loader re-exports `Config` from here, so DSH validates and
 * resolves row configuration through this schema:
 *
 *   - `implementation` selects which assembly this row mounts: `enhanced`
 *     (this package's own GoalService/tool/command/driver) or `native` (the
 *     shipped `dsh-goal` service + `dsh-tool-goal` + `dsh-command-goal` +
 *     `dsh-goal-round-driver`). Both share the same durable goal format, so
 *     records survive a switch. The choice is read once at `apply` — saving
 *     persists it, and the next profile reload swaps the whole assembly;
 *     the two implementations never run side by side.
 *   - `nativeDefaultMaxGoalRounds` / `nativeBlockedAfterConsecutiveRounds`
 *     configure the native assembly (service default cap and tool blocking
 *     threshold). Like `implementation` they are mount-time inputs: volatile
 *     writes persist but apply on reload.
 *   - `roundLimitMode` selects how a goal's round cap is resolved:
 *     `agent` (the model may pass `max_goal_rounds`), `unlimited` (the
 *     compatibility sentinel), or `fixed` (the configured `roundLimit`).
 *   - `roundLimit` is the cap used only by `fixed` mode.
 *   - `questionTimeoutSeconds` is deprecated and load-only. It is retained so
 *     existing profiles and the ask-user migration can read the old value; the
 *     goal plugin no longer consumes it and the settings page no longer edits
 *     it. The standalone ask-user plugin owns question waits.
 *
 * Every field is `.volatile()`: changing it hot-swaps the stable reference on
 * the live fiber instead of remounting the row. Consumers (`readConfig`,
 * `resolveRoundLimit` and the UI form, which duplicates the bounds because it
 * is a zero-build closure) read the current value at each new admission.
 * `roundLimitMode`/`roundLimit` apply to the running enhanced assembly at the
 * next admission; `implementation` and the `native*` fields are read once at
 * mount, so their saved value takes effect on profile reload.
 *
 * The unlimited value is Number.MAX_SAFE_INTEGER: native goal/change v1 stores
 * a positive safe-integer cap, and the human explicitly accepted this
 * compatibility sentinel. The UI renders that value as "unlimited"; the
 * driver itself applies no extra policy cap for it.
 */

import z from '@deepseek-ai/schemastery'

/** Plugin row id (also the dsh-settings namespace). */
export const ENTRY_ID = 'dsh-better-goal'
/** npm package name. */
export const PACKAGE_NAME = 'dsh-better-goal'
/** Key the browser half registers its `plugins.row.config` page under. */
export const ROW_CONFIG_KEY = `${PACKAGE_NAME}#${ENTRY_ID}`

/** Compatibility sentinel for "no round cap"; the driver adds no cap for it. */
export const UNLIMITED_ROUNDS = Number.MAX_SAFE_INTEGER

/** Allowed round-cap policies. */
const ROUND_LIMIT_MODES = Object.freeze(['agent', 'unlimited', 'fixed'])

/** Largest question timeout a single native timer can represent (ms bound / 1000). */
const MAX_QUESTION_TIMEOUT_SECONDS = 2147483

/**
 * Plain default values. Kept as JSON-shaped data for consumers that do not
 * parse through the schema (the client form mirrors these exact values).
 */
export const DEFAULTS = Object.freeze({
  implementation: 'enhanced',
  nativeDefaultMaxGoalRounds: 256,
  nativeBlockedAfterConsecutiveRounds: 3,
  roundLimitMode: 'agent',
  roundLimit: 256,
  questionTimeoutSeconds: 120,
})

/** One positive safe-integer goal-round cap. */
const RoundLimit = z
  .natural()
  .min(1)
  .max(UNLIMITED_ROUNDS)
  .default(DEFAULTS.roundLimit)

/**
 * One question timeout: exactly `-1` (never) or an integer in
 * `[1, MAX_QUESTION_TIMEOUT_SECONDS]`; `0` is invalid.
 */
const QuestionTimeout = z
  .union([z.const(-1), z.natural().min(1).max(MAX_QUESTION_TIMEOUT_SECONDS)])
  .default(DEFAULTS.questionTimeoutSeconds)

/**
 * The plugin row's formal configuration schema. All fields are volatile: they
 * hot-update on the live fiber and apply to newly admitted goal rounds/waits.
 */
export const Config = z.object({
  /** Selected service/tool/driver set; save, then reload the profile to apply. */
  implementation: z.union(['enhanced', 'native']).default(DEFAULTS.implementation).volatile(),
  /** Native service default for a goal whose caller omits its cap. */
  nativeDefaultMaxGoalRounds: z.natural().min(1).max(UNLIMITED_ROUNDS).default(DEFAULTS.nativeDefaultMaxGoalRounds).volatile(),
  /** Native tool policy for model-reported blocking. */
  nativeBlockedAfterConsecutiveRounds: z.natural().min(1).max(UNLIMITED_ROUNDS).default(DEFAULTS.nativeBlockedAfterConsecutiveRounds).volatile(),
  /** Round-cap policy: agent-chosen, unlimited, or the configured fixed cap. */
  roundLimitMode: z.union(ROUND_LIMIT_MODES).default(DEFAULTS.roundLimitMode).volatile(),
  /** Fixed cap; used only when `roundLimitMode` is `fixed`. */
  roundLimit: RoundLimit.volatile(),
  /** Deprecated/load-only goal-question wait; kept for profile migration. */
  questionTimeoutSeconds: QuestionTimeout.volatile(),
})

/** Shared cosmokit volatile-reference symbol (identical across package copies). */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** Whether a value is a cosmokit volatile reference. */
function isVolatileRef(value) {
  return typeof value === 'object' && value !== null
    && typeof value.get === 'function' && VOLATILE_WRITE in value
}

/** Read one configuration field, unwrapping a volatile reference when present. */
function fieldOf(config, key) {
  const value = config?.[key]
  return isVolatileRef(value) ? value.get() : value
}

/** Require one positive safe-integer cap; never coerce strings or fractions. */
function requirePositiveSafeInteger(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer, got ${String(value)}`)
  }
  return value
}

/** Require one schema-valid question timeout: -1 or an integer in [1, 2147483]. */
function requireQuestionTimeout(value) {
  if (value === -1) return -1
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_QUESTION_TIMEOUT_SECONDS) {
    throw new TypeError(
      `questionTimeoutSeconds must be -1 or an integer in [1, ${MAX_QUESTION_TIMEOUT_SECONDS}], got ${String(value)}`,
    )
  }
  return value
}

/** Whether a durable round cap is the compatibility unlimited sentinel. */
export function isUnlimitedCap(value) {
  return value === UNLIMITED_ROUNDS
}

/**
 * Resolve the effective goal-round cap for one create/edit admission.
 *
 * - `fixed`: the configured `config.roundLimit` wins and stale caller values
 *   are ignored.
 * - `unlimited`: the sentinel wins and stale caller values are ignored.
 * - `agent`: a supplied cap wins, then the current goal's cap on edit, then the
 *   sentinel for a create that omits the cap.
 *
 * Every value actually used must be a positive safe integer; invalid values
 * throw instead of being silently coerced. Omitted inputs (`undefined`) are
 * not validated and fall through to the next source.
 *
 * @param config - parsed or raw plugin config (volatile fields unwrap).
 * @param supplied - optional cap supplied by the tool caller.
 * @param current - optional current cap when editing an existing goal.
 * @returns validated positive safe integer.
 * @throws {TypeError} for an unknown mode or an invalid cap.
 */
export function resolveRoundLimit(config, supplied, current) {
  const mode = fieldOf(config, 'roundLimitMode') ?? DEFAULTS.roundLimitMode
  switch (mode) {
    case 'fixed':
      return requirePositiveSafeInteger(fieldOf(config, 'roundLimit'), 'roundLimit')
    case 'unlimited':
      return UNLIMITED_ROUNDS
    case 'agent':
      if (supplied !== undefined) return requirePositiveSafeInteger(supplied, 'max_goal_rounds')
      if (current !== undefined) return requirePositiveSafeInteger(current, 'current max_goal_rounds')
      return UNLIMITED_ROUNDS
    default:
      throw new TypeError(`roundLimitMode must be one of ${ROUND_LIMIT_MODES.join(', ')}, got ${String(mode)}`)
  }
}

/**
 * Read all saved settings as one plain snapshot. Assembly selection and native
 * policy are retained until reload; enhanced round policy stays hot.
 *
 * `config` is normally the live row config whose fields may be cosmokit
 * volatile references; each field is unwrapped at call time, so a hot update is
 * visible on the next call. Missing (or `null`) fields take the documented
 * default. Present values must satisfy the same boundaries as {@link Config}
 * and throw `TypeError` otherwise; values are never silently coerced.
 *
 * @param config - live row config (volatile fields unwrap), or a plain object.
 * @returns the six canonical configuration fields as plain JSON.
 * @throws {TypeError} for an invalid mode, cap, or question timeout.
 */
export function readConfig(config) {
  const implementation = fieldOf(config, 'implementation') ?? DEFAULTS.implementation
  if (!['enhanced', 'native'].includes(implementation)) throw new TypeError('implementation must be enhanced or native')
  const nativeDefaultMaxGoalRounds = requirePositiveSafeInteger(fieldOf(config, 'nativeDefaultMaxGoalRounds') ?? DEFAULTS.nativeDefaultMaxGoalRounds, 'nativeDefaultMaxGoalRounds')
  const nativeBlockedAfterConsecutiveRounds = requirePositiveSafeInteger(fieldOf(config, 'nativeBlockedAfterConsecutiveRounds') ?? DEFAULTS.nativeBlockedAfterConsecutiveRounds, 'nativeBlockedAfterConsecutiveRounds')
  const mode = fieldOf(config, 'roundLimitMode')
  const roundLimitMode = mode == null ? DEFAULTS.roundLimitMode : mode
  if (!ROUND_LIMIT_MODES.includes(roundLimitMode)) {
    throw new TypeError(`roundLimitMode must be one of ${ROUND_LIMIT_MODES.join(', ')}, got ${String(roundLimitMode)}`)
  }
  const limit = fieldOf(config, 'roundLimit')
  const roundLimit = limit == null ? DEFAULTS.roundLimit : requirePositiveSafeInteger(limit, 'roundLimit')
  const timeout = fieldOf(config, 'questionTimeoutSeconds')
  const questionTimeoutSeconds = timeout == null
    ? DEFAULTS.questionTimeoutSeconds
    : requireQuestionTimeout(timeout)
  return { implementation, nativeDefaultMaxGoalRounds, nativeBlockedAfterConsecutiveRounds, roundLimitMode, roundLimit, questionTimeoutSeconds }
}
