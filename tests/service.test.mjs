import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import { SessionStore } from "@deepseek-ai/dsh-session";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { remoteMethods } from "@deepseek-ai/dsh-typert-protocol";

import { readConfig } from "../src/config.js";
import {
  GOAL_CHANGE_VERSION,
  GoalError,
  GoalId,
  GoalService,
  applyGoalProjection,
  decodeGoalChange,
  emptyGoalFoldState,
  foldGoal,
  goalChangeRef,
  goalProjectionDefinition,
} from "../src/service.js";

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const CWD = "/tmp";
const CREATE_KEYS = [
  "createdAt",
  "goal",
  "kind",
  "operation",
  "roundsStarted",
  "updatedAt",
  "version",
];
const CLEAR_KEYS = ["cleared", "clearedAt", "kind", "operation", "version"];
const SNAPSHOT_KEYS = ["id", "maxGoalRounds", "objective", "phase", "revision"];
const BLOCKED_SNAPSHOT_KEYS = [...SNAPSHOT_KEYS, "blockedReason"].sort();

let sessionCounter = 0;

function goalSnapshot(overrides = {}) {
  return {
    id: GoalId("goal-1"),
    revision: 1,
    objective: "Ship it",
    phase: "active",
    maxGoalRounds: 8,
    ...overrides,
  };
}

function snapshotChange(operation, goal, overrides = {}) {
  return {
    kind: "goal/change",
    version: 1,
    operation,
    goal,
    roundsStarted: overrides.roundsStarted ?? 0,
    createdAt: overrides.createdAt ?? 100,
    updatedAt: overrides.updatedAt ?? 100,
  };
}

function clearChange(cleared, overrides = {}) {
  return {
    kind: "goal/change",
    version: 1,
    operation: "clear",
    cleared,
    clearedAt: overrides.clearedAt ?? 100,
  };
}

function goalRound(seq, goal, round) {
  return {
    seq,
    type: "user/message",
    time: 0,
    data: {
      source: {
        kind: "goal",
        goalId: goal.id,
        revision: goal.revision,
        round,
      },
    },
  };
}

function assertGoalError(operation, code, pattern) {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof GoalError, `expected GoalError, got ${error}`);
    assert.equal(error.code, code);
    if (pattern !== undefined) assert.match(error.message, pattern);
    return true;
  });
}

function ref(goal) {
  return { id: goal.id, revision: goal.revision };
}

async function createHarness(options = {}) {
  const ctx = new Context();
  const agents = new Map();
  ctx.provide("agents", {
    get: (id) => agents.get(id),
    roots: () => [...agents.values()],
    currentInitiator: () => undefined,
  });
  if (options.policyProvider !== undefined) {
    ctx.provide("betterGoalConfig", options.policyProvider);
  }

  const storeFork = ctx.plugin(SessionStore);
  const projectionFork = ctx.plugin(SessionProjectionRegistry);
  await Promise.all([storeFork, projectionFork]);

  const goalConfig =
    options.config === undefined
      ? undefined
      : options.config;
  const goalFork =
    goalConfig === undefined
      ? ctx.plugin(GoalService)
      : ctx.plugin(GoalService, goalConfig);
  await goalFork;

  const changes = [];
  const activations = [];
  ctx.on("goal/changed", (payload) => changes.push(payload));
  ctx.on("goal/activation-changed", (payload) => activations.push(payload));

  function newSession(sessionOptions) {
    sessionCounter += 1;
    return ctx.sessions.create(`service-${sessionCounter}`, {
      meta: { cwd: CWD },
      ...(sessionOptions ?? {}),
    });
  }

  function addAgent(session, { announce = true } = {}) {
    const agent = { id: session.id, session, status: "idle" };
    agents.set(agent.id, agent);
    if (announce) ctx.emit("agent/created", { agent, source: { kind: "create" } });
    return agent;
  }

  function addGoalRound(session, goal, round) {
    session.append(
      "user/message",
      createUserMessage({
        content: [{ type: "text", text: `round ${round}` }],
        source: {
          kind: "goal",
          goalId: goal.id,
          revision: goal.revision,
          round,
        },
      }),
      { surfaceOp: "append" },
    );
  }

  async function close() {
    for (const fork of [goalFork, storeFork, projectionFork]) {
      try {
        await fork.dispose();
      } catch {
        // Tests assert observable behavior; cleanup failures must not mask it.
      }
    }
  }

  return {
    ctx,
    agents,
    goals: ctx.goals,
    changes,
    activations,
    newSession,
    addAgent,
    addGoalRound,
    close,
  };
}

test("strict goal/change v1 decoder accepts native snapshots and rejects malformed data", () => {
  assert.equal(GOAL_CHANGE_VERSION, 1);
  assert.equal(GoalId("goal-x"), "goal-x");
  assert.equal(emptyGoalFoldState().roundsStarted, 0);

  const create = snapshotChange("create", goalSnapshot());
  assert.deepEqual(decodeGoalChange(create), create);
  assert.equal(decodeGoalChange(undefined), undefined);
  assert.equal(decodeGoalChange({ kind: "other" }), undefined);

  assert.throws(
    () => decodeGoalChange({ ...create, version: 2 }),
    /unsupported goal change version 2/,
  );
  assert.throws(
    () => decodeGoalChange({ ...create, extra: true }),
    /must have exactly/,
  );
  assert.throws(
    () => decodeGoalChange({ ...create, operation: "delete" }),
    /operation is invalid/,
  );
  assert.throws(
    () => decodeGoalChange({ ...create, updatedAt: 99 }),
    /updatedAt cannot precede createdAt/,
  );
  assert.throws(
    () =>
      decodeGoalChange(
        snapshotChange("create", goalSnapshot({ objective: " padded " })),
      ),
    /objective must be non-empty and normalized/,
  );
  assert.throws(
    () =>
      decodeGoalChange(
        snapshotChange("create", goalSnapshot({ revision: 0 })),
      ),
    /goal\.revision must be a positive safe integer/,
  );
  assert.throws(
    () =>
      decodeGoalChange(
        snapshotChange(
          "create",
          goalSnapshot({
            phase: "blocked",
            blockedReason: { code: "Bad_Code", message: "nope" },
          }),
        ),
      ),
    /lower-kebab-case/,
  );
  assert.throws(
    () =>
      decodeGoalChange(
        snapshotChange(
          "create",
          goalSnapshot({
            phase: "blocked",
            blockedReason: { code: "needs-input", message: " padded " },
          }),
        ),
      ),
    /non-empty and normalized/,
  );
  assert.throws(
    () =>
      decodeGoalChange(
        snapshotChange("create", goalSnapshot({ phase: "blocked" })),
      ),
    /phase blocked must have exactly/,
  );

  const clear = clearChange({ id: "goal-1", revision: 2 });
  assert.deepEqual(decodeGoalChange(clear), clear);
  assert.throws(
    () => decodeGoalChange({ ...clear, clearedAt: -1 }),
    /non-negative safe integer/,
  );
  assert.throws(
    () => decodeGoalChange({ ...clear, cleared: { id: "goal-1", revision: 0 } }),
    /positive safe integer/,
  );
  assert.throws(
    () => decodeGoalChange({ ...clear, extra: true }),
    /must have exactly/,
  );
});

test("strict fold replays native lifecycle, admitted rounds, and clear tombstones", () => {
  const create = snapshotChange("create", goalSnapshot());
  const editedGoal = goalSnapshot({ revision: 2, objective: "Ship v2" });
  const edit = snapshotChange("edit", editedGoal, { updatedAt: 101 });
  const round = goalRound(2, editedGoal, 1);
  const pausedGoal = { ...editedGoal, revision: 3, phase: "paused" };
  const pause = snapshotChange("pause", pausedGoal, {
    roundsStarted: 1,
    updatedAt: 102,
  });
  const resumedGoal = { ...editedGoal, revision: 4, phase: "active" };
  const resume = snapshotChange("resume", resumedGoal, {
    roundsStarted: 1,
    updatedAt: 103,
  });
  const blockedGoal = {
    ...editedGoal,
    revision: 5,
    phase: "blocked",
    blockedReason: { code: "needs-input", message: "Need credentials" },
  };
  const block = snapshotChange("block", blockedGoal, {
    roundsStarted: 1,
    updatedAt: 104,
  });
  const completeGoal = { ...editedGoal, revision: 6, phase: "complete" };
  const complete = snapshotChange("complete", completeGoal, {
    roundsStarted: 1,
    updatedAt: 105,
  });
  const clear = clearChange({ id: "goal-1", revision: 7 }, { clearedAt: 106 });

  const events = (changes) =>
    changes.map((data, seq) => ({ seq, type: "goal/change", time: 0, data }));

  assert.deepEqual(foldGoal([]), { roundsStarted: 0 });
  assert.deepEqual(foldGoal(events([create])), {
    goal: goalSnapshot(),
    roundsStarted: 0,
    createdAt: 100,
    updatedAt: 100,
    lastRef: { id: "goal-1", revision: 1 },
  });
  assert.deepEqual(foldGoal(events([create, edit]).concat(round)), {
    goal: editedGoal,
    roundsStarted: 1,
    createdAt: 100,
    updatedAt: 101,
    lastRef: { id: "goal-1", revision: 2 },
  });
  assert.deepEqual(
    foldGoal(
      events([create, edit]).concat(round, events([pause, resume, block, complete])),
    ),
    {
      goal: completeGoal,
      roundsStarted: 1,
      createdAt: 100,
      updatedAt: 105,
      lastRef: { id: "goal-1", revision: 6 },
    },
  );
  assert.deepEqual(
    foldGoal(
      events([create, edit]).concat(round, events([pause, resume, block, complete, clear])),
    ),
    {
      roundsStarted: 0,
      lastRef: { id: "goal-1", revision: 7 },
    },
  );

  assert.equal(goalChangeRef(create).revision, 1);
  assert.deepEqual(goalChangeRef(clear), { id: "goal-1", revision: 7 });

  assert.throws(
    () => foldGoal(events([create, create])),
    /goal create requires a fresh active revision-one goal/,
  );
  assert.throws(
    () => foldGoal(events([create]).concat(goalRound(1, create.goal, 2))),
    /not the next admitted round/,
  );
  assert.throws(
    () =>
      foldGoal(
        events([create, snapshotChange("edit", { ...editedGoal, phase: "paused" })]),
      ),
    /goal edit cannot change phase or blocked reason/,
  );
  const noRoundCreate = snapshotChange("create", goalSnapshot());
  const noRoundEdit = snapshotChange("edit", editedGoal);
  const noRoundPause = snapshotChange("pause", pausedGoal);
  assert.throws(
    () =>
      foldGoal(
        events([
          noRoundCreate,
          noRoundEdit,
          noRoundPause,
          snapshotChange("pause", { ...pausedGoal, revision: 4 }),
        ]),
      ),
    /goal pause has an invalid phase transition/,
  );
  assert.throws(
    () =>
      foldGoal(
        events([create, clearChange({ id: "goal-1", revision: 2 }, { clearedAt: 99 })]),
      ),
    /clear timestamp cannot precede/,
  );
  assert.throws(
    () => foldGoal(events([clear])),
    /goal clear requires a current goal/,
  );
  assert.throws(
    () =>
      foldGoal(
        events([snapshotChange("create", goalSnapshot({ maxGoalRounds: 1 }))]).concat(
          goalRound(1, goalSnapshot({ maxGoalRounds: 1 }), 1),
          events([
            snapshotChange(
              "resume",
              goalSnapshot({ revision: 2, phase: "active", maxGoalRounds: 1 }),
              { roundsStarted: 1, updatedAt: 101 },
            ),
          ]),
        ),
      ),
    /exhausted round budget/,
  );
});

test("goal projection definition keeps native wire/state schema and stateVersion 6", () => {
  assert.equal(goalProjectionDefinition.key, "goal");
  assert.equal(goalProjectionDefinition.stateVersion, 6);

  const init = goalProjectionDefinition.init();
  assert.deepEqual(init, { current: null, seenGoalIds: [], failure: null });
  assert.equal(goalProjectionDefinition.wire.view(init), null);
  assert.equal(goalProjectionDefinition.wire.viewSchema.parse(null), null);
  assert.equal(goalProjectionDefinition.stateSchema.safeParse(init).success, true);

  const create = snapshotChange("create", goalSnapshot());
  const next = applyGoalProjection(init, { seq: 0, type: "goal/change", data: create });
  assert.deepEqual(next.current, {
    goal: goalSnapshot(),
    roundsStarted: 0,
    createdAt: 100,
    updatedAt: 100,
  });
  assert.deepEqual(next.seenGoalIds, ["goal-1"]);
  assert.equal(next.failure, null);
  assert.equal(goalProjectionDefinition.stateSchema.safeParse(next).success, true);
  assert.deepEqual(goalProjectionDefinition.wire.view(next), next.current);

  const unrelated = { seq: 1, type: "assistant/message", data: {} };
  assert.equal(applyGoalProjection(next, unrelated), next);

  const rejected = applyGoalProjection(next, {
    seq: 2,
    type: "goal/change",
    data: { kind: "goal/change", version: 1, operation: "create" },
  });
  assert.match(rejected.failure, /^goal replay failed at session event 2: /);
  assert.equal(rejected.current, next.current);
  assert.equal(applyGoalProjection(rejected, unrelated), rejected);

  const missingSeen = { ...next, seenGoalIds: [] };
  assert.equal(goalProjectionDefinition.stateSchema.safeParse(missingSeen).success, false);
  const badRounds = {
    ...next,
    current: { ...next.current, roundsStarted: 9 },
  };
  assert.equal(goalProjectionDefinition.stateSchema.safeParse(badRounds).success, false);
});

test("service create commits the native durable snapshot before notifying and arms activation", async (t) => {
  const h = await createHarness({ config: { defaultMaxGoalRounds: MAX_SAFE_INTEGER } });
  t.after(() => h.close());
  const session = h.newSession();
  const agent = h.addAgent(session);
  assert.equal(h.goals.get(agent), undefined);
  assert.equal(session.seq, 0);

  let observedSeq;
  h.ctx.on("goal/changed", () => {
    observedSeq = session.seq;
  });

  const view = h.goals.create(agent, { objective: "  Ship it  " });
  assert.equal(session.seq, 1);
  assert.equal(observedSeq, 1, "goal/changed must fire after the durable append");
  assert.equal(view.objective, "Ship it");
  assert.equal(view.phase, "active");
  assert.equal(view.revision, 1);
  assert.equal(view.roundsStarted, 0);
  assert.equal(view.maxGoalRounds, MAX_SAFE_INTEGER);
  assert.equal(view.activation, "armed");
  assert.equal(view.createdAt, view.updatedAt);

  const event = session.snapshotEvents().at(-1);
  assert.equal(event.type, "goal/change");
  assert.deepEqual(Object.keys(event.data).sort(), [...CREATE_KEYS].sort());
  assert.equal(event.data.kind, "goal/change");
  assert.equal(event.data.version, 1);
  assert.equal(event.data.operation, "create");
  assert.equal(event.data.roundsStarted, 0);
  assert.equal(event.data.createdAt, view.createdAt);
  assert.equal(event.data.updatedAt, view.updatedAt);
  assert.deepEqual(Object.keys(event.data.goal).sort(), SNAPSHOT_KEYS);
  assert.deepEqual(event.data.goal, {
    id: view.id,
    revision: 1,
    objective: "Ship it",
    phase: "active",
    maxGoalRounds: MAX_SAFE_INTEGER,
  });

  assert.equal(h.changes.length, 1);
  assert.equal(h.changes[0].agent, agent);
  assert.deepEqual(h.changes[0].change, {
    operation: "create",
    ref: { id: view.id, revision: 1 },
    goal: view,
  });
  assert.deepEqual(h.activations, [
    {
      sessionId: session.id,
      goal: { id: view.id, revision: 1, activation: "armed" },
    },
  ]);

  const projection = h.ctx.sessionProjections.stateOf(session, "goal");
  assert.deepEqual(projection, {
    current: {
      goal: {
        id: view.id,
        revision: 1,
        objective: "Ship it",
        phase: "active",
        maxGoalRounds: MAX_SAFE_INTEGER,
      },
      roundsStarted: 0,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
    },
    seenGoalIds: [view.id],
    failure: null,
  });
  assert.deepEqual(h.ctx.sessionProjections.snapshot(session).values.goal, projection.current);
});

test("service enforces CAS, live-agent identity, and native validation codes", async (t) => {
  const h = await createHarness({ config: { defaultMaxGoalRounds: MAX_SAFE_INTEGER } });
  t.after(() => h.close());
  const session = h.newSession();
  const agent = h.addAgent(session);

  assertGoalError(
    () => h.goals.get({ id: "not-live", session, status: "idle" }),
    "GOAL_AGENT_NOT_LIVE",
  );
  assertGoalError(
    () => h.goals.pause(agent, { id: "goal-x", revision: 1 }),
    "GOAL_NOT_FOUND",
  );
  assertGoalError(
    () => h.goals.create(agent, { objective: "   " }),
    "GOAL_INVALID_OBJECTIVE",
  );
  assertGoalError(
    () => h.goals.create(agent, { objective: "ok", maxGoalRounds: 0 }),
    "GOAL_INVALID_MAX_ROUNDS",
  );
  assertGoalError(
    () => h.goals.create(agent, { objective: "ok", maxGoalRounds: MAX_SAFE_INTEGER + 1 }),
    "GOAL_INVALID_MAX_ROUNDS",
  );

  const created = h.goals.create(agent, { objective: "first", maxGoalRounds: 3 });
  assertGoalError(
    () => h.goals.create(agent, { objective: "second" }),
    "GOAL_ALREADY_EXISTS",
  );
  assertGoalError(
    () => h.goals.pause(agent, { id: created.id, revision: created.revision + 1 }),
    "GOAL_STALE_REVISION",
  );
  assertGoalError(
    () => h.goals.pause(agent, { id: "goal-other", revision: created.revision }),
    "GOAL_STALE_REVISION",
  );
  assertGoalError(
    () => h.goals.edit(agent, ref(created), {}),
    "GOAL_INVALID_EDIT",
  );
  assertGoalError(
    () => h.goals.edit(agent, ref(created), { objective: "" }),
    "GOAL_INVALID_OBJECTIVE",
  );
  assertGoalError(
    () => h.goals.edit(agent, ref(created), { maxGoalRounds: 0 }),
    "GOAL_INVALID_MAX_ROUNDS",
  );
  assertGoalError(
    () => h.goals.block(agent, ref(created), { code: "Bad Code", message: "no" }),
    "GOAL_INVALID_BLOCK_REASON",
  );
  assertGoalError(
    () => h.goals.block(agent, ref(created), { code: "needs-input", message: "  " }),
    "GOAL_INVALID_BLOCK_REASON",
  );

  const edited = h.goals.edit(agent, ref(created), { objective: "  first edited  " });
  assert.equal(edited.revision, 2);
  assert.equal(edited.objective, "first edited");
  assert.equal(edited.maxGoalRounds, 3);
  assert.equal(edited.roundsStarted, 0);
  assert.equal(edited.activation, "armed");

  const paused = h.goals.pause(agent, ref(edited));
  assert.equal(paused.phase, "paused");
  assert.equal(paused.activation, "disarmed");
  assert.equal(paused.revision, 3);
  assertGoalError(
    () => h.goals.create(agent, { objective: "while paused" }),
    "GOAL_ALREADY_EXISTS",
  );
  assertGoalError(
    () => h.goals.pause(agent, ref(edited)),
    "GOAL_STALE_REVISION",
  );
  assertGoalError(
    () => h.goals.block(agent, ref(paused), { code: "needs-input", message: "not active" }),
    "GOAL_INVALID_TRANSITION",
  );

  const resumed = h.goals.resume(agent, ref(paused));
  assert.equal(resumed.phase, "active");
  assert.equal(resumed.activation, "armed");
  assert.equal(resumed.revision, 4);
  assertGoalError(
    () => h.goals.resume(agent, ref(resumed)),
    "GOAL_INVALID_TRANSITION",
  );

  const completed = h.goals.complete(agent, ref(resumed));
  assert.equal(completed.phase, "complete");
  assert.equal(completed.activation, "disarmed");
  assert.equal(completed.roundsStarted, 0);
  assertGoalError(
    () => h.goals.resume(agent, ref(completed)),
    "GOAL_INVALID_TRANSITION",
  );
  assertGoalError(
    () => h.goals.complete(agent, ref(completed)),
    "GOAL_INVALID_TRANSITION",
  );

  const replacement = h.goals.create(agent, { objective: "second", maxGoalRounds: 2 });
  assert.notEqual(replacement.id, created.id);
  assert.equal(replacement.revision, 1);
  assert.equal(replacement.activation, "armed");

  const cleared = h.goals.clear(agent, ref(replacement));
  assert.deepEqual(cleared, { id: replacement.id, revision: 2 });
  assert.equal(h.goals.get(agent), undefined);
  assertGoalError(
    () => h.goals.pause(agent, { id: replacement.id, revision: 2 }),
    "GOAL_NOT_FOUND",
  );
  const projection = h.ctx.sessionProjections.stateOf(session, "goal");
  assert.equal(projection.current, null);
  assert.deepEqual(projection.seenGoalIds, [created.id, replacement.id]);
  assert.equal(h.changes.at(-1).change.operation, "clear");
  assert.equal(h.changes.at(-1).change.goal, undefined);
  assert.deepEqual(h.changes.at(-1).change.ref, { id: replacement.id, revision: 2 });
  assert.deepEqual(h.activations.at(-1), { sessionId: session.id });
  const clearEvent = session.snapshotEvents().at(-1);
  assert.deepEqual(Object.keys(clearEvent.data).sort(), [...CLEAR_KEYS].sort());
  assert.equal(clearEvent.data.operation, "clear");
  assert.deepEqual(clearEvent.data.cleared, { id: replacement.id, revision: 2 });

  const afterClear = h.goals.create(agent, { objective: "third" });
  assert.equal(afterClear.activation, "armed");
  assert.notEqual(afterClear.id, replacement.id);
});

test("service allows immediate failure and terminal phases without a round gate", async (t) => {
  const h = await createHarness({ config: { defaultMaxGoalRounds: MAX_SAFE_INTEGER } });
  t.after(() => h.close());
  const session = h.newSession();
  const agent = h.addAgent(session);

  const created = h.goals.create(agent, { objective: "fix everything" });
  const blocked = h.goals.block(agent, ref(created), {
    code: "model-reported",
    message: "  Missing provider credentials  ",
  });
  assert.equal(blocked.phase, "blocked");
  assert.equal(blocked.activation, "disarmed");
  assert.equal(blocked.roundsStarted, 0);
  assert.equal(blocked.revision, 2);
  assert.deepEqual(blocked.blockedReason, {
    code: "model-reported",
    message: "Missing provider credentials",
  });
  const blockedEvent = session.snapshotEvents().at(-1);
  assert.deepEqual(Object.keys(blockedEvent.data.goal).sort(), BLOCKED_SNAPSHOT_KEYS);
  assert.equal(blockedEvent.data.operation, "block");
  assert.deepEqual(blockedEvent.data.goal.blockedReason, blocked.blockedReason);
  assert.equal(h.changes.at(-1).change.operation, "block");
  assert.deepEqual(h.ctx.sessionProjections.stateOf(session, "goal").current.goal.blockedReason, blocked.blockedReason);

  const resumed = h.goals.resume(agent, ref(blocked));
  assert.equal(resumed.phase, "active");
  assert.equal(resumed.activation, "armed");
  assert.equal(resumed.blockedReason, undefined);
  assert.equal(resumed.revision, 3);

  const completed = h.goals.complete(agent, ref(resumed));
  assert.equal(completed.phase, "complete");
  assert.equal(completed.activation, "disarmed");
  assert.equal(h.goals.get(agent).phase, "complete");
});

test("service enforces the round budget and admits exactly the next goal round", async (t) => {
  const h = await createHarness({ config: { defaultMaxGoalRounds: MAX_SAFE_INTEGER } });
  t.after(() => h.close());
  const session = h.newSession();
  const agent = h.addAgent(session);

  const created = h.goals.create(agent, { objective: "one round", maxGoalRounds: 1 });
  h.addGoalRound(session, created, 1);
  assert.equal(h.ctx.sessionProjections.stateOf(session, "goal").current.roundsStarted, 1);

  const paused = h.goals.pause(agent, ref(created));
  assertGoalError(
    () => h.goals.resume(agent, ref(paused)),
    "GOAL_INVALID_TRANSITION",
    /exhausted 1 goal rounds/,
  );

  const edited = h.goals.edit(agent, ref(paused), { maxGoalRounds: 2 });
  assert.equal(edited.maxGoalRounds, 2);
  assert.equal(edited.roundsStarted, 1);
  const resumed = h.goals.resume(agent, ref(edited));
  assert.equal(resumed.phase, "active");
  assert.equal(resumed.activation, "armed");
  assert.equal(resumed.roundsStarted, 1);
});

test("edit rejects a cap below admitted rounds without writing or corrupting state", async (t) => {
  const h = await createHarness({ config: { defaultMaxGoalRounds: MAX_SAFE_INTEGER } });
  t.after(() => h.close());
  const session = h.newSession();
  const agent = h.addAgent(session);

  const created = h.goals.create(agent, {
    objective: "three admitted rounds",
    maxGoalRounds: 5,
  });
  for (let round = 1; round <= 3; round += 1) {
    h.addGoalRound(session, created, round);
  }

  const before = h.goals.get(agent);
  assert.equal(before.roundsStarted, 3);
  assert.equal(before.maxGoalRounds, 5);
  const seqBefore = session.seq;
  const projectionBefore = h.ctx.sessionProjections.stateOf(session, "goal");
  assert.equal(goalProjectionDefinition.stateSchema.safeParse(projectionBefore).success, true);
  assert.equal(h.ctx.sessionProjections.snapshot(session).values.goal.roundsStarted, 3);

  assertGoalError(
    () => h.goals.edit(agent, ref(before), { maxGoalRounds: 1 }),
    "GOAL_INVALID_MAX_ROUNDS",
    /already admitted 3 rounds/,
  );

  assert.equal(session.seq, seqBefore, "rejected edit must not append a goal/change event");
  assert.deepEqual(h.goals.get(agent), before, "rejected edit must not change the live view");
  const projectionAfter = h.ctx.sessionProjections.stateOf(session, "goal");
  assert.deepEqual(projectionAfter, projectionBefore);
  assert.equal(goalProjectionDefinition.stateSchema.safeParse(projectionAfter).success, true);
  assert.deepEqual(h.ctx.sessionProjections.snapshot(session).values.goal, projectionAfter.current);
  const checkpoint = h.ctx.sessionProjections.checkpoint(session);
  assert.equal(
    goalProjectionDefinition.stateSchema.safeParse(checkpoint.goal.val).success,
    true,
    "checkpoint state must stay restorable after the rejected edit",
  );
  const restored = h.ctx.sessionProjections.restore(
    checkpoint,
    [],
    session.seq,
    session.header,
    session.inheritedEventCount,
  );
  assert.deepEqual(restored.snapshot.values.goal, projectionBefore.current);

  const atLimit = h.goals.edit(agent, ref(before), { maxGoalRounds: 3 });
  assert.equal(atLimit.maxGoalRounds, 3);
  assert.equal(atLimit.roundsStarted, 3);
  assert.equal(atLimit.revision, before.revision + 1);
  assert.equal(session.seq, seqBefore + 1);
  const projectionAtLimit = h.ctx.sessionProjections.stateOf(session, "goal");
  assert.equal(goalProjectionDefinition.stateSchema.safeParse(projectionAtLimit).success, true);
  assert.equal(h.goals.get(agent).maxGoalRounds, 3);
});

test("service.resume applies a hot fixed cap and arms after a blocker", async (t) => {
  let policyConfig = readConfig({
    roundLimitMode: "fixed",
    roundLimit: 2,
    questionTimeoutSeconds: 120,
  });
  const policyProvider = { get: () => policyConfig };
  const h = await createHarness({
    config: { defaultMaxGoalRounds: MAX_SAFE_INTEGER },
    policyProvider,
  });
  t.after(() => h.close());
  const session = h.newSession();
  const agent = h.addAgent(session);

  const created = h.goals.create(agent, {
    objective: "Host policy resume",
    maxGoalRounds: 5,
  });
  assert.equal(created.maxGoalRounds, 2, "fixed policy must override create input");
  h.addGoalRound(session, created, 1);
  h.addGoalRound(session, created, 2);
  const blocked = h.goals.block(agent, ref(created), {
    code: "model-reported",
    message: "Waiting on the host setting.",
  });
  assert.equal(blocked.phase, "blocked");
  assert.equal(blocked.roundsStarted, 2);
  assert.equal(blocked.maxGoalRounds, 2);

  const seqBefore = session.seq;
  policyConfig = readConfig({
    roundLimitMode: "fixed",
    roundLimit: 3,
    questionTimeoutSeconds: 120,
  });
  const resumed = h.goals.resume(agent, ref(blocked));
  assert.equal(resumed.phase, "active");
  assert.equal(resumed.activation, "armed");
  assert.equal(resumed.roundsStarted, 2);
  assert.equal(resumed.maxGoalRounds, 3);
  assert.equal(resumed.revision, blocked.revision + 2);
  assert.equal(session.seq, seqBefore + 2);

  const changes = session.snapshotEvents().slice(seqBefore);
  assert.deepEqual(changes.map((event) => event.data.operation), ["edit", "resume"]);
  assert.deepEqual(changes.map((event) => event.data.goal.maxGoalRounds), [3, 3]);
  assert.deepEqual(changes.map((event) => event.data.roundsStarted), [2, 2]);
  const projection = h.ctx.sessionProjections.stateOf(session, "goal");
  assert.equal(goalProjectionDefinition.stateSchema.safeParse(projection).success, true);
  assert.equal(projection.current.goal.maxGoalRounds, 3);
  assert.equal(projection.current.roundsStarted, 2);
});

test("service.resume rejects an exhausted hot fixed cap without writing", async (t) => {
  let policyConfig = readConfig({
    roundLimitMode: "fixed",
    roundLimit: 2,
    questionTimeoutSeconds: 120,
  });
  const policyProvider = { get: () => policyConfig };
  const h = await createHarness({
    config: { defaultMaxGoalRounds: MAX_SAFE_INTEGER },
    policyProvider,
  });
  t.after(() => h.close());
  const session = h.newSession();
  const agent = h.addAgent(session);

  const created = h.goals.create(agent, {
    objective: "Host policy exhaustion",
    maxGoalRounds: 5,
  });
  h.addGoalRound(session, created, 1);
  h.addGoalRound(session, created, 2);
  const blocked = h.goals.block(agent, ref(created), {
    code: "model-reported",
    message: "Waiting on the host setting.",
  });
  const before = h.goals.get(agent);
  const seqBefore = session.seq;
  const projectionBefore = h.ctx.sessionProjections.stateOf(session, "goal");

  policyConfig = readConfig({
    roundLimitMode: "fixed",
    roundLimit: 1,
    questionTimeoutSeconds: 120,
  });
  assertGoalError(
    () => h.goals.resume(agent, ref(blocked)),
    "GOAL_INVALID_TRANSITION",
    /exhausted 1 goal rounds/,
  );
  assert.equal(session.seq, seqBefore, "failed resume must not append any goal/change event");
  assert.deepEqual(h.goals.get(agent), before);
  const projectionAfter = h.ctx.sessionProjections.stateOf(session, "goal");
  assert.deepEqual(projectionAfter, projectionBefore);
  assert.equal(goalProjectionDefinition.stateSchema.safeParse(projectionAfter).success, true);
});

test("service applies host fixed policy to UI create and edit caps", async (t) => {
  const policyProvider = {
    get: () => readConfig({
      roundLimitMode: "fixed",
      roundLimit: 7,
      questionTimeoutSeconds: 120,
    }),
  };
  const h = await createHarness({
    config: { defaultMaxGoalRounds: MAX_SAFE_INTEGER },
    policyProvider,
  });
  t.after(() => h.close());
  const session = h.newSession();
  const agent = h.addAgent(session);

  const created = h.goals.create(agent, {
    objective: "UI create",
    maxGoalRounds: 99,
  });
  assert.equal(created.maxGoalRounds, 7);
  const edited = h.goals.edit(agent, ref(created), {
    objective: "UI edit",
    maxGoalRounds: 99,
  });
  assert.equal(edited.maxGoalRounds, 7);
  assert.equal(edited.objective, "UI edit");
  const objectiveOnly = h.goals.edit(agent, ref(edited), {
    objective: "UI edit again",
  });
  assert.equal(objectiveOnly.maxGoalRounds, 7);
});

test("service applies agent and unlimited host policy to create, edit, and resume", async (t) => {
  const agentPolicy = {
    get: () => readConfig({
      roundLimitMode: "agent",
      roundLimit: 256,
      questionTimeoutSeconds: 120,
    }),
  };
  const agentHarness = await createHarness({
    config: { defaultMaxGoalRounds: MAX_SAFE_INTEGER },
    policyProvider: agentPolicy,
  });
  t.after(() => agentHarness.close());
  const agentSession = agentHarness.newSession();
  const agent = agentHarness.addAgent(agentSession);
  const supplied = agentHarness.goals.create(agent, {
    objective: "Agent supplied",
    maxGoalRounds: 5,
  });
  assert.equal(supplied.maxGoalRounds, 5);
  const objectiveOnly = agentHarness.goals.edit(agent, ref(supplied), {
    objective: "Agent objective only",
  });
  assert.equal(objectiveOnly.maxGoalRounds, 5);
  const capEdit = agentHarness.goals.edit(agent, ref(objectiveOnly), {
    maxGoalRounds: 7,
  });
  assert.equal(capEdit.maxGoalRounds, 7);
  const paused = agentHarness.goals.pause(agent, ref(capEdit));
  const seqBefore = agentSession.seq;
  const resumed = agentHarness.goals.resume(agent, ref(paused));
  assert.equal(resumed.phase, "active");
  assert.equal(resumed.activation, "armed");
  assert.equal(resumed.maxGoalRounds, 7);
  assert.equal(agentSession.seq, seqBefore + 1);

  const defaultPolicy = { get: () => readConfig({
    roundLimitMode: "agent",
    roundLimit: 256,
    questionTimeoutSeconds: 120,
  }) };
  const defaultHarness = await createHarness({
    config: { defaultMaxGoalRounds: MAX_SAFE_INTEGER },
    policyProvider: defaultPolicy,
  });
  t.after(() => defaultHarness.close());
  const defaultSession = defaultHarness.newSession();
  const defaultAgent = defaultHarness.addAgent(defaultSession);
  assert.equal(
    defaultHarness.goals.create(defaultAgent, { objective: "Agent default" }).maxGoalRounds,
    MAX_SAFE_INTEGER,
  );

  const unlimitedPolicy = { get: () => readConfig({
    roundLimitMode: "unlimited",
    roundLimit: 256,
    questionTimeoutSeconds: 120,
  }) };
  const unlimitedHarness = await createHarness({
    config: { defaultMaxGoalRounds: MAX_SAFE_INTEGER },
    policyProvider: unlimitedPolicy,
  });
  t.after(() => unlimitedHarness.close());
  const unlimitedSession = unlimitedHarness.newSession();
  const unlimitedAgent = unlimitedHarness.addAgent(unlimitedSession);
  const unlimitedCreated = unlimitedHarness.goals.create(unlimitedAgent, {
    objective: "Unlimited create",
    maxGoalRounds: 99,
  });
  assert.equal(unlimitedCreated.maxGoalRounds, MAX_SAFE_INTEGER);
  const unlimitedEdited = unlimitedHarness.goals.edit(unlimitedAgent, ref(unlimitedCreated), {
    maxGoalRounds: 7,
  });
  assert.equal(unlimitedEdited.maxGoalRounds, MAX_SAFE_INTEGER);
  const unlimitedPaused = unlimitedHarness.goals.pause(unlimitedAgent, ref(unlimitedEdited));
  const unlimitedSeq = unlimitedSession.seq;
  const unlimitedResumed = unlimitedHarness.goals.resume(unlimitedAgent, ref(unlimitedPaused));
  assert.equal(unlimitedResumed.phase, "active");
  assert.equal(unlimitedResumed.activation, "armed");
  assert.equal(unlimitedResumed.maxGoalRounds, MAX_SAFE_INTEGER);
  assert.equal(unlimitedSession.seq, unlimitedSeq + 1);
});

test("disarm removes continuation authority without writing a durable revision", async (t) => {
  const h = await createHarness({ config: { defaultMaxGoalRounds: MAX_SAFE_INTEGER } });
  t.after(() => h.close());
  const session = h.newSession();
  const agent = h.addAgent(session);
  const created = h.goals.create(agent, { objective: "disarm me" });
  assert.equal(created.activation, "armed");
  const seqBefore = session.seq;

  const disarmed = h.goals.disarm(agent);
  assert.equal(disarmed.id, created.id);
  assert.equal(disarmed.revision, created.revision);
  assert.equal(disarmed.phase, "active");
  assert.equal(disarmed.activation, "disarmed");
  assert.equal(session.seq, seqBefore);
  assert.deepEqual(h.activations.at(-1), {
    sessionId: session.id,
    goal: { id: created.id, revision: created.revision, activation: "disarmed" },
  });
  assert.equal(h.goals.get(agent).activation, "disarmed");

  const rearmed = h.goals.resume(agent, ref(disarmed));
  assert.equal(rearmed.activation, "armed");
  assert.equal(rearmed.revision, created.revision + 1);
});

test("session-start agent edges and forks restore durable state disarmed until explicit resume", async (t) => {
  const h = await createHarness({ config: { defaultMaxGoalRounds: MAX_SAFE_INTEGER } });
  t.after(() => h.close());
  const session = h.newSession();
  const agent = h.addAgent(session);
  const created = h.goals.create(agent, { objective: "carry on" });
  h.addGoalRound(session, created, 1);
  assert.equal(h.goals.get(agent).activation, "armed");

  const restartedAgent = { id: session.id, session, status: "idle" };
  h.agents.set(restartedAgent.id, restartedAgent);
  h.ctx.emit("agent/created", { agent: restartedAgent, source: { kind: "resume" } });
  const restarted = h.goals.get(restartedAgent);
  assert.equal(restarted.id, created.id);
  assert.equal(restarted.revision, created.revision);
  assert.equal(restarted.phase, "active");
  assert.equal(restarted.activation, "disarmed");
  assert.equal(restarted.roundsStarted, 1);
  assertGoalError(
    () => h.goals.get(agent),
    "GOAL_AGENT_NOT_LIVE",
  );
  const disarmedSeq = session.seq;
  assert.equal(h.goals.disarm(restartedAgent).activation, "disarmed");
  assert.equal(session.seq, disarmedSeq, "disarm must not write a revision");
  const rearmedParent = h.goals.resume(restartedAgent, ref(restarted));
  assert.equal(rearmedParent.activation, "armed");

  const fork = h.newSession({
    seed: session.snapshotEvents(),
    inheritedEventCount: session.seq,
    meta: {
      cwd: CWD,
      isSeeded: true,
      parentSession: session.id,
    },
  });
  const forkAgent = h.addAgent(fork);
  const inherited = h.goals.get(forkAgent);
  assert.equal(inherited.id, created.id);
  assert.equal(inherited.revision, rearmedParent.revision);
  assert.equal(inherited.phase, "active");
  assert.equal(inherited.activation, "disarmed");
  assert.equal(inherited.roundsStarted, 1);
  assert.equal(h.goals.get(restartedAgent).activation, "armed", "fork must not disarm its parent");
  assert.equal(fork.inheritedEventCount, session.seq);

  const beforeForkSeq = fork.seq;
  const rearmed = h.goals.resume(forkAgent, ref(inherited));
  assert.equal(rearmed.phase, "active");
  assert.equal(rearmed.activation, "armed");
  assert.equal(rearmed.revision, inherited.revision + 1);
  assert.equal(rearmed.roundsStarted, 1);
  assert.equal(fork.seq, beforeForkSeq + 1);
  assert.equal(fork.snapshotEvents().at(-1).data.operation, "resume");

  const forkProjection = h.ctx.sessionProjections.stateOf(fork, "goal");
  assert.equal(forkProjection.current.goal.revision, rearmed.revision);
  assert.equal(
    h.ctx.sessionProjections.stateOf(session, "goal").current.goal.revision,
    rearmedParent.revision,
  );
});

test("retained projection replay failures reject host goal access", async (t) => {
  const h = await createHarness({ config: { defaultMaxGoalRounds: MAX_SAFE_INTEGER } });
  t.after(() => h.close());
  const session = h.newSession();
  const agent = h.addAgent(session);

  session.append("goal/change", {
    kind: "goal/change",
    version: 1,
    operation: "create",
    goal: {
      id: "goal-bad",
      revision: 1,
      objective: "x",
      phase: "active",
      maxGoalRounds: 1,
    },
    roundsStarted: 0,
    createdAt: 1,
    updatedAt: 1,
    extra: true,
  });

  const projection = h.ctx.sessionProjections.stateOf(session, "goal");
  assert.match(
    projection.failure,
    /^goal replay failed at session event 0: goal snapshot change must have exactly/,
  );
  assert.throws(
    () => h.goals.get(agent),
    /goal replay failed at session event 0/,
  );
});

test("service config supplies the create default and supplied caps win", async (t) => {
  const h = await createHarness({ config: { defaultMaxGoalRounds: 42 } });
  t.after(() => h.close());
  const session = h.newSession();
  const agent = h.addAgent(session);

  const defaulted = h.goals.create(agent, { objective: "default cap" });
  assert.equal(defaulted.maxGoalRounds, 42);
  h.goals.clear(agent, ref(defaulted));
  const explicit = h.goals.create(agent, { objective: "explicit cap", maxGoalRounds: 7 });
  assert.equal(explicit.maxGoalRounds, 7);

  const h2 = await createHarness({ config: { defaultMaxGoalRounds: MAX_SAFE_INTEGER } });
  t.after(() => h2.close());
  const session2 = h2.newSession();
  const agent2 = h2.addAgent(session2);
  assert.equal(
    h2.goals.create(agent2, { objective: "sentinel" }).maxGoalRounds,
    MAX_SAFE_INTEGER,
  );
});

test("service exposes the native seven-method Remote contract", async (t) => {
  const h = await createHarness({ config: { defaultMaxGoalRounds: MAX_SAFE_INTEGER } });
  t.after(() => h.close());

  const methods = remoteMethods(h.goals);
  assert.deepEqual(methods, [
    { method: "get", invocation: { kind: "direct" } },
    { method: "edit", invocation: { kind: "direct" } },
    { method: "pause", invocation: { kind: "direct" } },
    { method: "resume", invocation: { kind: "direct" } },
    { method: "complete", invocation: { kind: "direct" } },
    { method: "clear", invocation: { kind: "direct" } },
    {
      method: "remoteExportCreate",
      exportName: "create",
      invocation: { kind: "direct" },
    },
  ]);
  for (const marker of methods) {
    assert.equal(marker.mode, undefined);
    assert.equal(marker.resources, undefined);
  }
  for (const method of [
    "get",
    "edit",
    "pause",
    "resume",
    "complete",
    "clear",
    "remoteExportCreate",
  ]) {
    assert.equal(typeof h.goals[method], "function");
  }
});

test("an absent service config retains the native 256-round default", async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const session = h.newSession();
  const agent = h.addAgent(session);
  assert.equal(h.goals.create(agent, { objective: "native default" }).maxGoalRounds, 256);
});
