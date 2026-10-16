import { expect, test } from 'claude-code/testing'
import { data, minePr, state } from './fixtures'
import { approvals } from '../hooks/triggers/approved'
import type { Ctx } from '../hooks/triggers/types'
import type { Author, Item } from '../types'

const cfg = { pollSeconds: 60, fadeMinutes: 5, includeBots: false, notify: true }
const ctx = (over: Partial<Ctx> = {}): Ctx => ({ now: 1000, me: 'me', cfg, prev: state(), failed: new Set(), ...over })
const bob: Author = { login: 'bob', __typename: 'User' }
const pr = (decision: string | null, author: Author = bob, st = 'APPROVED') =>
  data({
    mine: {
      issueCount: 1,
      nodes: [minePr({ reviewDecision: decision, latestOpinionatedReviews: { nodes: [{ id: 'R1', state: st, author }] } })],
    },
  })
const item = (over: Partial<Item> = {}): Item => ({
  key: 'a:R1', kind: 'approved', prId: 'PR1', repo: 'app', fullRepo: 'acme/app', number: 1, title: 'Add thing',
  url: 'u', at: 0, who: ['bob'], count: 1, dim: false, tag: null, ...over,
})

test('human approval appears and notifies with ready to merge', async () => {
  const out = approvals(pr('APPROVED'), ctx())
  expect(out.items[0]).toMatchObject({ key: 'a:R1', kind: 'approved', who: ['bob'], at: 1000 })
  expect(out.events).toEqual([
    { key: 'a:R1', kind: 'approved', notify: true, prId: 'PR1', fullRepo: 'acme/app', label: 'app#1', title: 'Add thing', who: 'bob', detail: 'ready to merge', url: 'https://github.com/acme/app/pull/1', number: 1, excerpt: '' },
  ])
})

test('approval without APPROVED decision has empty detail', async () => {
  expect(approvals(pr('REVIEW_REQUIRED'), ctx()).events[0]?.detail).toBe('')
})

test('bot approval never appears', async () => {
  expect(approvals(pr(null, { login: 'copilot', __typename: 'Bot' }), ctx())).toEqual({ items: [], events: [] })
  expect(approvals(pr(null, null), ctx())).toEqual({ items: [], events: [] })
})

test('own approval never appears', async () => {
  expect(approvals(pr(null, { login: 'me', __typename: 'User' }), ctx())).toEqual({ items: [], events: [] })
})

test('fades fadeMinutes after first seen', async () => {
  const prev = state({ items: [item()], seen: { 'a:R1': 0 } })
  expect(approvals(pr(null), ctx({ now: 299_999, prev })).items).toHaveLength(1)
  expect(approvals(pr(null), ctx({ now: 300_001, prev })).items).toEqual([])
})

test('does not come back after fading', async () => {
  const out = approvals(pr(null), ctx({ prev: state({ seen: { 'a:R1': 900 } }) }))
  expect(out.items).toEqual([])
  expect(out.events).toHaveLength(1)
  expect(out.events[0]?.notify).toBe(false)
})

test('dismissed approval disappears early', async () => {
  const prev = state({ items: [item({ at: 900 })], seen: { 'a:R1': 900 } })
  expect(approvals(pr(null, bob, 'DISMISSED'), ctx({ prev }))).toEqual({ items: [], events: [] })
  expect(approvals(data(), ctx({ prev }))).toEqual({ items: [], events: [] })
})

test('failed mine search keeps unexpired approvals', async () => {
  const prev = state({ items: [item({ at: 900 }), item({ key: 'a:R2', at: -400_000 })] })
  const out = approvals(data(), ctx({ prev, failed: new Set(['mine']) }))
  expect(out.items.map((i) => i.key)).toEqual(['a:R1'])
  expect(out.events).toEqual([])
})
