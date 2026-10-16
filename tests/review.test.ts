import { expect, test } from 'claude-code/testing'
import { data, rrPr, state } from './fixtures'
import { isBot } from '../hooks/bots'
import { reviews } from '../hooks/triggers/review'
import type { Ctx } from '../hooks/triggers/types'
import type { Item } from '../types'

const cfg = { pollSeconds: 60, fadeMinutes: 5, includeBots: false, notify: true }
const ctx = (over: Partial<Ctx> = {}): Ctx => ({ now: 500, me: 'me', cfg, prev: state(), failed: new Set(), ...over })
const rr = (...nodes: ReturnType<typeof rrPr>[]) => data({ rr: { issueCount: nodes.length, nodes } })
const item = (over: Partial<Item> = {}): Item => ({
  key: 'rr:PR1:100', kind: 'review', prId: 'PR1', repo: 'app', number: 1, title: 'Add thing',
  url: 'u', at: 100, who: ['alice'], count: 1, dim: false, tag: null, ...over,
})
const team = { reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'Team', slug: 'core' } }] } }

test('direct request on a ready PR notifies', async () => {
  const out = reviews(rr(rrPr()), ctx())
  expect(out.items).toHaveLength(1)
  expect(out.items[0]).toMatchObject({ kind: 'review', dim: false, repo: 'app', who: ['alice'], at: 500 })
  expect(out.events).toEqual([
    { key: 'rr:PR1:500', kind: 'review', notify: true, prId: 'PR1', label: 'app#1', title: 'Add thing', who: 'alice', detail: '' },
  ])
})

test('team request shows dimmed and does not notify', async () => {
  const out = reviews(rr(rrPr(team)), ctx())
  expect(out.items[0]?.dim).toBe(true)
  expect(out.events[0]?.notify).toBe(false)
})

test('draft shows dimmed and does not notify', async () => {
  const out = reviews(rr(rrPr({ isDraft: true })), ctx())
  expect(out.items[0]?.dim).toBe(true)
  expect(out.events[0]?.notify).toBe(false)
})

test('bot-authored PR shows dimmed and does not notify', async () => {
  const pr = rrPr({ author: { login: 'dependabot', __typename: 'Bot' } })
  expect(reviews(rr(pr), ctx())).toEqual({ items: [], events: [] })
  const out = reviews(rr(pr), ctx({ cfg: { ...cfg, includeBots: true } }))
  expect(out.items[0]?.dim).toBe(true)
  expect(out.events[0]?.notify).toBe(false)
})

test('deleted author shows as ghost and counts as a bot', async () => {
  expect(isBot(null)).toBe(true)
  expect(isBot({ login: 'renovate[bot]', __typename: 'User' })).toBe(true)
  const out = reviews(rr(rrPr({ author: null })), ctx({ cfg: { ...cfg, includeBots: true } }))
  expect(out.items[0]?.who).toEqual(['ghost'])
})

test('keeps its key while still requested', async () => {
  const out = reviews(rr(rrPr()), ctx({ now: 999, prev: state({ items: [item()] }) }))
  expect(out.items[0]).toMatchObject({ key: 'rr:PR1:100', at: 100 })
  expect(out.events).toEqual([])
})

test('re-request after leaving gets a new key', async () => {
  const out = reviews(rr(rrPr()), ctx({ now: 999, prev: state({ seen: { 'rr:PR1:100': 900 } }) }))
  expect(out.items[0]?.key).toBe('rr:PR1:999')
  expect(out.events[0]).toMatchObject({ key: 'rr:PR1:999', notify: true })
})

test('a dim request that becomes direct and ready notifies', async () => {
  const out = reviews(rr(rrPr()), ctx({ prev: state({ items: [item({ dim: true })] }) }))
  expect(out.items[0]).toMatchObject({ key: 'rr:PR1:100', dim: false })
  expect(out.events).toHaveLength(1)
  expect(out.events[0]).toMatchObject({ key: 'rr:PR1:100:ready', notify: true })
})

test('failed rr search keeps previous items', async () => {
  const prev = state({ items: [item(), item({ key: 'a:R1', kind: 'approved' })] })
  const out = reviews(rr(), ctx({ prev, failed: new Set(['rr']) }))
  expect(out).toEqual({ items: [item()], events: [] })
})
