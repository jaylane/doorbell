import { expect, test } from 'claude-code/testing'
import { state } from './fixtures'
import { segments } from '../hooks/band'
import type { Item, State } from '../types'

const NOW = 10_000_000
const item = (over: Partial<Item>): Item => ({
  key: 'k', kind: 'review', prId: 'P', repo: 'app', fullRepo: 'acme/app', number: 1, title: 't', url: 'u',
  at: 0, who: [], count: 1, dim: false, tag: null, ...over,
})
const text = (s: State, ghMissing = false) => segments(s, NOW, ghMissing).map((x) => x.text)

test('review item, dim for a dim item', async () => {
  expect(segments(state({ items: [item({}), item({ dim: true })] }), NOW, false)).toEqual([
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
  expect(segments(state({ items, error: 'partial' }), NOW, false).map((x) => x.href)).toEqual([
    url, url, url, 'https://github.com/acme/app/releases/tag/pkg%401.0', undefined,
  ])
})

test('a shipped link keeps slashes in monorepo tags and falls back to the PR for other URLs', async () => {
  const href = (over: Partial<Item>) => segments(state({ items: [item({ kind: 'shipped', ...over })] }), NOW, false)[0]!.href
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
  expect(segments(state({ error: 'rate' }), NOW, false)).toEqual([{ text: '⚠ rate limited', dim: false, warn: true }])
})

test('stale 4m at 240s, none at 180s or without a success', async () => {
  expect(segments(state({ lastOkAt: NOW - 240_000 }), NOW, false)).toEqual([{ text: 'stale 4m', dim: true, warn: false }])
  expect(text(state({ lastOkAt: NOW - 180_000 }))).toEqual([])
  expect(text(state({ lastOkAt: 0 }))).toEqual([])
})

test('precedence: ghMissing beats auth, error beats stale, status is last', async () => {
  expect(text(state({ error: 'auth' }), true)).toEqual(['⚠ gh not found'])
  expect(text(state({ error: 'rate', lastOkAt: NOW - 600_000, items: [item({})] }))).toEqual(['👀 app#1', '⚠ rate limited'])
})

test('nothing to show yields []', async () => {
  expect(segments(state(), NOW, false)).toEqual([])
})
