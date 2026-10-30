import { z } from 'zod'

/** Read-only history uses its own projection; the native goal protocol stays v6. */
export function createGoalHistoryDefinition(goalDefinition) {
  const Entry = z.object({
    id: z.string(), revision: z.number().int().positive(), objective: z.string(),
    phase: z.enum(['active', 'paused', 'blocked', 'complete']),
    maxGoalRounds: z.number().int().positive(), roundsStarted: z.number().int().nonnegative(),
    createdAt: z.number(), updatedAt: z.number(), cleared: z.boolean(),
    blockedReason: z.object({ code: z.string(), message: z.string() }).optional(),
  })
  const View = z.object({ entries: z.array(Entry), error: z.string().nullable() })
  return {
    key: 'better-goal-history',
    stateVersion: 1,
    stateSchema: z.object({ goalState: goalDefinition.stateSchema, view: View }),
    init: () => ({ goalState: goalDefinition.init(), view: { entries: [], error: null } }),
    apply(state, event) {
      const goalState = goalDefinition.apply(state.goalState, event)
      if (goalState === state.goalState) return state
      if (goalState.failure !== null) {
        return { goalState, view: { entries: state.view.entries, error: goalState.failure } }
      }
      const current = goalState.current
      const previous = state.goalState.current
      const id = current?.goal.id ?? previous?.goal.id
      if (id === undefined) return { ...state, goalState }
      const entry = current === null
        ? { ...previous.goal, roundsStarted: previous.roundsStarted, createdAt: previous.createdAt, updatedAt: event.data.clearedAt, cleared: true }
        : { ...current.goal, roundsStarted: current.roundsStarted, createdAt: current.createdAt, updatedAt: current.updatedAt, cleared: false }
      const index = state.view.entries.findIndex((item) => item.id === id)
      const entries = [...state.view.entries]
      if (index === -1) entries.push(entry)
      else entries[index] = entry
      return { goalState, view: { entries, error: null } }
    },
    wire: { viewSchema: View, view: (state) => state.view },
  }
}
