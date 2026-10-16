import { expect, test } from 'claude-code/testing'
import { state } from './fixtures'
import { afterFailure, afterSuccess } from '../hooks/backoff'

const NOW = 1_000_000
const rate = (retryAfterMs: number | null, resetAt: number | null) => ({ kind: 'rate' as const, retryAfterMs, resetAt })

test('rate uses retryAfterMs', async () => {
  expect(afterFailure(state(), rate(120000, null), NOW)).toEqual({ backoffUntil: NOW + 120000, failures: 1, error: 'rate' })
})

test('rate falls back to resetAt', async () => {
  expect(afterFailure(state(), rate(null, NOW + 5000), NOW).backoffUntil).toBe(NOW + 5000)
})

test('retryAfter wins over resetAt', async () => {
  expect(afterFailure(state(), rate(1000, NOW + 5000), NOW).backoffUntil).toBe(NOW + 1000)
})

test('rate doubling: failures 0→60s, 1→120s, 5→900s', async () => {
  const wait = (failures: number) => afterFailure(state({ failures }), rate(null, null), NOW).backoffUntil - NOW
  expect(wait(0)).toBe(60_000)
  expect(wait(1)).toBe(120_000)
  expect(wait(5)).toBe(900_000)
})

test('offline waits 15s, 30s, 60s, then 5 min', async () => {
  const wait = (failures: number) => afterFailure(state({ failures }), { kind: 'offline' }, NOW).backoffUntil - NOW
  expect([wait(0), wait(1), wait(2), wait(3), wait(9)]).toEqual([15_000, 30_000, 60_000, 300_000, 300_000])
})

test('offline sets error only once failures reaches 3', async () => {
  const prev = (failures: number) => state({ failures, error: 'partial' })
  expect(afterFailure(prev(0), { kind: 'offline' }, NOW).error).toBe('partial')
  expect(afterFailure(prev(1), { kind: 'offline' }, NOW).error).toBe('partial')
  expect(afterFailure(prev(2), { kind: 'offline' }, NOW).error).toBe('offline')
})

test('auth waits 5 min', async () => {
  expect(afterFailure(state(), { kind: 'auth' }, NOW)).toEqual({ backoffUntil: NOW + 300_000, failures: 1, error: 'auth' })
})

test('query doubles from 60s, capped at 15 min', async () => {
  const q = { kind: 'query' as const, message: 'm' }
  expect(afterFailure(state({ failures: 0 }), q, NOW)).toEqual({ backoffUntil: NOW + 60_000, failures: 1, error: 'query' })
  expect(afterFailure(state({ failures: 2 }), q, NOW).backoffUntil).toBe(NOW + 240_000)
  expect(afterFailure(state({ failures: 8 }), q, NOW).backoffUntil).toBe(NOW + 900_000)
})

test('afterSuccess clears backoff and flags partial', async () => {
  expect(afterSuccess(true)).toEqual({ backoffUntil: 0, failures: 0, error: 'partial' })
  expect(afterSuccess(false)).toEqual({ backoffUntil: 0, failures: 0, error: null })
})
