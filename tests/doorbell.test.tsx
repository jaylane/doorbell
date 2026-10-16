import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Item, State } from '../types'
import { data, ghOut, pending, rrPr, state } from './fixtures'

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
}

// The engine beneath the mod: files, processes and notifications answered from memory.
const world = (on: On, clock: MockClock, opts: { files?: Record<string, string>; noGh?: boolean } = {}): World => {
  const w: World = { files: new Map(), dirs: new Set(), gh: [], argv: [], notify: [], osascript: [] }
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
