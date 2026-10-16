import { expect, test } from 'claude-code/testing'
import { fakeIo } from './fakes'
import {
  DEFAULT_SETTINGS,
  KINDS,
  allows,
  columnState,
  effective,
  isTracked,
  parseSettings,
  readSettings,
  toggleAllRepos,
  toggleColumn,
  toggleDefault,
  toggleRepoAll,
  toggleRepoKind,
  toggleTracked,
  writeSettings,
} from '../hooks/settings'
import type { Settings } from '../types'

const D = '/c'
const S = (o: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, ...o })

test('defaults track everything with all kinds', async () => {
  expect(isTracked(DEFAULT_SETTINGS, 'a/b')).toBe(true)
  expect(effective(DEFAULT_SETTINGS, 'a/b')).toEqual([...KINDS])
  expect(allows(DEFAULT_SETTINGS, 'a/b', 'shipped')).toBe(true)
})

test('effective: own entry wins; no entry follows allRepos and defaults', async () => {
  const s = S({ defaults: ['review'], repos: { 'a/b': { tracked: true, kinds: ['shipped', 'comment'] }, 'a/c': { tracked: false, kinds: ['review'] } } })
  expect(effective(s, 'a/b')).toEqual(['comment', 'shipped'])
  expect(effective(s, 'a/c')).toEqual([])
  expect(isTracked(s, 'a/c')).toBe(false)
  expect(effective(s, 'x/y')).toEqual(['review'])
  expect(effective({ ...s, allRepos: false }, 'x/y')).toEqual([])
  expect(allows({ ...s, allRepos: false }, 'x/y', 'review')).toBe(false)
})

test('toggleTracked on a repo without an entry under allRepos creates {tracked:false,kinds:[]}, then tracks with defaults', async () => {
  const off = toggleTracked(DEFAULT_SETTINGS, 'a/b')
  expect(off.repos['a/b']).toEqual({ tracked: false, kinds: [] })
  const on = toggleTracked(off, 'a/b')
  expect(on.repos['a/b']).toEqual({ tracked: true, kinds: [...KINDS] })
  expect(DEFAULT_SETTINGS.repos).toEqual({})
})

test('toggleRepoKind on a repo without an entry materialises it, then a defaults change leaves it alone', async () => {
  const s = toggleRepoKind(DEFAULT_SETTINGS, 'a/b', 'review')
  expect(s.repos['a/b']).toEqual({ tracked: true, kinds: ['comment', 'approved', 'shipped'] })
  const t = toggleDefault(s, 'comment')
  expect(effective(t, 'a/b')).toEqual(['comment', 'approved', 'shipped'])
})

test('toggleRepoAll: mixed → all four, all four → none but still tracked', async () => {
  const mixed = S({ repos: { 'a/b': { tracked: true, kinds: ['review'] } } })
  const all = toggleRepoAll(mixed, 'a/b')
  expect(all.repos['a/b']).toEqual({ tracked: true, kinds: [...KINDS] })
  expect(toggleRepoAll(all, 'a/b').repos['a/b']).toEqual({ tracked: true, kinds: [] })
})

test("toggleColumn('approved') adds to defaults and every tracked entry, leaves untracked entries alone", async () => {
  const s = S({
    defaults: ['review'],
    repos: { 'a/b': { tracked: true, kinds: [] }, 'a/c': { tracked: false, kinds: [] } },
  })
  const t = toggleColumn(s, 'approved')
  expect(t.defaults).toEqual(['review', 'approved'])
  expect(t.repos['a/b']!.kinds).toEqual(['approved'])
  expect(t.repos['a/c']).toEqual({ tracked: false, kinds: [] })
  expect(columnState(t, 'approved')).toBe('on')
  expect(toggleColumn(t, 'approved').defaults).toEqual(['review'])
})

test("toggleColumn('all') with mixed → everything on, then off", async () => {
  const s = S({ defaults: ['review'], repos: { 'a/b': { tracked: true, kinds: ['shipped'] } } })
  expect(columnState(s, 'all')).toBe('mixed')
  const on = toggleColumn(s, 'all')
  expect(on.defaults).toEqual([...KINDS])
  expect(on.repos['a/b']!.kinds).toEqual([...KINDS])
  const off = toggleColumn(on, 'all')
  expect(off.defaults).toEqual([])
  expect(off.repos['a/b']).toEqual({ tracked: true, kinds: [] })
})

test('columnState over defaults plus tracked entries is mixed when they disagree', async () => {
  const s = S({ repos: { 'a/b': { tracked: true, kinds: ['review'] }, 'a/c': { tracked: false, kinds: [] } } })
  expect(columnState(s, 'review')).toBe('on')
  expect(columnState(s, 'comment')).toBe('mixed')
  const none = S({ allRepos: false, repos: { 'a/c': { tracked: false, kinds: [] } } })
  expect(columnState(none, 'all')).toBe('off')
})

test('toggleAllRepos off keeps entries; repos without an entry become untracked', async () => {
  const s = S({ repos: { 'a/b': { tracked: true, kinds: ['review'] } } })
  const off = toggleAllRepos(s)
  expect(off.repos).toEqual(s.repos)
  expect(isTracked(off, 'x/y')).toBe(false)
  expect(isTracked(off, 'a/b')).toBe(true)
  expect(toggleAllRepos(off).allRepos).toBe(true)
})

test('toggleDefault adds and removes in KINDS order', async () => {
  const s = S({ defaults: ['shipped'] })
  const t = toggleDefault(s, 'review')
  expect(t.defaults).toEqual(['review', 'shipped'])
  expect(toggleDefault(t, 'shipped').defaults).toEqual(['review'])
})

test('parseSettings rejects unknown kinds, wrong types and non-objects', async () => {
  expect(parseSettings(JSON.stringify(DEFAULT_SETTINGS))).toEqual(DEFAULT_SETTINGS)
  expect(parseSettings('nope')).toBeNull()
  expect(parseSettings('null')).toBeNull()
  expect(parseSettings('[]')).toBeNull()
  expect(parseSettings('{"allRepos":1,"defaults":[],"repos":{}}')).toBeNull()
  expect(parseSettings('{"allRepos":true,"defaults":["bogus"],"repos":{}}')).toBeNull()
  expect(parseSettings('{"allRepos":true,"defaults":[],"repos":{"a/b":{"tracked":"y","kinds":[]}}}')).toBeNull()
  expect(parseSettings('{"allRepos":true,"defaults":[],"repos":{"a/b":{"tracked":true,"kinds":["x"]}}}')).toBeNull()
  expect(parseSettings('{"allRepos":true,"defaults":[],"repos":[]}')).toBeNull()
})

test('parseSettings skips __proto__, constructor and prototype repo keys', async () => {
  const entry = '{"tracked":true,"kinds":["review"]}'
  const s = parseSettings(
    `{"allRepos":true,"defaults":[],"repos":{"__proto__":${entry},"constructor":${entry},"prototype":${entry},"a/b":${entry}}}`,
  )
  expect(Object.keys(s!.repos)).toEqual(['a/b'])
  expect(Object.getPrototypeOf(s!.repos)).toBe(Object.prototype)
})

test('readSettings: missing file gives defaults, garbage gives defaults with isInvalid', async () => {
  expect(await readSettings(fakeIo().io, D)).toEqual({ settings: DEFAULT_SETTINGS, isInvalid: false })
  const bad = fakeIo({ files: { [`${D}/settings.json`]: '{"allRepos":' } })
  expect(await readSettings(bad.io, D)).toEqual({ settings: DEFAULT_SETTINGS, isInvalid: true })
  const s = S({ allRepos: false })
  const ok = fakeIo({ files: { [`${D}/settings.json`]: JSON.stringify(s) } })
  expect(await readSettings(ok.io, D)).toEqual({ settings: s, isInvalid: false })
})

test('writeSettings writes tmp then mv, and rejects when mv fails', async () => {
  const { io, argv, files } = fakeIo()
  await writeSettings(io, D, 'S1', DEFAULT_SETTINGS)
  expect(argv).toContainEqual(['mv', `${D}/settings.json.S1.tmp`, `${D}/settings.json`])
  expect(JSON.parse(files.get(`${D}/settings.json`)!.text)).toEqual(DEFAULT_SETTINGS)
  const orig = io.process.run
  io.process.run = async (a, i) => (a[0] === 'mv' ? { exitCode: 1, stdout: '', stderr: 'x' } : orig(a, i))
  let failed = false
  await writeSettings(io, D, 'S1', DEFAULT_SETTINGS).catch(() => (failed = true))
  expect(failed).toBe(true)
})
