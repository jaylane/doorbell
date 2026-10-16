import { expect, test } from 'claude-code/testing'
import { state } from './fixtures'
import { segments } from '../hooks/band'
import { DEFAULT_SETTINGS } from '../hooks/settings'
import type { Item, State } from '../types'

const NOW = 10_000_000
const item = (over: Partial<Item>): Item => ({
  key: 'k', kind: 'review', prId: 'P', repo: 'app', fullRepo: 'acme/app', number: 1, title: 't', url: 'u',
  at: 0, who: [], count: 1, dim: false, tag: null, ...over,
})
const text = (s: State, ghMissing = false) => segments(s, NOW, ghMissing, DEFAULT_SETTINGS).map((x) => x.text)

test('review item, dim for a dim item', async () => {
  expect(segments(state({ items: [item({}), item({ dim: true })] }), NOW, false, DEFAULT_SETTINGS)).toEqual([
    { text: '👀 app#1', dim: false, warn: false, href: 'u' },
    { text: '👀 app#1', dim: true, warn: false, href: 'u' },
  ])
})

test('comment, approved and shipped items', async () => {
  const items = [
    item({ kind: 'comment', number: 2, count: 3 }),
    item({ kind: 'approved', number: 3 }),
    item({ kind: 'shipped', number: 4, tag: 'v2' }),
  ]
  expect(text(state({ items }))).toEqual(['💬 app#2 ×3', '✅ app#3', '🚀 app#4 v2'])
})

test('item segments link to the PR, and a shipped one to its release', async () => {
  const url = 'https://github.com/acme/app/pull/4'
  const items = [
    item({ kind: 'review', url }),
    item({ kind: 'comment', url }),
    item({ kind: 'approved', url }),
    item({ kind: 'shipped', url, tag: 'pkg@1.0' }),
  ]
  expect(segments(state({ items, error: 'partial' }), NOW, false, DEFAULT_SETTINGS).map((x) => x.href)).toEqual([
    url, url, url, 'https://github.com/acme/app/releases/tag/pkg%401.0', undefined,
  ])
})

test('a shipped link keeps slashes in monorepo tags and falls back to the PR for other URLs', async () => {
  const href = (over: Partial<Item>) => segments(state({ items: [item({ kind: 'shipped', ...over })] }), NOW, false, DEFAULT_SETTINGS)[0]!.href
  expect(href({ url: 'https://github.com/acme/app/pull/4', tag: '@scope/pkg@1.0 rc#2' })).toBe(
    'https://github.com/acme/app/releases/tag/%40scope/pkg%401.0%20rc%232',
  )
  expect(href({ url: 'https://example.com/x', tag: 'v1' })).toBe('https://example.com/x')
})

test('status segments', async () => {
  expect(text(state(), true)).toEqual(['⚠ gh not found'])
  expect(text(state({ error: 'auth' }))).toEqual(['⚠ run gh auth login'])
  expect(text(state({ error: 'offline' }))).toEqual(['⚠ offline'])
  expect(text(state({ error: 'rate' }))).toEqual(['⚠ rate limited'])
  expect(text(state({ error: 'query' }))).toEqual(['⚠ GitHub error'])
  expect(text(state({ error: 'partial' }))).toEqual(['⚠ partial'])
  expect(segments(state({ error: 'rate' }), NOW, false, DEFAULT_SETTINGS)).toEqual([{ text: '⚠ rate limited', dim: false, warn: true }])
})

test('stale 4m at 240s, none at 180s or without a success', async () => {
  expect(segments(state({ lastOkAt: NOW - 240_000 }), NOW, false, DEFAULT_SETTINGS)).toEqual([{ text: 'stale 4m', dim: true, warn: false }])
  expect(text(state({ lastOkAt: NOW - 180_000 }))).toEqual([])
  expect(text(state({ lastOkAt: 0 }))).toEqual([])
})

test('precedence: ghMissing beats auth, error beats stale, status is last', async () => {
  expect(text(state({ error: 'auth' }), true)).toEqual(['⚠ gh not found'])
  expect(text(state({ error: 'rate', lastOkAt: NOW - 600_000, items: [item({})] }))).toEqual(['👀 app#1', '⚠ rate limited'])
})

test('nothing to show yields []', async () => {
  expect(segments(state(), NOW, false, DEFAULT_SETTINGS)).toEqual([])
})

test('an item whose repo is untracked or whose kind is off is hidden; status segments stay', async () => {
  const items = [
    item({ kind: 'review', number: 1 }),
    item({ kind: 'comment', number: 2 }),
    item({ kind: 'review', number: 3, fullRepo: 'acme/other', repo: 'other' }),
  ]
  const settings = {
    allRepos: false,
    defaults: [],
    repos: { 'acme/app': { tracked: true, kinds: ['review' as const] } },
    actions: DEFAULT_SETTINGS.actions,
  }
  expect(segments(state({ items, error: 'rate' }), NOW, false, settings).map((x) => x.text)).toEqual([
    '👀 app#1',
    '⚠ rate limited',
  ])
})

test('an item with a pending ask of its kind carries the ask id', async () => {
  const items = [item({ prId: 'P', kind: 'review' }), item({ prId: 'P', kind: 'comment' }), item({ prId: 'Q', kind: 'review' })]
  const asks = [{ id: 'act:r', trigger: 'review' as const, prId: 'P', label: 'app#1', text: '/review u' }]
  expect(segments(state({ items, asks }), NOW, false, DEFAULT_SETTINGS).map((x) => x.ask)).toEqual(['act:r', undefined, undefined])
})

test('action failed follows query, action paused follows partial', async () => {
  const st = (over: Partial<State>, failed: boolean) => segments(state(over), NOW, false, DEFAULT_SETTINGS, failed).map((x) => x.text)
  expect(st({ error: 'query' }, true)).toEqual(['⚠ GitHub error'])
  expect(st({ error: 'partial' }, true)).toEqual(['⚠ action failed'])
  expect(st({}, true)).toEqual(['⚠ action failed'])
  expect(st({ error: 'partial', actionPaused: true }, false)).toEqual(['⚠ partial'])
  expect(st({ actionPaused: true, lastOkAt: NOW - 600_000 }, false)).toEqual(['⚠ action paused'])
  expect(segments(state({ actionPaused: true }), NOW, false, DEFAULT_SETTINGS)).toEqual([{ text: '⚠ action paused', dim: false, warn: true }])
})
