import { expect, test } from 'claude-code/testing'
import { data, minePr, rrPr, state } from './fixtures'
import { fakeIo } from './fakes'
import { DEFAULT_SETTINGS } from '../hooks/settings'
import { reduce } from '../hooks/reduce'
import { readState } from '../hooks/store'
import type { ActionMode, Comment, Item, Settings, State, Trigger } from '../types'

const cfg = { pollSeconds: 60, fadeMinutes: 5, includeBots: false, notify: true }
const HOUR = 3_600_000
const NOW = 1000 * HOUR
const user = (login: string) => ({ login, __typename: 'User' })
const bot = (login: string) => ({ login, __typename: 'Bot' })

const withAction = (t: Trigger, mode: ActionMode, prompt: string, s: Settings = DEFAULT_SETTINGS): Settings => ({
  ...s,
  actions: { ...s.actions, [t]: { mode, prompt } },
})
const live = (over: Partial<State> = {}) => state({ bootstrapped: true, ...over })
const rrData = (...nodes: ReturnType<typeof rrPr>[]) => data({ rr: { issueCount: nodes.length, nodes } })
const comment = (id: string, who: string, text: string, author = user(who)): Comment => ({
  id, bodyText: text, viewerDidAuthor: false, createdAt: `2026-10-16T10:0${id.length % 10}:00Z`, author,
})
const commentData = (...nodes: Comment[]) => data({ mine: { issueCount: 1, nodes: [minePr({ comments: { nodes } })] } })
const run = (prev: State, d: ReturnType<typeof data>, settings: Settings, handled: string[] = [], now = NOW) =>
  reduce(prev, d, [], {}, now, cfg, settings, handled)

const reviewItem = (prId: string): Item => ({
  key: `rr:${prId}:1`, kind: 'review', prId, repo: 'app', fullRepo: 'acme/app', number: 1, title: 't', url: 'u',
  at: 1, who: ['alice'], count: 1, dim: false, tag: null,
})

test('nothing fires on the bootstrap poll', async () => {
  const out = run(state(), rrData(rrPr()), withAction('review', 'session', 'go'))
  expect(out.runs).toEqual([])
  expect(out.state.asks).toEqual([])
  expect(out.state.actionRuns.review).toEqual([])
})

test('a review request in ask mode becomes an ask and its note gains the suffix', async () => {
  const out = run(live(), rrData(rrPr({ title: 'Fix login' })), withAction('review', 'ask', 'review {pr_url} by {author}'))
  expect(out.runs).toEqual([])
  expect(out.state.asks).toEqual([
    {
      id: `act:rr:PR1:${NOW}`,
      trigger: 'review',
      prId: 'PR1',
      label: 'app#1',
      text: 'review https://github.com/acme/app/pull/1 by alice',
    },
  ])
  expect(out.notes).toEqual([
    { title: 'Review requested', body: 'alice wants your review on app#1: Fix login · press ▶ to run' },
  ])
})

test('session mode yields a run with the rendered text', async () => {
  const out = run(live(), rrData(rrPr()), withAction('review', 'session', '/review {repo} {number}'))
  expect(out.runs).toEqual([
    { id: `act:rr:PR1:${NOW}`, trigger: 'review', prId: 'PR1', label: 'app#1', text: '/review acme/app 1', mode: 'session' },
  ])
  expect(out.state.actionRuns.review).toEqual([NOW])
  expect(out.state.asks).toEqual([])
  expect(out.notes[0]!.body.endsWith('press ▶ to run')).toBe(false)
})

test('five comments on one PR fire once with all five in {comments}', async () => {
  const cs = ['a', 'bb', 'ccc', 'dddd', 'eeeee'].map((id, i) => comment(id, i % 2 ? 'bob' : 'alice', `text ${id}`))
  const out = run(live(), commentData(...cs), withAction('comment', 'background', '{author}|{comments}'))
  expect(out.runs).toHaveLength(1)
  const r = out.runs[0]!
  expect(r.id).toBe('act:c:PR1:c:eeeee')
  expect(r.mode).toBe('background')
  expect(r.text.startsWith('alice, bob|<untrusted content from GitHub')).toBe(true)
  for (const c of cs) expect(r.text).toContain(`- ${c.author!.login}: ${c.bodyText}`)
  expect(out.state.actionRuns.comment).toEqual([NOW])
})

test('bot comments and team requests never fire', async () => {
  const settings = withAction('review', 'session', 'r', withAction('comment', 'session', 'c', DEFAULT_SETTINGS))
  const botCfg = { ...cfg, includeBots: true }
  const d = data({
    mine: { issueCount: 1, nodes: [minePr({ comments: { nodes: [comment('a', 'ci', 'x', bot('ci'))] } })] },
    rr: { issueCount: 1, nodes: [rrPr({ id: 'PR2', reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'Team', slug: 'core' } }] } })] },
  })
  const out = reduce(live(), d, [], {}, NOW, botCfg, settings, [])
  expect(out.runs).toEqual([])
  expect(out.state.asks).toEqual([])
})

test('an untracked repo never fires', async () => {
  const s = withAction('review', 'session', 'go', { ...DEFAULT_SETTINGS, repos: { 'acme/app': { tracked: false, kinds: [] } } })
  const out = run(live(), rrData(rrPr()), s)
  expect(out.runs).toEqual([])
  expect(out.state.asks).toEqual([])
})

test('the fourth automatic run in an hour becomes an ask and sets actionPaused', async () => {
  const prev = live({ actionRuns: { review: [NOW - 3, NOW - 2, NOW - 1], comment: [] } })
  const out = run(prev, rrData(rrPr()), withAction('review', 'session', 'go'))
  expect(out.runs).toEqual([])
  expect(out.state.asks.map((a) => a.id)).toEqual([`act:rr:PR1:${NOW}`])
  expect(out.state.actionPaused).toBe(true)
  expect(out.notes[0]!.body.endsWith(' · press ▶ to run')).toBe(true)

  const third = run(live({ actionRuns: { review: [NOW - 2, NOW - 1], comment: [] } }), rrData(rrPr()), withAction('review', 'session', 'go'))
  expect(third.runs).toHaveLength(1)
  expect(third.state.actionPaused).toBe(true)
})

test('runs older than an hour stop counting', async () => {
  const prev = live({ actionRuns: { review: [NOW - HOUR - 1, NOW - HOUR - 2, NOW - 1], comment: [] }, actionPaused: true })
  const out = run(prev, rrData(rrPr()), withAction('review', 'session', 'go'))
  expect(out.runs).toHaveLength(1)
  expect(out.state.actionRuns.review).toEqual([NOW - 1, NOW])
  expect(out.state.actionPaused).toBe(false)
})

test('handled ids remove asks', async () => {
  const ask = { id: 'act:rr:PR1:1', trigger: 'review' as const, prId: 'PR1', label: 'app#1', text: 'x' }
  const prev = live({ asks: [ask], items: [reviewItem('PR1')], seen: { 'rr:PR1:1': 1 } })
  const d = rrData(rrPr())
  expect(run(prev, d, DEFAULT_SETTINGS).state.asks).toEqual([ask])
  expect(run(prev, d, DEFAULT_SETTINGS, ['act:rr:PR1:1']).state.asks).toEqual([])
})

test('an ask expires when its item leaves the band', async () => {
  const ask = { id: 'act:c:PR1:c:a', trigger: 'comment' as const, prId: 'PR1', label: 'app#1', text: 'x' }
  // A review item on the same PR does not keep a comment ask alive.
  const prev = live({ asks: [ask], items: [reviewItem('PR1')], seen: { 'rr:PR1:1': 1 } })
  expect(run(prev, rrData(rrPr()), DEFAULT_SETTINGS).state.asks).toEqual([])
})

test('a state file from before actions reads with empty action fields', async () => {
  const old = JSON.stringify({ ...state({ bootstrapped: true }), asks: undefined, actionRuns: undefined, actionPaused: undefined })
  const s = await readState(fakeIo({ files: { '/c/state.json': old } }).io, '/c')
  expect(s!.asks).toEqual([])
  expect(s!.actionRuns).toEqual({ review: [], comment: [] })
  expect(s!.bootstrapped).toBe(true)
})

test('a fresh comment ask replaces the older ask on the same PR', async () => {
  const settings = withAction('comment', 'ask', '{comments}')
  const first = run(live(), commentData(comment('a', 'alice', 'one')), settings)
  expect(first.state.asks.map((a) => a.id)).toEqual(['act:c:PR1:c:a'])
  const second = run(first.state, commentData(comment('a', 'alice', 'one'), comment('bb', 'bob', 'two')), settings, [], NOW + 1)
  expect(second.state.asks).toHaveLength(1)
  expect(second.state.asks[0]!.id.endsWith('c:bb')).toBe(true)
})

test('the same comments polled again add no run or ask', async () => {
  const d = commentData(comment('a', 'alice', 'one'))
  const ask = run(live(), d, withAction('comment', 'ask', 'x'))
  expect(run(ask.state, d, withAction('comment', 'ask', 'x'), [], NOW + 1).state.asks).toEqual(ask.state.asks)
  const bg = run(live(), d, withAction('comment', 'background', 'x'))
  const again = run(bg.state, d, withAction('comment', 'background', 'x'), [], NOW + 1)
  expect(again.runs).toEqual([])
  expect(again.state.asks).toEqual([])
})
