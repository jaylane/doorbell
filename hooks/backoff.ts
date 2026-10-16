import type { State } from '../types'
import type { GhOutcome } from './gh'

type Next = Pick<State, 'backoffUntil' | 'failures' | 'error'>

const doubling = (failures: number) => Math.min(60_000 * 2 ** failures, 900_000)

export const afterFailure = (prev: State, o: Exclude<GhOutcome, { kind: 'ok' }>, now: number): Next => {
  const failures = prev.failures + 1
  switch (o.kind) {
    case 'rate': {
      const until =
        o.retryAfterMs != null ? now + o.retryAfterMs : o.resetAt != null ? o.resetAt : now + doubling(prev.failures)
      return { backoffUntil: until, failures, error: 'rate' }
    }
    case 'offline':
      return {
        backoffUntil: now + ([15_000, 30_000, 60_000][prev.failures] ?? 300_000),
        failures,
        // A blip stays invisible until it has repeated.
        error: failures >= 3 ? 'offline' : prev.error,
      }
    case 'auth':
      return { backoffUntil: now + 300_000, failures, error: 'auth' }
    case 'query':
      return { backoffUntil: now + doubling(prev.failures), failures, error: 'query' }
  }
}

export const afterSuccess = (partial: boolean): Next => ({
  backoffUntil: 0,
  failures: 0,
  error: partial ? 'partial' : null,
})
