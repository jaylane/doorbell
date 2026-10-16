import { expect, test } from 'claude-code/testing'
import { data, minePr, state } from './fixtures'
import { comments } from '../hooks/triggers/comments'
import type { Ctx } from '../hooks/triggers/types'
import type { Item, MinePr } from '../types'

const cfg = { pollSeconds: 60, fadeMinutes: 5, includeBots: false, notify: true }
const ctx = (over: Partial<Ctx> = {}): Ctx => ({ now: 500, me: 'me', cfg, prev: state(), failed: new Set(), ...over })
const mine = (...nodes: MinePr[]) => data({ mine: { issueCount: nodes.length, nodes } })
const iso = (n: number) => new Date(n).toISOString()
const user = (login: string) => ({ login, __typename: 'User' })
const ic = (id: string, login: string, t: number, viewerDidAuthor = false) => ({
  id, viewerDidAuthor, createdAt: iso(t), author: user(login),
})
const thread = (...c: ReturnType<typeof ic>[]) => ({ comments: { nodes: c } })
const rv = (id: string, login: string, t: number, st: string, bodyText: string) => ({
  id, state: st, bodyText, viewerDidAuthor: false, createdAt: iso(t), author: user(login),
})
const push = (login: string, t: number) => ({
  commits: { nodes: [{ commit: { committedDate: iso(t), author: { user: { login } } } }] },
})

test('human issue comment after my last activity shows and notifies', async () => {
  const out = comments(mine(minePr({ comments: { nodes: [ic('IC1', 'alice', 10)] } })), ctx())
  expect(out.items).toHaveLength(1)
  expect(out.items[0]).toMatchObject({ key: 'c:PR1', kind: 'comment', count: 1, who: ['alice'], repo: 'app', at: 500, dim: false, tag: null })
  expect(out.events).toEqual([
    { key: 'c:IC1', kind: 'comment', notify: true, prId: 'PR1', label: 'app#1', title: 'Add thing', who: 'alice', detail: '' },
  ])
})

test('my reply anywhere on the PR clears earlier comments', async () => {
  const pr = minePr({ reviewThreads: { nodes: [thread(ic('T1', 'alice', 10))] }, comments: { nodes: [ic('IC2', 'me', 20, true)] } })
  expect(comments(mine(pr), ctx()).items).toHaveLength(0)
})

test('a reviewer replying after my reply shows again', async () => {
  const pr = minePr({ comments: { nodes: [ic('A', 'alice', 10), ic('M', 'me', 20, true), ic('B', 'bob', 30)] } })
  const out = comments(mine(pr), ctx())
  expect(out.items[0]).toMatchObject({ count: 1, who: ['bob'] })
})

test('my push clears earlier comments', async () => {
  const pr = minePr({ ...push('me', 30), comments: { nodes: [ic('A', 'alice', 20)] } })
  expect(comments(mine(pr), ctx()).items).toHaveLength(0)
})

test('a comment after my push shows even if polled much later', async () => {
  const pr = minePr({ ...push('me', 30), comments: { nodes: [ic('A', 'alice', 40)] } })
  expect(comments(mine(pr), ctx({ now: 3_600_000 })).items[0]?.count).toBe(1)
})

test("a teammate's push does not clear my comments", async () => {
  const pr = minePr({ ...push('carol', 30), comments: { nodes: [ic('A', 'alice', 20)] } })
  expect(comments(mine(pr), ctx()).items[0]?.count).toBe(1)
})

test('changes requested counts; empty COMMENTED and APPROVED with body do not', async () => {
  const pr = minePr({
    reviews: {
      nodes: [
        rv('R1', 'alice', 10, 'CHANGES_REQUESTED', ''),
        rv('R2', 'bob', 11, 'COMMENTED', ''),
        rv('R3', 'carol', 12, 'APPROVED', 'lgtm'),
        rv('R4', 'dave', 13, 'COMMENTED', 'nit'),
      ],
    },
  })
  const out = comments(mine(pr), ctx())
  expect(out.events.map((e) => e.key)).toEqual(['c:R1', 'c:R4'])
  expect(out.items[0]?.who).toEqual(['alice', 'dave'])
})

test('bots hidden by default, shown band-only when includeBots', async () => {
  const bot = { id: 'B1', viewerDidAuthor: false, createdAt: iso(10), author: { login: 'coderabbit', __typename: 'Bot' } }
  const pr = minePr({ comments: { nodes: [bot, ic('A', 'alice', 20)] } })
  expect(comments(mine(pr), ctx()).items[0]).toMatchObject({ count: 1, who: ['alice'] })
  const out = comments(mine(pr), ctx({ cfg: { ...cfg, includeBots: true } }))
  expect(out.items[0]).toMatchObject({ count: 2, who: ['coderabbit', 'alice'] })
  expect(out.events.map((e) => e.notify)).toEqual([false, true])
})

test('several comments on one PR coalesce into one item', async () => {
  const pr = minePr({
    comments: { nodes: [ic('A1', 'alice', 10), ic('A2', 'alice', 30)] },
    reviewThreads: { nodes: [thread(ic('B1', 'bob', 20))] },
  })
  const out = comments(mine(pr), ctx())
  expect(out.items).toHaveLength(1)
  expect(out.items[0]).toMatchObject({ count: 3, who: ['alice', 'bob'] })
  expect(out.events).toHaveLength(3)
})

test('failed mine search keeps previous comment items', async () => {
  const prev: Item = {
    key: 'c:PR1', kind: 'comment', prId: 'PR1', repo: 'app', number: 1, title: 't', url: 'u',
    at: 100, who: ['alice'], count: 1, dim: false, tag: null,
  }
  const out = comments(mine(), ctx({ failed: new Set(['mine']), prev: state({ items: [prev] }) }))
  expect(out).toEqual({ items: [prev], events: [] })
})

test('item keeps its first-seen time', async () => {
  const prev: Item = {
    key: 'c:PR1', kind: 'comment', prId: 'PR1', repo: 'app', number: 1, title: 't', url: 'u',
    at: 100, who: ['alice'], count: 1, dim: false, tag: null,
  }
  const out = comments(mine(minePr({ comments: { nodes: [ic('A', 'alice', 10)] } })), ctx({ prev: state({ items: [prev] }) }))
  expect(out.items[0]?.at).toBe(100)
})
