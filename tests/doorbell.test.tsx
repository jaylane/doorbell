import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Item, State } from '../types'
import { data, ghOut, minePr, pending, rrPr, state } from './fixtures'

const T0 = 1_700_000_000_000
const DIR = '/home/t/.cache/doorbell'

const BAND = {
  plugin: 'doorbell',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 200,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

type World = {
  files: Map<string, { text: string; mtimeMs: number }>
  dirs: Set<string>
  gh: string[]
  argv: string[][]
  notify: string[]
  osascript: string[][]
  mvExit: number
  opened: string[]
  commands: string[]
}

// The engine beneath the mod: files, processes and notifications answered from memory.
const world = (on: On, clock: MockClock, opts: { files?: Record<string, string>; noGh?: boolean } = {}): World => {
  const w: World = { files: new Map(), dirs: new Set(), gh: [], argv: [], notify: [], osascript: [], mvExit: 0, opened: [], commands: [] }
  for (const [p, text] of Object.entries(opts.files ?? {})) w.files.set(p, { text, mtimeMs: clock.now() })
  const need = (path: string) => {
    const f = w.files.get(path)
    if (!f) throw new Error(`ENOENT: ${path}`)
    return f
  }
  const result = (exitCode: number, stdout = '') => ({
    value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })

  on('session.id', () => ({ value: 'S1' }))
  on('env.get', () => ({ value: '/home/t' }))
  on('fs.read', ($, e) => ({ value: need(e.path).text }))
  on('fs.write', ($, e) => {
    w.files.set(e.path, { text: e.text, mtimeMs: clock.now() })
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: w.files.has(e.path) || w.dirs.has(e.path) }))
  on('fs.stat', ($, e) => {
    const mtimeMs = w.dirs.has(e.path) ? clock.now() : need(e.path).mtimeMs
    return { value: { kind: 'file' as const, size: 0, mtimeMs, isLink: false } }
  })
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    w.argv.push(argv)
    const [cmd, ...rest] = argv
    const last = rest[rest.length - 1] ?? ''
    if (cmd === 'mkdir') {
      if (w.dirs.has(last)) return result(rest.includes('-p') ? 0 : 1)
      w.dirs.add(last)
      return result(0)
    }
    if (cmd === 'rmdir') return w.dirs.delete(last), result(0)
    if (cmd === 'mv') {
      if (w.mvExit) return result(w.mvExit)
      w.files.set(rest[1]!, need(rest[0]!))
      w.files.delete(rest[0]!)
      return result(0)
    }
    if (cmd === 'osascript') return w.osascript.push(argv), result(0)
    if (rest[0] === '--version') {
      if (opts.noGh) throw new Error('spawn ENOENT')
      return result(0, 'gh version 2.60.0')
    }
    if (rest[0] === 'api') return result(0, w.gh.shift() ?? '')
    throw new Error(`unexpected argv: ${argv.join(' ')}`)
  })
  on('ui.notify', ($, e) => {
    w.notify.push(e.text)
    return { value: { isSent: true as const, channel: 'iterm2' as const } }
  })
  on('ui.log', () => ({ value: undefined }))
  on('command.register', ($, e) => {
    w.commands.push(`${e.name}: ${e.description}`)
    return { value: { command: e.name } }
  })
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  // What the host draws when the band yields: an empty row.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  return w
}

const START = { cwd: '/w', surface: 'terminal', isInteractive: true } as const
const graphqlCalls = (w: World) => w.argv.filter((a) => a.includes('graphql')).length
const ok = (over: Parameters<typeof data>[0]) => ghOut(200, {}, { data: data(over) })
const rr = (...prs: ReturnType<typeof rrPr>[]) => ok({ rr: { issueCount: prs.length, nodes: prs } })
const fileState = (w: World) => JSON.parse(w.files.get(`${DIR}/state.json`)!.text) as State

const reviewItem: Item = {
  key: 'review:PR9',
  kind: 'review',
  prId: 'PR9',
  repo: 'web',
  fullRepo: 'acme/web',
  number: 9,
  title: 'Fix it',
  url: 'https://github.com/acme/web/pull/9',
  at: T0,
  who: ['bob'],
  count: 0,
  dim: false,
  tag: null,
}

const bandTexts = async ($: Engine) => {
  const ui = await $.ui.mount(BAND)
  const texts = (await ui.findAll({ type: 'Text' })).map((t) => t.text)
  await ui.unmount()
  return texts
}

test('non-interactive sessions never poll', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on, clock)
  w.gh.push(rr(rrPr()))
  await $.session.start({ ...START, isInteractive: false })
  await clock.advance(120_000)
  expect(graphqlCalls(w)).toBe(0)
  expect(w.files.has(`${DIR}/lease.json`)).toBe(false)
})

test('leader polls, writes state and draws the band', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on, clock)
  w.gh.push(rr(rrPr()))
  await $.session.start(START)
  await clock.advance(20_000)
  expect(graphqlCalls(w)).toBe(1)
  expect(fileState(w).items.map((i) => i.number)).toEqual([1])
  expect(await bandTexts($)).toEqual(['👀 app#1'])
})

test('band items are links to their GitHub page', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on, clock)
  w.gh.push(rr(rrPr()))
  await $.session.start(START)
  await clock.advance(20_000)
  const ui = await $.ui.mount(BAND)
  const links = await ui.findAll({ type: 'Link' })
  await ui.unmount()
  // The kit's `text` for a Link leads with its href, so read the drawn label from the child Text.
  expect(links.map((l) => [l.props.href, (l.children[0] as { text?: string; children?: unknown[] }).children])).toEqual([
    ['https://github.com/acme/app/pull/1', ['👀 app#1']],
  ])
})

test('first poll does not notify; a new review request on the next poll does', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on, clock)
  w.gh.push(rr(rrPr()), rr(rrPr(), rrPr({ id: 'PR2', number: 2, url: 'https://github.com/acme/app/pull/2' })))
  await $.session.start(START)
  await clock.advance(20_000)
  expect(w.notify).toHaveLength(0)
  await clock.advance(60_000)
  expect(graphqlCalls(w)).toBe(2)
  expect(w.notify).toHaveLength(1)
  expect(w.notify[0]).toContain('app#2')
  expect(w.osascript).toHaveLength(0)
})

test('follower draws the band from the file and never notifies', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on, clock, {
    files: {
      [`${DIR}/lease.json`]: JSON.stringify({ sessionId: 'S2', expiresAt: T0 + 3_600_000 }),
    },
  })
  await $.session.start(START)
  // The leader writes after this session started, so the follower picks it up on a refresh.
  await clock.advance(5_000)
  w.files.set(`${DIR}/state.json`, { text: JSON.stringify(state({ items: [reviewItem], lastOkAt: T0, bootstrapped: true })), mtimeMs: clock.now() })
  await clock.advance(60_000)
  expect(await bandTexts($)).toEqual(['👀 web#9'])
  expect(w.notify).toHaveLength(0)
  expect(graphqlCalls(w)).toBe(0)
})

test('a session without gh never takes the lease', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on, clock, { noGh: true })
  await $.session.start(START)
  await clock.advance(60_000)
  expect(await bandTexts($)).toEqual(['⚠ gh not found'])
  expect(w.files.has(`${DIR}/lease.json`)).toBe(false)
  expect(graphqlCalls(w)).toBe(0)
})

test('auth failure shows ⚠ run gh auth login and backs off 5 minutes', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on, clock)
  w.gh.push(ghOut(401, {}, { message: 'Bad credentials' }))
  await $.session.start(START)
  await clock.advance(20_000)
  expect(await bandTexts($)).toEqual(['⚠ run gh auth login'])
  await clock.advance(280_000)
  expect(graphqlCalls(w)).toBe(1)
  await clock.advance(20_000)
  expect(graphqlCalls(w)).toBe(2)
})

const waitingPrev = state({
  pendingShip: { PR1: pending('acme/app'), PR2: pending('acme/lib', { number: 2 }) },
  releases: { 'acme/app': 'v1', 'acme/lib': 'v1' },
  latest: { 'acme/app': 'v2', 'acme/lib': 'v2' },
  bootstrapped: true,
})
const pathless = ghOut(200, {}, { errors: [{ message: 'Something went wrong' }] })

test('a pathless query error retries compares once, then gives them up', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on, clock, { files: { [`${DIR}/state.json`]: JSON.stringify(waitingPrev) } })
  w.gh.push(pathless, pathless)
  await $.session.start(START)
  await clock.advance(20_000)
  expect(graphqlCalls(w)).toBe(1)
  expect(w.argv.find((a) => a.includes('graphql'))!.join(' ')).toContain('compare(')
  expect(fileState(w).releases).toEqual(waitingPrev.releases)
  expect(fileState(w).pathlessQueryFailures).toBe(1)
  expect(fileState(w).error).toBe('query')

  await clock.advance(60_000)
  expect(graphqlCalls(w)).toBe(2)
  expect(w.argv.filter((a) => a.includes('graphql'))[1]!.join(' ')).toContain('compare(')
  expect(fileState(w).releases).toEqual({ 'acme/app': 'v2', 'acme/lib': 'v2' })
  expect(fileState(w).pendingShip.PR1!.compared).toBe('v2')
  expect(fileState(w).pathlessQueryFailures).toBe(0)
})

test('a query error naming a compare alias gives up only that compare', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on, clock, { files: { [`${DIR}/state.json`]: JSON.stringify(waitingPrev) } })
  w.gh.push(ghOut(200, {}, { errors: [{ message: 'Could not resolve commit', path: ['c0', 'ref'] }] }))
  await $.session.start(START)
  await clock.advance(20_000)
  expect(graphqlCalls(w)).toBe(1)
  expect(fileState(w).releases).toEqual({ 'acme/app': 'v2', 'acme/lib': 'v1' })
  expect(fileState(w).pendingShip.PR1!.compared).toBe('v2')
  expect(fileState(w).pendingShip.PR2!.compared).toBeUndefined()
  expect(fileState(w).pathlessQueryFailures).toBe(0)
})

test('session end releases the lease; /clear does not', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on, clock)
  w.gh.push(rr())
  await $.session.start(START)
  await clock.advance(20_000)
  const lease = () => JSON.parse(w.files.get(`${DIR}/lease.json`)!.text) as { sessionId: string; expiresAt: number }
  expect(lease().sessionId).toBe('S1')

  await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } })
  expect(lease().expiresAt).toBeGreaterThan(clock.now())
  await $.session.end({ reason: 'other', sessionId: 'S1', resume: { id: 'S1' } })
  expect(lease()).toEqual({ sessionId: 'S1', expiresAt: 0 })
})

test('band is hidden when there is nothing to show', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on, clock)
  w.gh.push(rr())
  await $.session.start(START)
  await clock.advance(20_000)
  expect(graphqlCalls(w)).toBe(1)
  expect(await bandTexts($)).toEqual([])
})

test('a reduce exception is a query failure that backs off and leaves compares alone', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on, clock, { files: { [`${DIR}/state.json`]: JSON.stringify(waitingPrev) } })
  w.gh.push(ok({ viewer: null as never }), rr())
  await $.session.start(START)
  await clock.advance(20_000)
  expect(graphqlCalls(w)).toBe(1)
  expect(await bandTexts($)).toEqual(['⚠ GitHub error'])
  expect(fileState(w)).toMatchObject({ error: 'query', lastAttemptAt: T0 + 20_000, failures: 1, pathlessQueryFailures: 0 })
  expect(fileState(w).releases).toEqual(waitingPrev.releases)
  await clock.advance(40_000)
  expect(graphqlCalls(w)).toBe(1)
  await clock.advance(20_000)
  expect(graphqlCalls(w)).toBe(2)
})

test('a failed state write sends nothing and still waits out the poll interval', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on, clock)
  const second = rrPr({ id: 'PR2', number: 2, url: 'https://github.com/acme/app/pull/2' })
  w.gh.push(rr(rrPr()), rr(rrPr(), second), rr(rrPr(), second))
  await $.session.start(START)
  await clock.advance(30_000)
  expect(graphqlCalls(w)).toBe(1)
  w.mvExit = 1
  await clock.advance(50_000)
  expect(graphqlCalls(w)).toBe(2)
  expect(w.notify).toHaveLength(0)
  await clock.advance(40_000)
  expect(graphqlCalls(w)).toBe(2)
  w.mvExit = 0
  await clock.advance(20_000)
  expect(graphqlCalls(w)).toBe(3)
  expect(w.notify).toHaveLength(1)
  expect(w.notify[0]).toContain('app#2')
})

test('taking over the lease reloads the file, so the new leader does not re-notify', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const stale = state({ bootstrapped: true, lastOkAt: T0 })
  const w = world(on, clock, {
    files: {
      [`${DIR}/state.json`]: JSON.stringify(stale),
      [`${DIR}/lease.json`]: JSON.stringify({ sessionId: 'S2', expiresAt: T0 + 15_000 }),
    },
  })
  const bob = { login: 'bob', __typename: 'User' }
  const approvedPr = minePr({ reviewDecision: 'APPROVED', latestOpinionatedReviews: { nodes: [{ id: 'R1', state: 'APPROVED', author: bob }] } })
  w.gh.push(ok({ mine: { issueCount: 1, nodes: [approvedPr] } }))
  await $.session.start(START)
  await clock.advance(12_000)
  // The old leader's last write, with an mtime the follower refresh already holds, so only the takeover can pick it up.
  w.files.set(`${DIR}/state.json`, { text: JSON.stringify({ ...stale, seen: { 'a:R1': T0 } }), mtimeMs: T0 })
  await clock.advance(8_000)
  expect(graphqlCalls(w)).toBe(1)
  expect(w.notify).toHaveLength(0)
})

const PANE = {
  plugin: 'doorbell',
  component: 'Pane',
  surface: 'terminal',
  requestId: 'doorbell-settings',
  props: {
    title: 'Doorbell settings',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const repoList = (...names: string[]) =>
  JSON.stringify({
    data: {
      viewer: {
        repositories: {
          nodes: names.map((nameWithOwner) => ({ nameWithOwner, isArchived: false })),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  })

// A follower with the review item for acme/web already on file, so nothing polls.
const followerFiles = (extra: Record<string, string> = {}) => ({
  [`${DIR}/lease.json`]: JSON.stringify({ sessionId: 'S2', expiresAt: T0 + 3_600_000 }),
  [`${DIR}/state.json`]: JSON.stringify(state({ items: [reviewItem], lastOkAt: T0, bootstrapped: true })),
  ...extra,
})
const fileSettings = (w: World) => JSON.parse(w.files.get(`${DIR}/settings.json`)!.text)
const openPane = ($: Engine) =>
  $.command.run({ command: 'doorbell', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
const paneTexts = async ($: Engine) => {
  const ui = await $.ui.mount(PANE)
  const texts = (await ui.findAll({ type: 'Text' })).map((t) => t.text)
  await ui.unmount()
  return texts
}

test('/doorbell opens the settings pane and lists repos from gh', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on, clock)
  w.gh.push(repoList('acme/app', 'acme/lib'))
  await $.session.start(START)
  expect(await openPane($)).toMatchObject({ text: 'Doorbell settings opened.' })
  await clock.advance(0)
  expect(w.opened).toEqual(['doorbell-settings'])
  expect(w.commands).toEqual(['doorbell: Choose which repos and alerts Doorbell watches'])
  const ui = await $.ui.mount(PANE)
  const texts = async () => (await ui.findAll({ type: 'Text' })).map((t) => t.text)
  expect(await texts()).toContain('acme/app')
  expect(await texts()).toContain('acme/lib')
  expect(await texts()).not.toContain('loading repos…')
  await ui.input({ key: 'filter', text: 'LIB', kind: 'change' })
  expect(await texts()).not.toContain('acme/app')
  expect(await texts()).toContain('acme/lib')
  await ui.unmount()
})

test('pressing a kind box writes settings.json and the band hides that kind', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on, clock, { files: followerFiles() })
  await $.session.start(START)
  expect(await bandTexts($)).toEqual(['👀 web#9'])
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'kind:acme/web:review' })
  expect(fileSettings(w).repos['acme/web']).toEqual({ tracked: true, kinds: ['comment', 'approved', 'shipped'] })
  expect((await ui.findAll({ type: 'Text' })).map((t) => t.text)).toContain('saved')
  await ui.unmount()
  expect(await bandTexts($)).toEqual([])
})

test('the all-repos and column boxes toggle every repo at once', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const kept = { allRepos: true, defaults: ['review', 'comment', 'approved', 'shipped'], repos: { 'acme/api': { tracked: true, kinds: ['review'] } } }
  const w = world(on, clock, { files: followerFiles({ [`${DIR}/settings.json`]: JSON.stringify(kept) }) })
  await $.session.start(START)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'col:review' })
  expect(fileSettings(w)).toEqual({ allRepos: true, defaults: ['comment', 'approved', 'shipped'], repos: { 'acme/api': { tracked: true, kinds: [] } } })
  await ui.press({ key: 'all-repos' })
  expect(fileSettings(w).allRepos).toBe(false)
  await ui.press({ key: 'col:all' })
  expect(fileSettings(w).repos['acme/api'].kinds).toEqual(['review', 'comment', 'approved', 'shipped'])
  await ui.unmount()
})

test("another session's settings change reaches this band at the next follower check", async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on, clock, { files: followerFiles() })
  await $.session.start(START)
  expect(await bandTexts($)).toEqual(['👀 web#9'])
  await clock.advance(5_000)
  const off = { allRepos: true, defaults: [], repos: {} }
  w.files.set(`${DIR}/settings.json`, { text: JSON.stringify(off), mtimeMs: clock.now() })
  await clock.advance(10_000)
  expect(await bandTexts($)).toEqual([])
})

test('an unreadable settings.json shows the notice and keeps alerts on', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  world(on, clock, { files: followerFiles({ [`${DIR}/settings.json`]: '{not json' }) })
  await $.session.start(START)
  expect(await paneTexts($)).toContain('settings file unreadable, using defaults')
  expect(await bandTexts($)).toEqual(['👀 web#9'])
})

test('a failed repo list still shows repos from settings and band items', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const kept = { allRepos: true, defaults: ['review'], repos: { 'acme/lib': { tracked: false, kinds: [] } } }
  const w = world(on, clock, { files: followerFiles({ [`${DIR}/settings.json`]: JSON.stringify(kept) }) })
  w.gh.push('')
  await $.session.start(START)
  await openPane($)
  await clock.advance(0)
  const ui = await $.ui.mount(PANE)
  const texts = (await ui.findAll({ type: 'Text' })).map((t) => t.text)
  expect(texts).toContain("couldn't load repos: offline")
  expect(texts).toContain('acme/lib')
  expect(texts).toContain('acme/web')
  await ui.press({ key: 'track:acme/lib' })
  expect(fileSettings(w).repos['acme/lib']).toEqual({ tracked: true, kinds: ['review'] })
  await ui.unmount()
})

test('two presses before a redraw both land in the atom and the file', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const kept = { allRepos: true, defaults: ['review', 'comment', 'approved', 'shipped'], repos: { 'acme/api': { tracked: true, kinds: ['comment'] } } }
  const w = world(on, clock, { files: followerFiles({ [`${DIR}/settings.json`]: JSON.stringify(kept) }) })
  await $.session.start(START)
  const ui = await $.ui.mount(PANE)
  await Promise.all([ui.press({ key: 'kind:acme/web:review' }), ui.press({ key: 'kind:acme/api:review' })])
  expect(fileSettings(w).repos).toEqual({
    'acme/api': { tracked: true, kinds: ['review', 'comment'] },
    'acme/web': { tracked: true, kinds: ['comment', 'approved', 'shipped'] },
  })
  const texts = (await ui.findAll({ type: 'Text' })).map((t) => t.text)
  expect(texts).toContain('saved')
  expect(texts).not.toContain('⚠ not saved')
  await ui.unmount()
  expect(await bandTexts($)).toEqual([])
})
