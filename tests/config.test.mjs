/**
 * Unit tests for the goal plugin's formal configuration contract.
 *
 * Covers the exact exported identifiers/defaults, the Schemastery schema
 * (including every field being volatile and rejecting invalid caps/timeouts),
 * `resolveRoundLimit`'s create/edit policy matrix with strict positive
 * safe-integer validation, and `readConfig`'s hot plain snapshot.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import z from '@deepseek-ai/schemastery'
import {
  Config,
  DEFAULTS,
  ENTRY_ID,
  PACKAGE_NAME,
  ROW_CONFIG_KEY,
  UNLIMITED_ROUNDS,
  isUnlimitedCap,
  readConfig,
  resolveRoundLimit,
} from '../src/config.js'

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** A cosmokit-shaped volatile reference for unwrapping tests. */
function volatileRef(value) {
  return Object.freeze({
    get: () => value,
    [VOLATILE_WRITE]: () => {},
  })
}

/** Parse through the schema and unwrap every top-level volatile field. */
function resolved(value) {
  const config = Config(value)
  return {
    implementation: config.implementation.get(),
    nativeDefaultMaxGoalRounds: config.nativeDefaultMaxGoalRounds.get(),
    nativeBlockedAfterConsecutiveRounds: config.nativeBlockedAfterConsecutiveRounds.get(),
    roundLimitMode: config.roundLimitMode.get(),
    roundLimit: config.roundLimit.get(),
    questionTimeoutSeconds: config.questionTimeoutSeconds.get(),
  }
}

test('identifier exports match the independent row', () => {
  assert.equal(ENTRY_ID, 'dsh-better-goal')
  assert.equal(PACKAGE_NAME, 'dsh-better-goal')
  assert.equal(ROW_CONFIG_KEY, 'dsh-better-goal#dsh-better-goal')
})

test('DEFAULTS is the exact frozen JSON shape', () => {
  assert.deepEqual(DEFAULTS, {
    implementation: 'enhanced',
    nativeDefaultMaxGoalRounds: 256,
    nativeBlockedAfterConsecutiveRounds: 3,
    roundLimitMode: 'agent',
    roundLimit: 256,
    questionTimeoutSeconds: 120,
  })
  assert.equal(Object.isFrozen(DEFAULTS), true)
})

test('UNLIMITED_ROUNDS is the accepted MAX_SAFE_INTEGER sentinel', () => {
  assert.equal(UNLIMITED_ROUNDS, Number.MAX_SAFE_INTEGER)
  assert.equal(isUnlimitedCap(UNLIMITED_ROUNDS), true)
  assert.equal(isUnlimitedCap(256), false)
  assert.equal(isUnlimitedCap(Number.MAX_SAFE_INTEGER - 1), false)
  assert.equal(isUnlimitedCap('9007199254740991'), false)
  assert.equal(isUnlimitedCap(undefined), false)
})

test('Config({}) resolves the documented defaults through volatile references', () => {
  const config = Config({})
  assert.equal(typeof config.roundLimitMode.get, 'function')
  assert.equal(typeof config.roundLimit.get, 'function')
  assert.equal(typeof config.questionTimeoutSeconds.get, 'function')
  assert.deepEqual(resolved({}), DEFAULTS)
})

test('Config accepts the boundary values of each field', () => {
  assert.deepEqual(resolved({ roundLimitMode: 'fixed', roundLimit: 1, questionTimeoutSeconds: -1 }), {
    ...DEFAULTS,
    roundLimitMode: 'fixed',
    roundLimit: 1,
    questionTimeoutSeconds: -1,
  })
  assert.deepEqual(resolved({ roundLimitMode: 'unlimited', roundLimit: UNLIMITED_ROUNDS, questionTimeoutSeconds: 2147483 }), {
    ...DEFAULTS,
    roundLimitMode: 'unlimited',
    roundLimit: UNLIMITED_ROUNDS,
    questionTimeoutSeconds: 2147483,
  })
})

test('Config rejects unknown modes and non-positive/invalid round caps', () => {
  assert.throws(() => Config({ roundLimitMode: 'yolo' }))
  for (const roundLimit of [0, -1, 1.5, '256', Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => Config({ roundLimit }), undefined, `roundLimit ${String(roundLimit)} should be rejected`)
  }
})

test('Config rejects zero, fractional, oversized, and non-number question timeouts', () => {
  for (const questionTimeoutSeconds of [0, 1.5, 2147484, '120', Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => Config({ questionTimeoutSeconds }),
      undefined,
      `questionTimeoutSeconds ${String(questionTimeoutSeconds)} should be rejected`,
    )
  }
  assert.equal(resolved({ questionTimeoutSeconds: 1 }).questionTimeoutSeconds, 1)
})

test('every schema field is volatile and no other field exists', () => {
  const liveSchema = new z(Config.toJSON())
  assert.deepEqual(Object.keys(liveSchema.dict ?? {}).sort(), [
    'implementation',
    'nativeBlockedAfterConsecutiveRounds',
    'nativeDefaultMaxGoalRounds',
    'questionTimeoutSeconds',
    'roundLimit',
    'roundLimitMode',
  ])
  const paths = []
  const walk = (node, path) => {
    if (node.meta?.volatile === true) paths.push(path.join('.'))
    for (const [key, child] of Object.entries(node.dict ?? {})) walk(child, [...path, key])
    if (node.inner) walk(node.inner, [...path, '[]'])
    for (const child of node.list ?? []) walk(child, [...path, '|'])
  }
  walk(liveSchema, [])
  assert.deepEqual(paths.sort(), Object.keys(DEFAULTS).sort())
})

test('resolveRoundLimit: agent mode prefers supplied, then current, then sentinel', () => {
  const config = { roundLimitMode: 'agent', roundLimit: 256, questionTimeoutSeconds: 120 }
  assert.equal(resolveRoundLimit(config), UNLIMITED_ROUNDS)
  assert.equal(resolveRoundLimit(config, 12), 12)
  assert.equal(resolveRoundLimit(config, undefined, 7), 7)
  assert.equal(resolveRoundLimit(config, 12, 7), 12)
  assert.equal(resolveRoundLimit(undefined, undefined, 9), 9)
  assert.equal(resolveRoundLimit(undefined), UNLIMITED_ROUNDS)
})

test('resolveRoundLimit: unlimited and fixed override stale caller values', () => {
  const fixed = { roundLimitMode: 'fixed', roundLimit: 10, questionTimeoutSeconds: 120 }
  const unlimited = { roundLimitMode: 'unlimited', roundLimit: 10, questionTimeoutSeconds: 120 }
  assert.equal(resolveRoundLimit(fixed, 3, 4), 10)
  assert.equal(resolveRoundLimit(fixed), 10)
  assert.equal(resolveRoundLimit(unlimited, 3, 4), UNLIMITED_ROUNDS)
  // Stale supplied/current values are ignored, not validated, in override modes.
  assert.equal(resolveRoundLimit(unlimited, -1, 'stale'), UNLIMITED_ROUNDS)
  assert.equal(resolveRoundLimit(unlimited, 1.5, null), UNLIMITED_ROUNDS)
})

test('resolveRoundLimit: volatile config references are unwrapped', () => {
  assert.equal(resolveRoundLimit({
    roundLimitMode: volatileRef('fixed'),
    roundLimit: volatileRef(33),
    questionTimeoutSeconds: volatileRef(-1),
  }, 8, 9), 33)
  assert.equal(resolveRoundLimit({
    roundLimitMode: volatileRef('unlimited'),
    roundLimit: volatileRef(33),
    questionTimeoutSeconds: volatileRef(-1),
  }, 8), UNLIMITED_ROUNDS)
  assert.equal(resolveRoundLimit({
    roundLimitMode: volatileRef('agent'),
    roundLimit: volatileRef(33),
    questionTimeoutSeconds: volatileRef(-1),
  }, undefined, 9), 9)
})

test('resolveRoundLimit: fixed mode requires a valid configured cap', () => {
  assert.throws(() => resolveRoundLimit({ roundLimitMode: 'fixed' }), TypeError)
  for (const roundLimit of [0, -1, 1.5, '10', Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
    assert.throws(
      () => resolveRoundLimit({ roundLimitMode: 'fixed', roundLimit }),
      TypeError,
      `fixed roundLimit ${String(roundLimit)} should be rejected`,
    )
  }
})

test('resolveRoundLimit: supplied/current caps are never coerced', () => {
  const config = { roundLimitMode: 'agent', roundLimit: 256, questionTimeoutSeconds: 120 }
  for (const value of [0, -1, 1.5, '5', null, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => resolveRoundLimit(config, value), TypeError, `supplied ${String(value)} should be rejected`)
    assert.throws(() => resolveRoundLimit(config, undefined, value), TypeError, `current ${String(value)} should be rejected`)
  }
  assert.throws(() => resolveRoundLimit({ roundLimitMode: 'yolo' }), TypeError)
})

// ── readConfig (hot plain snapshot) ─────────────────────────────────────────

test('readConfig: missing or null fields take the documented defaults', () => {
  for (const input of [
    undefined,
    null,
    {},
    { roundLimitMode: null, roundLimit: null, questionTimeoutSeconds: null },
  ]) {
    assert.deepEqual(readConfig(input), DEFAULTS)
  }
  assert.deepEqual(readConfig({ roundLimitMode: 'unlimited' }), {
    ...DEFAULTS,
    roundLimitMode: 'unlimited',
  })
})

test('readConfig: volatile fields unwrap and hot updates are read on the next call', () => {
  let mode = 'agent'
  let limit = 256
  let timeout = 120
  const liveRef = (get) => Object.freeze({
    get,
    [VOLATILE_WRITE]: () => {},
  })
  const config = {
    roundLimitMode: liveRef(() => mode),
    roundLimit: liveRef(() => limit),
    questionTimeoutSeconds: liveRef(() => timeout),
  }
  assert.deepEqual(readConfig(config), DEFAULTS)

  mode = 'fixed'
  limit = 1024
  timeout = -1
  const hot = readConfig(config)
  assert.deepEqual(hot, {
    ...DEFAULTS,
    roundLimitMode: 'fixed',
    roundLimit: 1024,
    questionTimeoutSeconds: -1,
  })
  // A fresh plain object per call: callers cannot mutate the live source.
  hot.roundLimit = 5
  assert.equal(readConfig(config).roundLimit, 1024)
  assert.notEqual(readConfig(config), readConfig(config))
})

test('implementation and native policy are validated and read from volatile fields', () => {
  const value = { implementation: 'native', nativeDefaultMaxGoalRounds: 8, nativeBlockedAfterConsecutiveRounds: 2 }
  assert.deepEqual(resolved(value), { ...DEFAULTS, ...value })
  assert.deepEqual(readConfig({
    implementation: volatileRef('native'),
    nativeDefaultMaxGoalRounds: volatileRef(8),
    nativeBlockedAfterConsecutiveRounds: volatileRef(2),
  }), { ...DEFAULTS, ...value })
  for (const invalid of [{ implementation: 'both' }, { nativeDefaultMaxGoalRounds: 0 }, { nativeBlockedAfterConsecutiveRounds: 1.5 }]) {
    assert.throws(() => Config(invalid))
    assert.throws(() => readConfig(invalid))
  }
})

test('readConfig: present values must satisfy the schema boundaries', () => {
  const invalid = [
    { roundLimitMode: 'yolo' },
    { roundLimit: 0 },
    { roundLimit: -1 },
    { roundLimit: 1.5 },
    { roundLimit: '256' },
    { roundLimit: Number.MAX_SAFE_INTEGER + 1 },
    { roundLimit: Number.NaN },
    { questionTimeoutSeconds: 0 },
    { questionTimeoutSeconds: 1.5 },
    { questionTimeoutSeconds: 2147484 },
    { questionTimeoutSeconds: '120' },
  ]
  for (const config of invalid) {
    assert.throws(() => readConfig(config), TypeError, `${JSON.stringify(config)} should be rejected`)
  }
  assert.equal(readConfig({ roundLimit: 1 }).roundLimit, 1)
  assert.equal(readConfig({ roundLimit: UNLIMITED_ROUNDS }).roundLimit, UNLIMITED_ROUNDS)
  assert.equal(readConfig({ questionTimeoutSeconds: -1 }).questionTimeoutSeconds, -1)
  assert.equal(readConfig({ questionTimeoutSeconds: 2147483 }).questionTimeoutSeconds, 2147483)
})

test('canonical implementation and native policy fields preserve existing configuration', () => {
  const existing = { implementation: 'native', nativeDefaultMaxGoalRounds: 17, nativeBlockedAfterConsecutiveRounds: 2 }
  assert.deepEqual(resolved(existing), { ...DEFAULTS, ...existing })
  assert.deepEqual(readConfig(Object.fromEntries(Object.entries(existing).map(([key, value]) => [key, volatileRef(value)]))), { ...DEFAULTS, ...existing })
  for (const implementation of ['better', true, false, 'unknown', 0]) {
    assert.throws(() => Config({ implementation }))
    assert.throws(() => readConfig({ implementation }), /implementation must be enhanced or native/)
  }
  for (const key of ['nativeDefaultMaxGoalRounds', 'nativeBlockedAfterConsecutiveRounds']) {
    for (const value of [0, -1, 1.5, '3', Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
      assert.throws(() => Config({ [key]: value }))
      assert.throws(() => readConfig({ [key]: value }), TypeError)
    }
    for (const value of [1, UNLIMITED_ROUNDS]) {
      assert.equal(resolved({ [key]: value })[key], value)
      assert.equal(readConfig({ [key]: value })[key], value)
    }
  }
})
