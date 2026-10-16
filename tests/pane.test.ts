import { expect, test } from 'claude-code/testing'
import { paneView } from '../hooks/pane'
import { DEFAULT_SETTINGS } from '../hooks/settings'
import type { Item, Settings } from '../types'

const item = (fullRepo: string): Item => ({
  key: `k-${fullRepo}`,
  kind: 'review',
  prId: 'PR1',
  repo: fullRepo.split('/')[1] ?? fullRepo,
  fullRepo,
  number: 1,
  title: 't',
  url: 'u',
  at: 0,
  who: [],
  count: 1,
  dim: false,
  tag: null,
})

const many = (n: number): string[] => Array.from({ length: n }, (_, i) => `acme/r${String(i).padStart(2, '0')}`)

test('rows reflect effective kinds and tracking; untracked rows have all kinds false and all off', async () => {
  const s: Settings = {
    allRepos: false,
    defaults: ['review', 'comment', 'approved', 'shipped'],
    repos: {
      'acme/a': { tracked: true, kinds: ['review', 'shipped'] },
      'acme/b': { tracked: false, kinds: [] },
    },
    actions: DEFAULT_SETTINGS.actions,
  }
  const v = paneView(s, [], null, [], '')
  expect(v.allRepos).toBe(false)
  expect(v.rows[0]).toEqual({
    repo: 'acme/a',
    tracked: true,
    all: 'mixed',
    kinds: { review: true, comment: false, approved: false, shipped: true },
  })
  expect(v.rows[1]).toEqual({
    repo: 'acme/b',
    tracked: false,
    all: 'off',
    kinds: { review: false, comment: false, approved: false, shipped: false },
  })
})

test('column groups come from columnState', async () => {
  const s: Settings = { ...DEFAULT_SETTINGS, defaults: ['review'], repos: { 'acme/a': { tracked: true, kinds: ['review', 'comment'] } } }
  const v = paneView(s, null, null, [], '')
  expect(v.defaults).toEqual({ review: true, comment: false, approved: false, shipped: false })
  expect(v.column.all).toBe('mixed')
  expect(v.column.kinds).toEqual({ review: 'on', comment: 'mixed', approved: 'off', shipped: 'off' })
})

test('repos with entries and band items come first, even beyond the 40-row cap', async () => {
  const repos = many(60) 
  const s: Settings = { ...DEFAULT_SETTINGS, repos: { [repos[55]!]: { tracked: true, kinds: [] } } }
  const v = paneView(s, repos, null, [item(repos[50]!)], '')
  expect(v.rows).toHaveLength(40)
  expect(v.rows[0]?.repo).toBe(repos[55])
  expect(v.rows[1]?.repo).toBe(repos[50])
  expect(v.footer).toBe('showing 40 of 60 · type to filter')
})

test('filter narrows case-insensitively', async () => {
  const v = paneView(DEFAULT_SETTINGS, ['acme/Web', 'acme/api', 'zed/WEBHOOK'], null, [], 'WeB')
  expect(v.rows.map((r) => r.repo)).toEqual(['acme/Web', 'zed/WEBHOOK'])
  expect(v.footer).toBeNull()
})

test('loading and error footers', async () => {
  expect(paneView(DEFAULT_SETTINGS, null, null, [], '').footer).toBe('loading repos…')
  expect(paneView(DEFAULT_SETTINGS, null, 'no gh', [], '').footer).toBe("couldn't load repos: no gh")
})

test('a load error keeps the cap footer when rows are capped', async () => {
  const repos = many(45)
  const s: Settings = { ...DEFAULT_SETTINGS, repos: Object.fromEntries(repos.map((r) => [r, { tracked: true, kinds: [] }])) }
  expect(paneView(s, null, 'offline', [], '').footer).toBe("couldn't load repos: offline · showing 40 of 45 · type to filter")
})
