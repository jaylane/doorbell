import type { State } from '../types'

export const EMPTY: State = {
  lastOkAt: 0,
  lastAttemptAt: 0,
  backoffUntil: 0,
  failures: 0,
  error: null,
  bootstrapped: false,
  items: [],
  seen: {},
  releases: {},
  latest: {},
  pendingShip: {},
}
