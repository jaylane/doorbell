import { expect, test } from 'claude-code/testing'
import { compareNode, data, mergedPr, pending, releaseNode, state } from './fixtures'
import { giveUpCompares, shipped } from '../hooks/triggers/shipped'
import type { Ctx } from '../hooks/triggers/types'
import type { Alias, Item } from '../types'

const cfg = { pollSeconds: 60, fadeMinutes: 5, includeBots: false, notify: true }
const ctx = (over: Partial<Ctx> = {}): Ctx => ({ now: 1000, me: 'me', cfg, prev: state(), failed: new Set(), ...over })
const REPO = 'acme/app'
const cmp: Alias = { kind: 'compare', repo: REPO, tag: 'v2', prId: 'PR9' }
const aliases: Record<string, Alias> = { r0: { kind: 'release', repo: REPO }, c0: cmp }
const waiting = state({
  pendingShip: { PR9: pending(REPO, { number: 9 }) },
  releases: { [REPO]: 'v1' },
  latest: { [REPO]: 'v2' },
})
const run = (st: 'BEHIND' | 'IDENTICAL' | 'AHEAD' | 'DIVERGED' | null, over: Partial<Ctx> = {}) =>
  shipped(data({ merged: { issueCount: 1, nodes: [mergedPr({ id: 'PR9', number: 9 })] }, c0: compareNode(st) }), { c0: cmp }, ctx({ prev: waiting, ...over }))

test('merged PRs enter pendingShip', async () => {
  const out = shipped(data({ merged: { issueCount: 1, nodes: [mergedPr({ id: 'PR9', number: 9 })] } }), {}, ctx())
  expect(out.pendingShip).toEqual({ PR9: pending(REPO, { number: 9 }) })
})

test('a PR already shipped does not re-enter', async () => {
  const out = shipped(data({ merged: { issueCount: 1, nodes: [mergedPr({ id: 'PR9' })] } }), {}, ctx({ prev: state({ seen: { 's:PR9': 1 } }) }))
  expect(out.pendingShip).toEqual({})
})

test('PRs falling out of merged are dropped unless the search failed', async () => {
  const prev = state({ pendingShip: { PR9: pending(REPO) } })
  expect(shipped(data(), {}, ctx({ prev })).pendingShip).toEqual({})
  expect(shipped(data(), {}, ctx({ prev, failed: new Set(['merged']) })).pendingShip).toEqual(prev.pendingShip)
})

test('release alias skips drafts and prereleases', async () => {
  const d = data({ r0: releaseNode([{ tagName: 'v3', isDraft: true }, { tagName: 'v3-rc', isPrerelease: true }, { tagName: 'v2' }]) })
  expect(shipped(d, { r0: aliases.r0! }, ctx()).latest[REPO]).toBe('v2')
})

test('BEHIND marks shipped and notifies', async () => {
  const out = run('BEHIND')
  expect(out.items[0]).toMatchObject({ tag: 'v2', key: 's:PR9', kind: 'shipped', repo: 'app', at: 1000 })
  expect(out.events[0]).toMatchObject({ key: 's:PR9', notify: true, detail: 'v2', label: 'app#9' })
  expect(out.pendingShip.PR9).toBeUndefined()
  expect(out.releases[REPO]).toBe('v2')
})

test('AHEAD and DIVERGED leave the PR waiting and record the tag', async () => {
  for (const s of ['AHEAD', 'DIVERGED'] as const) {
    const out = run(s)
    expect(out.pendingShip.PR9).toBeDefined()
    expect(out.releases[REPO]).toBe('v2')
    expect(out.events).toEqual([])
  }
})

test('deleted tag (ref null) records the tag and leaves the PR waiting', async () => {
  const out = run(null)
  expect(out.pendingShip.PR9).toBeDefined()
  expect(out.releases[REPO]).toBe('v2')
})

test('errored compare keeps the PR waiting and does not record the tag', async () => {
  for (const out of [run('BEHIND', { failed: new Set(['c0']) }), shipped(data({ merged: { issueCount: 1, nodes: [mergedPr({ id: 'PR9', number: 9 })] }, c0: { ref: { compare: null } } }), { c0: cmp }, ctx({ prev: waiting }))]) {
    expect(out.pendingShip.PR9).toBeDefined()
    expect(out.releases[REPO]).toBe('v1')
    expect(out.events).toEqual([])
  }
})

test('first sight of a repo ships silently', async () => {
  const out = run('BEHIND', { prev: state({ ...waiting, releases: {} }) })
  expect(out.items).toEqual([])
  expect(out.events[0]).toMatchObject({ key: 's:PR9', notify: false })
  expect(out.pendingShip.PR9).toBeUndefined()
  expect(out.releases[REPO]).toBe('v2')
})

test('giveUpCompares records every compared repo\'s tag', async () => {
  expect(giveUpCompares(waiting, aliases).releases).toEqual({ [REPO]: 'v2' })
})

test('shipped item fades after fadeMinutes', async () => {
  const it: Item = { key: 's:PR8', kind: 'shipped', prId: 'PR8', repo: 'app', number: 8, title: 't', url: 'u', at: 1000, who: [], count: 1, dim: false, tag: 'v1' }
  const prev = state({ items: [it] })
  expect(shipped(data(), {}, ctx({ prev, now: 1000 + 300_000 - 1, failed: new Set(['merged']) })).items).toEqual([it])
  expect(shipped(data(), {}, ctx({ prev, now: 1000 + 300_000 })).items).toEqual([])
})
