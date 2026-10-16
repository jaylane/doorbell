import { expect, test } from 'claude-code/testing'
import { compareNode, data, mergedPr, minePr, pending, releaseNode, rrPr, state } from './fixtures'
import { DEFAULT_SETTINGS } from '../hooks/settings'
import { failedSet, notesOf, reduce } from '../hooks/reduce'
import type { Event } from '../hooks/triggers/types'
import type { Alias } from '../types'

const cfg = { pollSeconds: 60, fadeMinutes: 5, includeBots: false, notify: true }
const DAY = 86_400_000
const NOW = 100 * DAY
const user = (login: string) => ({ login, __typename: 'User' })
const ev = (over: Partial<Event>): Event => ({
  key: 'k', kind: 'comment', notify: true, prId: 'PR1', fullRepo: 'acme/app', label: 'app#1', title: 'Fix login', who: 'alice', detail: '', url: 'https://github.com/acme/app/pull/1', number: 1, excerpt: '', ...over,
})
const approved = (id = 'R1') =>
  minePr({ reviewDecision: 'APPROVED', latestOpinionatedReviews: { nodes: [{ id, state: 'APPROVED', author: user('bob') }] } })
const mineData = (...nodes: ReturnType<typeof minePr>[]) => data({ mine: { issueCount: nodes.length, nodes } })
const run = (prev: ReturnType<typeof state>, d = data(), failed: string[] = [], aliases: Record<string, Alias> = {}) =>
  reduce(prev, d, failed, aliases, NOW, cfg, DEFAULT_SETTINGS)

test('a successful poll resets the pathless query failure count', async () => {
  expect(run(state({ pathlessQueryFailures: 1 })).state.pathlessQueryFailures).toBe(0)
})

test('bootstrap records everything seen and sends nothing', async () => {
  const out = run(state(), mineData(approved()))
  expect(out.notes).toEqual([])
  expect(out.state.seen['a:R1']).toBe(NOW)
  expect(out.state.bootstrapped).toBe(true)
  expect(out.state.items).toHaveLength(1)
})

test('only unseen notify events become notes', async () => {
  const out = run(state({ bootstrapped: true, seen: { 'a:R1': 1 } }), mineData(approved('R1'), approved('R2')))
  expect(out.notes).toEqual([{ title: 'app#1 approved', body: 'by bob · ready to merge' }])
})

test('review request notifies with exact copy', async () => {
  const out = run(state({ bootstrapped: true }), data({ rr: { issueCount: 1, nodes: [rrPr({ title: 'Fix login' })] } }))
  expect(out.notes).toEqual([{ title: 'Review requested', body: 'alice wants your review on app#1: Fix login' }])
})

test('exact copy for approved and shipped', async () => {
  expect(notesOf([ev({ kind: 'approved', who: 'alice', detail: 'ready to merge' })])).toEqual([
    { title: 'app#1 approved', body: 'by alice · ready to merge' },
  ])
  expect(notesOf([ev({ kind: 'shipped', who: '', detail: 'v2' })])).toEqual([{ title: 'app#1 shipped', body: 'in v2' }])
})

test('one note per PR', async () => {
  const notes = notesOf([ev({ key: 'c:1', who: 'alice' }), ev({ key: 'c:2', who: 'bob' })])
  expect(notes).toEqual([{ title: 'Comments on app#1', body: 'alice, bob: 2 new' }])
})

test('PRs with the same repo name in different owners stay separate', async () => {
  const notes = notesOf([ev({ prId: 'A' }), ev({ prId: 'B', label: 'app#1' })])
  expect(notes).toHaveLength(2)
})

test('mixed kinds on one PR collapse by priority', async () => {
  const notes = notesOf([ev({ kind: 'comment', key: 'c:1' }), ev({ kind: 'approved', key: 'a:1', who: 'alice' })])
  expect(notes).toEqual([{ title: 'app#1 approved', body: 'by alice · +1 more' }])
})

test('more than 3 PRs collapse into one summary', async () => {
  const notes = notesOf([1, 2, 3, 4].map((n) => ev({ prId: `P${n}`, label: `app#${n}` })))
  expect(notes).toEqual([{ title: '4 PR updates', body: 'app#1, app#2, app#3, app#4' }])
})

test('an approval first seen after sleep shows from first sight', async () => {
  const out = run(state({ bootstrapped: true }), mineData(approved()))
  expect(out.state.items[0]).toMatchObject({ key: 'a:R1', at: NOW })
})

test('overflowed search counts as failed and sets partial', async () => {
  const kept = {
    key: 'c:PR1', kind: 'comment' as const, prId: 'PR1', repo: 'app', fullRepo: 'acme/app', number: 1, title: 't', url: 'u',
    at: 1, who: ['alice'], count: 1, dim: false, tag: null,
  }
  const d = data({ mine: { issueCount: 31, nodes: [] } })
  const out = run(state({ bootstrapped: true, items: [kept] }), d)
  expect(out.state.items).toEqual([kept])
  expect(out.state.error).toBe('partial')
})

test('a failing compare alias does not block other items', async () => {
  const aliases: Record<string, Alias> = {
    c0: { kind: 'compare', repo: 'acme/app', tag: 'v2', prId: 'PR1' },
  }
  const prev = state({ bootstrapped: true, releases: { 'acme/app': 'v1' }, pendingShip: { PR1: pending('acme/app') } })
  const d = { ...mineData(approved()), c0: null, merged: { issueCount: 0, nodes: [mergedPr()] } }
  const out = run(prev, d as ReturnType<typeof data>, ['c0'], aliases)
  expect(out.state.error).toBe('partial')
  expect(out.notes).toEqual([{ title: 'app#1 approved', body: 'by bob · ready to merge' }])
  expect(out.state.pendingShip.PR1).toBeDefined()
})

test('shipped state merges into next state', async () => {
  const aliases: Record<string, Alias> = {
    r0: { kind: 'release', repo: 'acme/app' },
    c0: { kind: 'compare', repo: 'acme/app', tag: 'v2', prId: 'PR1' },
  }
  const prev = state({ bootstrapped: true, releases: { 'acme/app': 'v1' }, pendingShip: { PR1: pending('acme/app') } })
  const d = { ...data(), r0: releaseNode([{ tagName: 'v2' }]), c0: compareNode('BEHIND') }
  const out = run(prev, d as ReturnType<typeof data>, [], aliases)
  expect(out.notes).toEqual([{ title: 'app#1 shipped', body: 'in v2' }])
  expect(out.state.latest['acme/app']).toBe('v2')
  expect(out.state.releases['acme/app']).toBe('v2')
  expect(out.state.pendingShip).toEqual({})
})

test('a long-lived approval does not re-notify after 30 days', async () => {
  const old = NOW - 31 * DAY
  const out = run(state({ bootstrapped: true, seen: { 'a:R1': old } }), mineData(approved()))
  expect(out.notes).toEqual([])
  expect(out.state.seen['a:R1']).toBe(NOW)
})

test('unobserved keys older than 30 days are pruned', async () => {
  const out = run(state({ bootstrapped: true, seen: { gone: NOW - 31 * DAY, recent: NOW - DAY } }))
  expect(out.state.seen).toEqual({ recent: NOW - DAY })
})

test('failedSet flags searches whose issueCount exceeds the page size', async () => {
  const d = data({
    mine: { issueCount: 30, nodes: [] },
    rr: { issueCount: 101, nodes: [] },
    merged: { issueCount: 51, nodes: [] },
  })
  expect([...failedSet(d, ['c0'])].sort()).toEqual(['c0', 'merged', 'rr'])
  expect([...failedSet(data({ rr: { issueCount: 100, nodes: [] } }), [])]).toEqual([])
})

test('null connections read as empty instead of throwing', async () => {
  const mine = minePr({ reviews: null, latestOpinionatedReviews: null, reviewThreads: null, comments: null, commits: null })
  const req = rrPr({ reviewRequests: null })
  const aliases: Record<string, Alias> = { r0: { kind: 'release', repo: 'acme/app' } }
  const d = { ...data({ mine: { issueCount: 1, nodes: [mine] }, rr: { issueCount: 1, nodes: [req] } }), r0: { releases: null } }
  const out = run(state({ bootstrapped: true }), d as ReturnType<typeof data>, [], aliases)
  expect(out.state.items.map((i) => i.kind)).toEqual(['review'])
})

const kindsOff = { ...DEFAULT_SETTINGS, defaults: DEFAULT_SETTINGS.defaults.filter((k) => k !== 'approved') }

test('events of an off kind record seen but send no note', async () => {
  const out = reduce(state({ bootstrapped: true }), mineData(approved()), [], {}, NOW, cfg, kindsOff)
  expect(out.notes).toEqual([])
  expect(out.state.seen['a:R1']).toBe(NOW)
})

test('turning a kind back on shows its items with no note', async () => {
  const d = mineData(approved())
  const off = reduce(state({ bootstrapped: true }), d, [], {}, NOW, cfg, kindsOff)
  const on = reduce(off.state, d, [], {}, NOW, cfg, DEFAULT_SETTINGS)
  expect(off.state.items).toHaveLength(1)
  expect(on.state.items).toHaveLength(1)
  expect(on.notes).toEqual([])
})
