import { expect, test } from 'claude-code/testing'
import { state } from './fixtures'
import { shouldPoll } from '../hooks/schedule'

const cfg = { pollSeconds: 60, fadeMinutes: 30, includeBots: false, notify: true }

test('polls when the interval has passed', async () => {
  const s = state({ lastAttemptAt: 0 })
  expect(shouldPoll(s, 0, 60_000, cfg)).toBe(true)
  expect(shouldPoll(s, 0, 59_999, cfg)).toBe(false)
})

test('waits during backoff', async () => {
  expect(shouldPoll(state({ lastAttemptAt: 0, backoffUntil: 100_000 }), 0, 99_999, cfg)).toBe(false)
  expect(shouldPoll(state({ lastAttemptAt: 0, backoffUntil: 100_000 }), 0, 100_000, cfg)).toBe(true)
})

test('polls at once after a sleep gap over 40s', async () => {
  const s = state({ lastAttemptAt: 100_000 })
  expect(shouldPoll(s, 100_000, 141_000, cfg)).toBe(true)
  expect(shouldPoll(s, 100_000, 139_000, cfg)).toBe(false)
})

test('pollSeconds below 30 is treated as 30', async () => {
  const fast = { ...cfg, pollSeconds: 5 }
  const s = state({ lastAttemptAt: 100_000 })
  expect(shouldPoll(s, 100_000, 129_000, fast)).toBe(false)
  expect(shouldPoll(s, 100_000, 130_000, fast)).toBe(true)
})
