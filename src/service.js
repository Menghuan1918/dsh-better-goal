/**
 * Local, native-compatible same-session goal service.
 *
 * This module is an in-package port of the DSH 0.2.1-rc.2 goal domain. It
 * deliberately imports only the public DSH peer packages: the durable
 * `goal/change` v1 schema, replay fold, projection unit, live view, CAS
 * mutations, and activation state stay byte-compatible with the host goal
 * service so the independent plugin can replace the native goal rows without
 * a second durable format.
 *
 * Activation is process-local and intentionally absent from the projection.
 * The root plugin mounts `GoalService` with
 * `defaultMaxGoalRounds: Number.MAX_SAFE_INTEGER`. When the root also provides
 * the optional `betterGoalConfig` service (`{ get() }`), the service applies
 * the host round policy to create/edit/resume; without that provider it keeps
 * the native behavior exactly.
 *
 * @module dsh-better-goal/service
 */
import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { z as zod } from "zod";
import { agentEvents } from "@deepseek-ai/dsh-agent";
import { SessionSeq } from "@deepseek-ai/dsh-session";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import { resolveRoundLimit } from "./config.js";

/** Version of the goal change embedded in a round-zero message source. */
export const GOAL_CHANGE_VERSION = 1;

/**
 * Brand a string as a goal id.
 * @param {string} id - raw goal identifier.
 * @returns {string} the same string with the compile-time brand.
 */
export function GoalId(id) {
  return id;
}

/** Error returned by the goal domain boundary. */
export class GoalError extends HarnessError {
  /**
   * @param {string} message - human-readable rejection reason.
   * @param {string} code - stable machine-routable classification.
   */
  constructor(message, code) {
    super(message, code);
  }
}

/** Durable operations that replace the complete goal snapshot. */
const SNAPSHOT_OPERATIONS = new Set([
  "create",
  "edit",
  "pause",
  "resume",
  "complete",
  "block",
]);

/** Durable lifecycle phases. */
const PHASES = new Set(["active", "paused", "blocked", "complete"]);

/**
 * Build an empty replay accumulator.
 * @returns {object} mutable state with no current goal or prior ref.
 */
export function emptyGoalFoldState() {
  return {
    goal: undefined,
    roundsStarted: 0,
    createdAt: undefined,
    updatedAt: undefined,
    lastRef: undefined,
    seenGoalIds: new Set(),
  };
}

/** Whether a value is a JSON record rather than an array. */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Require one positive safe integer. */
function positiveInteger(value, field) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`goal change ${field} must be a positive safe integer`);
  }
  return value;
}

/** Require one non-negative safe integer. */
function nonNegativeInteger(value, field) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`goal change ${field} must be a non-negative safe integer`);
  }
  return value;
}

/** Decode one canonical blocker explanation. */
function decodeBlockReason(value) {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "code,message"
  ) {
    throw new Error(
      "goal change goal.blockedReason must have exactly code and message fields",
    );
  }
  if (
    typeof value["code"] !== "string" ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value["code"])
  ) {
    throw new Error("goal change goal.blockedReason.code must be lower-kebab-case");
  }
  if (
    typeof value["message"] !== "string" ||
    value["message"].trim().length === 0 ||
    value["message"] !== value["message"].trim()
  ) {
    throw new Error(
      "goal change goal.blockedReason.message must be non-empty and normalized",
    );
  }
  return { code: value["code"], message: value["message"] };
}

/** Decode and validate one snapshot. */
function decodeSnapshot(value) {
  if (!isRecord(value)) throw new Error("goal change goal must be a record");
  if (typeof value["id"] !== "string" || value["id"].length === 0) {
    throw new Error("goal change goal.id must be a non-empty string");
  }
  if (
    typeof value["objective"] !== "string" ||
    value["objective"].trim().length === 0 ||
    value["objective"] !== value["objective"].trim()
  ) {
    throw new Error(
      "goal change goal.objective must be non-empty and normalized",
    );
  }
  if (
    typeof value["phase"] !== "string" ||
    !PHASES.has(value["phase"])
  ) {
    throw new Error("goal change goal.phase is invalid");
  }
  const phase = value["phase"];
  const expectedKeys =
    phase === "blocked"
      ? "blockedReason,id,maxGoalRounds,objective,phase,revision"
      : "id,maxGoalRounds,objective,phase,revision";
  if (Object.keys(value).sort().join(",") !== expectedKeys) {
    throw new Error(
      `goal change goal for phase ${phase} must have exactly ${expectedKeys} fields`,
    );
  }
  const snapshot = {
    id: GoalId(value["id"]),
    revision: positiveInteger(value["revision"], "goal.revision"),
    objective: value["objective"],
    phase,
    maxGoalRounds: positiveInteger(value["maxGoalRounds"], "goal.maxGoalRounds"),
  };
  if (phase === "blocked") {
    snapshot.blockedReason = decodeBlockReason(value["blockedReason"]);
  }
  return snapshot;
}

/** Decode and validate one ref. */
function decodeRef(value) {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "id,revision"
  ) {
    throw new Error(
      "goal clear tombstone must have exactly id and revision fields",
    );
  }
  if (typeof value["id"] !== "string" || value["id"].length === 0) {
    throw new Error("goal clear tombstone id must be a non-empty string");
  }
  return {
    id: GoalId(value["id"]),
    revision: positiveInteger(value["revision"], "cleared.revision"),
  };
}

/**
 * Decode a value that declares itself as a goal change. Unrelated values
 * return `undefined`; malformed goal changes fail replay loudly.
 * @param {unknown} value - candidate source change.
 * @returns {object | undefined} validated goal change or `undefined` for
 *   another value kind.
 */
export function decodeGoalChange(value) {
  if (!isRecord(value) || value["kind"] !== "goal/change") return undefined;
  if (value["version"] !== 1) {
    throw new Error(`unsupported goal change version ${String(value["version"])}`);
  }
  if (value["operation"] === "clear") {
    const allowed = [
      "cleared",
      "clearedAt",
      "kind",
      "operation",
      "version",
    ];
    if (Object.keys(value).sort().join(",") !== allowed.sort().join(",")) {
      throw new Error(
        `goal clear change must have exactly ${allowed.sort().join(",")} fields`,
      );
    }
    return {
      kind: "goal/change",
      version: 1,
      operation: "clear",
      cleared: decodeRef(value["cleared"]),
      clearedAt: nonNegativeInteger(value["clearedAt"], "clearedAt"),
    };
  }
  if (
    typeof value["operation"] !== "string" ||
    !SNAPSHOT_OPERATIONS.has(value["operation"])
  ) {
    throw new Error("goal change operation is invalid");
  }
  const allowed = [
    "createdAt",
    "goal",
    "kind",
    "operation",
    "roundsStarted",
    "updatedAt",
    "version",
  ];
  if (Object.keys(value).sort().join(",") !== allowed.sort().join(",")) {
    throw new Error(
      `goal snapshot change must have exactly ${allowed.sort().join(",")} fields`,
    );
  }
  const createdAt = nonNegativeInteger(value["createdAt"], "createdAt");
  const updatedAt = nonNegativeInteger(value["updatedAt"], "updatedAt");
  if (updatedAt < createdAt) {
    throw new Error("goal change updatedAt cannot precede createdAt");
  }
  return {
    kind: "goal/change",
    version: 1,
    operation: value["operation"],
    goal: decodeSnapshot(value["goal"]),
    roundsStarted: nonNegativeInteger(value["roundsStarted"], "roundsStarted"),
    createdAt,
    updatedAt,
  };
}

/** Narrow model attribution to a valid goal source. */
function goalSource(source) {
  if (source.kind !== "goal") return undefined;
  if (
    typeof source.goalId !== "string" ||
    source.goalId.length === 0 ||
    !Number.isSafeInteger(source.revision) ||
    source.revision < 1 ||
    !Number.isSafeInteger(source.round) ||
    source.round < 1
  ) {
    throw new Error("goal message source is invalid");
  }
  return source;
}

/** Require two snapshots to retain fields that only `edit` may replace. */
function requireSameDefinition(current, next, operation) {
  if (
    next.objective !== current.objective ||
    next.maxGoalRounds !== current.maxGoalRounds
  ) {
    throw new Error(
      `goal ${operation} cannot change objective or maxGoalRounds`,
    );
  }
}

/** Require one exact next revision of the current goal. */
function requireNextRevision(current, next, operation) {
  if (
    next.id !== current.id ||
    next.revision !== current.revision + 1
  ) {
    throw new Error(
      `goal ${operation} must advance the current goal by one revision`,
    );
  }
}

/** Validate one non-create snapshot operation against the preceding projection. */
function validateSnapshotTransition(state, change, current) {
  const next = change.goal;
  requireNextRevision(current, next, change.operation);
  if (state.updatedAt === undefined) {
    throw new Error("current goal fold lacks updatedAt");
  }
  if (
    change.createdAt !== state.createdAt ||
    change.updatedAt < state.updatedAt ||
    change.roundsStarted !== state.roundsStarted
  ) {
    throw new Error(
      `goal ${change.operation} does not preserve the current counters and timestamps`,
    );
  }
  switch (change.operation) {
    case "edit":
      if (
        next.phase !== current.phase ||
        JSON.stringify(next.blockedReason) !==
          JSON.stringify(current.blockedReason)
      ) {
        throw new Error("goal edit cannot change phase or blocked reason");
      }
      break;
    case "pause":
      requireSameDefinition(current, next, change.operation);
      if (current.phase !== "active" || next.phase !== "paused") {
        throw new Error("goal pause has an invalid phase transition");
      }
      break;
    case "resume":
      requireSameDefinition(current, next, change.operation);
      if (
        !new Set(["active", "paused", "blocked"]).has(current.phase) ||
        next.phase !== "active" ||
        state.roundsStarted >= next.maxGoalRounds
      ) {
        throw new Error(
          "goal resume has an invalid phase transition or exhausted round budget",
        );
      }
      break;
    case "complete":
      requireSameDefinition(current, next, change.operation);
      if (current.phase === "complete" || next.phase !== "complete") {
        throw new Error("goal complete has an invalid phase transition");
      }
      break;
    case "block":
      requireSameDefinition(current, next, change.operation);
      if (current.phase !== "active" || next.phase !== "blocked") {
        throw new Error("goal block has an invalid phase transition");
      }
      break;
    case "create":
      throw new Error(
        "goal create cannot be validated as a current-goal transition",
      );
    default:
      throw new Error("unknown goal snapshot operation");
  }
}

/**
 * Return the revision identity carried by a snapshot or tombstone.
 * @param {object} change - decoded goal mutation.
 * @returns {{id: string, revision: number}} stable identity used to
 *   reconcile a deferred change with its log event.
 */
export function goalChangeRef(change) {
  return change.operation === "clear"
    ? change.cleared
    : { id: change.goal.id, revision: change.goal.revision };
}

/**
 * Validate and apply one decoded change to a mutable accumulator.
 * @param {object} state - preceding durable goal projection.
 * @param {object} change - decoded full snapshot or clear tombstone.
 */
export function applyGoalChange(state, change) {
  const ref = goalChangeRef(change);
  if (change.operation === "clear") {
    const current = state.goal;
    if (current === undefined) throw new Error("goal clear requires a current goal");
    requireNextRevision(current, change.cleared, change.operation);
    if (state.updatedAt === undefined) {
      throw new Error("current goal fold lacks updatedAt");
    }
    if (change.clearedAt < state.updatedAt) {
      throw new Error(
        "goal clear timestamp cannot precede the current goal update",
      );
    }
    state.goal = undefined;
    state.roundsStarted = 0;
    state.createdAt = undefined;
    state.updatedAt = undefined;
    state.lastRef = ref;
    return;
  }
  if (change.operation === "create") {
    if (
      change.goal.revision !== 1 ||
      change.goal.phase !== "active" ||
      change.roundsStarted !== 0 ||
      (state.goal !== undefined && state.goal.phase !== "complete") ||
      state.seenGoalIds.has(change.goal.id)
    ) {
      throw new Error(
        "goal create requires a fresh active revision-one goal with zero rounds",
      );
    }
    state.seenGoalIds.add(change.goal.id);
  } else {
    const current = state.goal;
    if (current === undefined) {
      throw new Error(`goal ${change.operation} requires a current goal`);
    }
    validateSnapshotTransition(state, change, current);
  }
  state.goal = change.goal;
  state.roundsStarted = change.roundsStarted;
  state.createdAt = change.createdAt;
  state.updatedAt = change.updatedAt;
  state.lastRef = ref;
}

/**
 * Apply one session event to the strict durable goal fold.
 * @param {object} state - mutable fold accumulator.
 * @param {object} event - next event in sequence order.
 */
export function applyGoalEvent(state, event) {
  if (event.type === "goal/change") {
    const change = decodeGoalChange(event.data);
    if (change === undefined) {
      throw new Error(
        `goal change at session event ${event.seq} has an invalid kind`,
      );
    }
    applyGoalChange(state, change);
    return;
  }
  if (event.type === "user/message") {
    const source = goalSource(event.data.source);
    if (source === undefined) return;
    const current = state.goal;
    if (
      current === undefined ||
      current.phase !== "active" ||
      source.goalId !== current.id ||
      source.revision !== current.revision ||
      source.round !== state.roundsStarted + 1 ||
      source.round > current.maxGoalRounds
    ) {
      throw new Error(
        `goal round at session event ${event.seq} is not the next admitted round of the active goal`,
      );
    }
    state.roundsStarted = source.round;
  }
}

/**
 * Fold current goal state from a contiguous session event log.
 * @param {readonly object[]} events - session events in sequence order.
 * @returns {object} fresh durable projection; activation is deliberately absent.
 */
export function foldGoal(events) {
  const state = emptyGoalFoldState();
  for (const event of events) applyGoalEvent(state, event);
  return {
    ...(state.goal === undefined ? {} : { goal: { ...state.goal } }),
    roundsStarted: state.roundsStarted,
    ...(state.createdAt === undefined ? {} : { createdAt: state.createdAt }),
    ...(state.updatedAt === undefined ? {} : { updatedAt: state.updatedAt }),
    ...(state.lastRef === undefined ? {} : { lastRef: { ...state.lastRef } }),
  };
}

/** Wire payload schema of the `goal` projection. */
const goalProjectionSchema = zod.union([
  zod.object({
    goal: zod.object({
      id: zod.string().min(1),
      revision: zod.number().int().positive(),
      objective: zod.string().min(1),
      phase: zod.union([
        zod.literal("active"),
        zod.literal("paused"),
        zod.literal("blocked"),
        zod.literal("complete"),
      ]),
      blockedReason: zod
        .object({
          code: zod.string(),
          message: zod.string(),
        })
        .optional(),
      maxGoalRounds: zod.number().int().positive(),
    }),
    roundsStarted: zod.number().int().nonnegative(),
    createdAt: zod.number(),
    updatedAt: zod.number(),
  }),
  zod.null(),
]);

/** Strict checkpoint state schema of the `goal` projection. */
const goalProjectionStateSchema = zod
  .object({
    current: goalProjectionSchema,
    seenGoalIds: zod
      .array(zod.string().min(1))
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "seen goal ids must be unique",
      }),
    failure: zod.string().min(1).nullable(),
  })
  .strict()
  .superRefine((state, context) => {
    if (state.current === null) return;
    if (!state.seenGoalIds.includes(state.current.goal.id)) {
      context.addIssue({
        code: "custom",
        message: "current goal id must be retained among seen goal ids",
      });
    }
    if (state.current.updatedAt < state.current.createdAt) {
      context.addIssue({
        code: "custom",
        message: "current goal update cannot precede its creation",
      });
    }
    if (state.current.roundsStarted > state.current.goal.maxGoalRounds) {
      context.addIssue({
        code: "custom",
        message: "current goal rounds cannot exceed its configured limit",
      });
    }
  });

/** Build strict fold state from one checkpoint-safe projection state. */
function goalFoldState(state) {
  return {
    goal: state.current?.goal,
    roundsStarted: state.current?.roundsStarted ?? 0,
    createdAt: state.current?.createdAt,
    updatedAt: state.current?.updatedAt,
    lastRef: undefined,
    seenGoalIds: new Set(state.seenGoalIds),
  };
}

/** Convert strict fold state into checkpoint-safe projection state. */
function goalProjectionState(state) {
  let current = null;
  if (state.goal !== undefined) {
    const { createdAt, updatedAt } = state;
    if (createdAt === undefined || updatedAt === undefined) {
      throw new Error("current goal fold lacks timestamps");
    }
    current = {
      goal: state.goal,
      roundsStarted: state.roundsStarted,
      createdAt,
      updatedAt,
    };
  }
  return {
    current,
    seenGoalIds: [...state.seenGoalIds],
    failure: null,
  };
}

/**
 * Fold durable goal events through the strict replay rules without throwing
 * from the projection registry's event drive. The first invalid owned event
 * is retained in `failure`; host goal access rejects that state while the
 * client view remains at the last valid goal.
 * @param {object} state - the projection covering all prior events.
 * @param {object} event - the next committed session event.
 * @returns {object} the next projection (same reference when the event is
 *   unrelated).
 */
export function applyGoalProjection(state, event) {
  if (state.failure !== null) return state;
  if (
    event.type !== "goal/change" &&
    (event.type !== "user/message" || event.data.source.kind !== "goal")
  ) {
    return state;
  }
  const folded = goalFoldState(state);
  try {
    applyGoalEvent(folded, event);
    return goalProjectionState(folded);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...state,
      failure: `goal replay failed at session event ${event.seq}: ${message}`,
    };
  }
}

/** Strict host goal state with the native cropped client value. */
export const goalProjectionDefinition = {
  key: "goal",
  stateSchema: goalProjectionStateSchema,
  init: () => ({
    current: null,
    seenGoalIds: [],
    failure: null,
  }),
  apply: applyGoalProjection,
  wire: {
    viewSchema: goalProjectionSchema,
    view: (state) => state.current,
  },
  stateVersion: 6,
};

/**
 * Validate a caller-visible positive safe-integer round cap.
 * @param {unknown} value - candidate cap.
 * @returns {number} the validated cap.
 */
export function resolveMaxGoalRounds(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GoalError(
      "maxGoalRounds must be a positive safe integer",
      "GOAL_INVALID_MAX_ROUNDS",
    );
  }
  return value;
}

/**
 * Validate and normalize an objective at the domain boundary.
 * @param {unknown} value - candidate objective.
 * @returns {string} the trimmed objective.
 */
export function resolveObjective(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GoalError(
      "goal objective must be a non-empty string",
      "GOAL_INVALID_OBJECTIVE",
    );
  }
  return value.trim();
}

/**
 * Materialize deployment defaults and validate one create request.
 * @param {{objective?: unknown, maxGoalRounds?: unknown}} request - create input.
 * @param {number} defaultMaxGoalRounds - deployment default.
 * @returns {{objective: string, maxGoalRounds: number}} normalized create input.
 */
export function resolveCreateGoal(request, defaultMaxGoalRounds) {
  return {
    objective: resolveObjective(request.objective),
    maxGoalRounds: resolveMaxGoalRounds(
      request.maxGoalRounds ?? defaultMaxGoalRounds,
    ),
  };
}

/**
 * Validate and detach one policy-owned blocker explanation.
 * @param {unknown} reason - candidate `{ code, message }`.
 * @returns {{code: string, message: string}} normalized reason.
 */
export function resolveBlockReason(reason) {
  const record =
    typeof reason === "object" && reason !== null && !Array.isArray(reason)
      ? reason
      : undefined;
  const code = record?.["code"];
  const message = record?.["message"];
  if (
    typeof code !== "string" ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(code) ||
    typeof message !== "string" ||
    message.trim().length === 0
  ) {
    throw new GoalError(
      "goal block reason requires a lower-kebab-case code and a non-empty message",
      "GOAL_INVALID_BLOCK_REASON",
    );
  }
  return { code, message: message.trim() };
}

/**
 * Goal service (`ctx.goals`) backed exclusively by the owning session log.
 *
 * Public API and events mirror the native host service. The root plugin
 * supplies `defaultMaxGoalRounds: Number.MAX_SAFE_INTEGER`; per-operation
 * policy is resolved by the tool/command/driver layer before service calls.
 */
export class GoalService extends TypertRemoteService {
  static inject = ["agents", "sessionProjections"];

  static Config = z.object({ defaultMaxGoalRounds: z.number().default(256) });

  constructor(ctx, config = {}) {
    super(ctx, "goals");
    this.resolved = {
      defaultMaxGoalRounds: resolveMaxGoalRounds(
        config.defaultMaxGoalRounds ?? 256,
      ),
    };
    this.runtimeStates = new WeakMap();
    ctx.on("agent/created", ({ agent }) => {
      this.setActivation(agent.session, "disarmed");
    });
    ctx.sessionProjections.register(goalProjectionDefinition);
    ctx.on("session/event", (session, event) => {
      if (event.type !== "goal/change") return;
      const runtime = this.runtimeState(session);
      const activation =
        runtime.pendingActivation !== undefined &&
        SessionSeq(runtime.pendingActivation.offset) === event.seq
          ? runtime.pendingActivation.activation
          : "disarmed";
      this.setActivation(session, activation);
    });
  }

  /**
   * Read the current goal for one exact live agent.
   * @param {object} agent - owning live agent.
   * @returns {object | undefined} a fresh view or `undefined` when no goal is
   *   current.
   * @throws {GoalError} when the agent is not the registry's live instance.
   */
  get(agent) {
    this.assertLive(agent);
    return this.view(this.state(agent.session), this.runtimeState(agent.session));
  }

  /**
   * Remove process-local continuation authority without changing durable goal
   * phase or revision. A later explicit `resume` records the new activation
   * edge.
   * @param {object} agent - owning live agent.
   * @returns {object | undefined} a fresh disarmed view, or `undefined` when no
   *   goal is current.
   */
  disarm(agent) {
    this.assertLive(agent);
    this.setActivation(agent.session, "disarmed");
    const runtime = this.runtimeState(agent.session);
    return this.view(this.state(agent.session), runtime);
  }

  /**
   * Create and arm a goal. A completed goal may be replaced; every other
   * current phase must be cleared or resumed instead.
   * @param {object} agent - owning live agent.
   * @param {{objective: string, maxGoalRounds?: number}} request - objective
   *   and optional round cap.
   * @returns {object} the created live view.
   */
  create(agent, request) {
    const hostConfig = this.hostGoalConfig();
    const spec = hostConfig === undefined
      ? resolveCreateGoal(request, this.resolved.defaultMaxGoalRounds)
      : {
          objective: resolveObjective(request.objective),
          maxGoalRounds: resolveRoundLimit(hostConfig, request.maxGoalRounds),
        };
    const [state, runtime] = this.prepareMutation(agent);
    const current = state?.goal;
    if (current !== undefined && current.phase !== "complete") {
      throw new GoalError(
        `goal "${current.id}" already exists with phase "${current.phase}"`,
        "GOAL_ALREADY_EXISTS",
      );
    }
    const now = Date.now();
    const goal = {
      id: GoalId(`goal-${randomUUID()}`),
      revision: 1,
      objective: spec.objective,
      phase: "active",
      maxGoalRounds: spec.maxGoalRounds,
    };
    return this.commitSnapshot(
      agent,
      runtime,
      "create",
      goal,
      0,
      now,
      now,
      "armed",
    );
  }

  /**
   * Edit objective and/or round cap without changing phase.
   * @param {object} agent - owning live agent.
   * @param {{id: string, revision: number}} ref - expected current revision.
   * @param {{objective?: string, maxGoalRounds?: number}} request - at least
   *   one replacement field.
   * @returns {object} the edited view.
   */
  edit(agent, ref, request) {
    const [state, runtime] = this.prepareMutation(agent);
    const currentState = this.expectCurrent(state, ref);
    const current = currentState.goal;
    if (request.objective === undefined && request.maxGoalRounds === undefined) {
      throw new GoalError(
        "goal edit requires objective and/or maxGoalRounds",
        "GOAL_INVALID_EDIT",
      );
    }
    const hostConfig = this.hostGoalConfig();
    const maxGoalRounds = hostConfig === undefined
      ? request.maxGoalRounds === undefined
        ? current.maxGoalRounds
        : resolveMaxGoalRounds(request.maxGoalRounds)
      : resolveRoundLimit(hostConfig, request.maxGoalRounds, current.maxGoalRounds);
    // The projection rejects roundsStarted > maxGoalRounds on checkpoint restore;
    // rejecting here keeps the durable log and its checkpoint schema-valid.
    if (currentState.roundsStarted > maxGoalRounds) {
      throw new GoalError(
        `goal "${current.id}" already admitted ${currentState.roundsStarted} rounds; maxGoalRounds cannot be lower than ${currentState.roundsStarted}`,
        "GOAL_INVALID_MAX_ROUNDS",
      );
    }
    const goal = {
      ...current,
      revision: current.revision + 1,
      ...(request.objective === undefined
        ? {}
        : { objective: resolveObjective(request.objective) }),
      ...(hostConfig !== undefined || request.maxGoalRounds !== undefined
        ? { maxGoalRounds }
        : {}),
    };
    return this.commitCurrent(
      agent,
      currentState,
      runtime,
      "edit",
      goal,
      runtime.activation,
    );
  }

  /**
   * Pause an active goal and disarm automatic continuation.
   * @param {object} agent - owning live agent.
   * @param {{id: string, revision: number}} ref - expected current revision.
   * @returns {object} the paused view.
   */
  pause(agent, ref) {
    return this.transition(
      agent,
      ref,
      "pause",
      ["active"],
      "paused",
      "disarmed",
    );
  }

  /**
   * Resume and arm a stopped goal, or rearm an active goal after a
   * session-start edge, while its round budget still has capacity.
   * @param {object} agent - owning live agent.
   * @param {{id: string, revision: number}} ref - expected current revision.
   * @returns {object} the active view.
   */
  resume(agent, ref) {
    const [state, runtime] = this.prepareMutation(agent);
    const currentState = this.expectCurrent(state, ref);
    const current = currentState.goal;
    const resumable = ["active", "paused", "blocked"];
    if (!resumable.includes(current.phase)) {
      throw this.transitionError(current, "resume", resumable);
    }
    if (current.phase === "active" && runtime.activation === "armed") {
      throw new GoalError(
        `goal "${current.id}" is already active and armed`,
        "GOAL_INVALID_TRANSITION",
      );
    }
    const hostConfig = this.hostGoalConfig();
    const maxGoalRounds = hostConfig === undefined
      ? current.maxGoalRounds
      : resolveRoundLimit(hostConfig, undefined, current.maxGoalRounds);
    if (currentState.roundsStarted >= maxGoalRounds) {
      throw new GoalError(
        `goal "${current.id}" exhausted ${maxGoalRounds} goal rounds; increase maxGoalRounds before resuming`,
        "GOAL_INVALID_TRANSITION",
      );
    }
    if (maxGoalRounds !== current.maxGoalRounds) {
      // Raise/align the stored cap before resuming. Both commits happen only
      // after every policy and phase check above has passed.
      this.commitCurrent(
        agent,
        currentState,
        runtime,
        "edit",
        {
          ...current,
          revision: current.revision + 1,
          maxGoalRounds,
        },
        runtime.activation,
      );
      const afterEdit = this.state(agent.session);
      return this.commitCurrent(
        agent,
        afterEdit,
        runtime,
        "resume",
        this.withPhase(afterEdit.goal, "active"),
        "armed",
      );
    }
    return this.commitCurrent(
      agent,
      currentState,
      runtime,
      "resume",
      this.withPhase(current, "active"),
      "armed",
    );
  }

  /**
   * Mark a current non-complete goal complete and disarm it.
   * @param {object} agent - owning live agent.
   * @param {{id: string, revision: number}} ref - expected current revision.
   * @returns {object} the completed view.
   */
  complete(agent, ref) {
    return this.transition(
      agent,
      ref,
      "complete",
      ["active", "paused", "blocked"],
      "complete",
      "disarmed",
    );
  }

  /**
   * Mark an active goal blocked and disarm it. This is the durable operation
   * behind the model-facing `fail` action; the caller supplies the concrete
   * policy-owned reason.
   * @param {object} agent - owning live agent.
   * @param {{id: string, revision: number}} ref - expected current revision.
   * @param {{code: string, message: string}} reason - stable code and
   *   human-readable explanation.
   * @returns {object} the blocked view with its durable reason.
   */
  block(agent, ref, reason) {
    const [state, runtime] = this.prepareMutation(agent);
    const currentState = this.expectCurrent(state, ref);
    const current = currentState.goal;
    if (current.phase !== "active") {
      throw this.transitionError(current, "block", ["active"]);
    }
    return this.commitCurrent(
      agent,
      currentState,
      runtime,
      "block",
      {
        ...this.withPhase(current, "blocked"),
        blockedReason: resolveBlockReason(reason),
      },
      "disarmed",
    );
  }

  /**
   * Clear the current goal while retaining a durable tombstone and history.
   * @param {object} agent - owning live agent.
   * @param {{id: string, revision: number}} ref - expected current revision.
   * @returns {{id: string, revision: number}} the tombstone ref whose revision
   *   is one past the cleared snapshot.
   */
  clear(agent, ref) {
    const [state, runtime] = this.prepareMutation(agent);
    const currentState = this.expectCurrent(state, ref);
    const current = currentState.goal;
    const tombstone = { id: current.id, revision: current.revision + 1 };
    const change = {
      kind: "goal/change",
      version: 1,
      operation: "clear",
      cleared: tombstone,
      clearedAt: this.nextMutationTime(currentState),
    };
    this.commit(agent, runtime, change, "disarmed");
    return { ...tombstone };
  }

  /**
   * Read the optional host round-policy provider. `undefined` preserves the
   * native baseline; a present provider must expose a synchronous `get()`.
   * @returns {object | undefined} the current plain configuration snapshot.
   */
  hostGoalConfig() {
    const provider = this.ctx.get("betterGoalConfig");
    if (provider === undefined) return undefined;
    if (typeof provider.get !== "function") {
      throw new TypeError("betterGoalConfig provider must expose get()");
    }
    return provider.get();
  }

  /** Resolve the durable and process-local state used by a mutation. */
  prepareMutation(agent) {
    this.assertLive(agent);
    return [this.state(agent.session), this.runtimeState(agent.session)];
  }

  /** Reject stale or missing current-state refs. */
  expectCurrent(state, ref) {
    if (state === null) {
      throw new GoalError("no current goal", "GOAL_NOT_FOUND");
    }
    const current = state.goal;
    if (ref.id !== current.id || ref.revision !== current.revision) {
      throw new GoalError(
        `stale goal ref "${ref.id}" revision ${ref.revision}; current is "${current.id}" revision ${current.revision}`,
        "GOAL_STALE_REVISION",
      );
    }
    return state;
  }

  /** Enforce exact live-agent identity rather than trusting a matching id. */
  assertLive(agent) {
    if (this.ctx.agents.get(agent.id) !== agent) {
      throw new GoalError(
        `agent "${agent.id}" is not live in this registry`,
        "GOAL_AGENT_NOT_LIVE",
      );
    }
  }

  /** Read the current durable projection maintained by the registry. */
  state(session) {
    const state = this.ctx.sessionProjections.stateOf(session, "goal");
    if (state === undefined) {
      throw new Error("goal projection is not registered");
    }
    if (state.failure !== null) throw new Error(state.failure);
    return state.current;
  }

  /** Return the process-local activation state, initially disarmed. */
  runtimeState(session) {
    let runtime = this.runtimeStates.get(session);
    if (runtime !== undefined) return runtime;
    runtime = { activation: "disarmed", pendingActivation: undefined };
    this.runtimeStates.set(session, runtime);
    return runtime;
  }

  /** Publish one process-local activation edge when it actually changes. */
  setActivation(session, activation) {
    const runtime = this.runtimeState(session);
    if (runtime.activation === activation) return;
    runtime.activation = activation;
    const state = this.ctx.sessionProjections.stateOf(session, "goal");
    if (state === undefined) return;
    if (state.failure !== null) return;
    const goal = this.view(state.current, runtime);
    this.ctx.emit("goal/activation-changed", {
      sessionId: session.id,
      ...(goal === undefined
        ? {}
        : {
            goal: {
              id: goal.id,
              revision: goal.revision,
              activation: goal.activation,
            },
          }),
    });
  }

  /** Build a new revision with one replacement phase. */
  withPhase(current, phase) {
    return {
      id: current.id,
      revision: current.revision + 1,
      objective: current.objective,
      phase,
      maxGoalRounds: current.maxGoalRounds,
    };
  }

  /** Shared validated phase transition. */
  transition(agent, ref, operation, allowed, phase, activation) {
    const [state, runtime] = this.prepareMutation(agent);
    const currentState = this.expectCurrent(state, ref);
    const current = currentState.goal;
    if (!allowed.includes(current.phase)) {
      throw this.transitionError(current, operation, allowed);
    }
    return this.commitCurrent(
      agent,
      currentState,
      runtime,
      operation,
      this.withPhase(current, phase),
      activation,
    );
  }

  /** Render a stable invalid-transition error. */
  transitionError(current, operation, allowed) {
    return new GoalError(
      `cannot ${operation} goal "${current.id}" from phase "${current.phase}"; expected ${allowed.join(" or ")}`,
      "GOAL_INVALID_TRANSITION",
    );
  }

  /** Commit a mutation that retains the current goal's derived counters/times. */
  commitCurrent(agent, state, runtime, operation, goal, activation) {
    return this.commitSnapshot(
      agent,
      runtime,
      operation,
      goal,
      state.roundsStarted,
      state.createdAt,
      this.nextMutationTime(state),
      activation,
    );
  }

  /** Clamp a current goal's next timestamp across backward wall-clock movement. */
  nextMutationTime(state) {
    return Math.max(Date.now(), state.updatedAt);
  }

  /** Build and commit one full-snapshot mutation. */
  commitSnapshot(
    agent,
    runtime,
    operation,
    goal,
    roundsStarted,
    createdAt,
    updatedAt,
    activation,
  ) {
    const change = {
      kind: "goal/change",
      version: 1,
      operation,
      goal,
      roundsStarted,
      createdAt,
      updatedAt,
    };
    this.commit(agent, runtime, change, activation);
    return {
      ...goal,
      roundsStarted,
      createdAt,
      updatedAt,
      activation: runtime.activation,
    };
  }

  /** Commit one mutation into the goal log and live event stream. */
  commit(agent, runtime, change, activation) {
    const ref = goalChangeRef(change);
    runtime.pendingActivation = {
      offset: agent.session.seq,
      activation,
    };
    try {
      const event = agent.session.append("goal/change", change);
      if (SessionSeq(runtime.pendingActivation.offset) === event.seq) {
        runtime.activation = activation;
      }
    } finally {
      runtime.pendingActivation = undefined;
    }
    const goal = this.view(this.state(agent.session), runtime);
    const notification = {
      operation: change.operation,
      ref: { ...ref },
      ...(goal === undefined ? {} : { goal }),
    };
    agentEvents(this.ctx, agent).emit("goal/changed", { change: notification });
  }

  /** Build a detached current view. */
  view(state, runtime) {
    if (state === null) return undefined;
    return {
      ...state.goal,
      roundsStarted: state.roundsStarted,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      activation: runtime.activation,
    };
  }

  /**
   * Create one Goal through the remote boundary. Retained for the native
   * service-RPC contract; commands remain the human-facing path.
   * @param {object} agent - exact live agent resolved from the wire identity.
   * @param {{objective: string, maxGoalRounds?: number}} request - objective
   *   and optional round cap.
   * @returns {{ref: {id: string, revision: number}}} the created Goal identity.
   */
  remoteExportCreate(agent, request) {
    const view = this.create(agent, request);
    return { ref: { id: view.id, revision: view.revision } };
  }
}

/**
 * Attach one native public Remote marker without a TypeScript decorator
 * transform. Markers mirror the native host contract so the existing UI can
 * call service RPC (with no code generation); commands remain the
 * human-facing path.
 * @param {object} prototype - live Service class prototype.
 * @param {string} method - public instance method name.
 * @param {string} exportName - wire method name.
 */
function markRemoteMethod(prototype, method, exportName = method) {
  const decorate = Remote(exportName);
  const receiver = Object.create(prototype);
  decorate(prototype[method], {
    private: false,
    static: false,
    name: method,
    addInitializer(initializer) {
      initializer.call(receiver);
    },
  });
}

markRemoteMethod(GoalService.prototype, "get");
markRemoteMethod(GoalService.prototype, "edit");
markRemoteMethod(GoalService.prototype, "pause");
markRemoteMethod(GoalService.prototype, "resume");
markRemoteMethod(GoalService.prototype, "complete");
markRemoteMethod(GoalService.prototype, "clear");
markRemoteMethod(GoalService.prototype, "remoteExportCreate", "create");

export default GoalService;
