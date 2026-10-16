import { expect, test } from 'claude-code/testing'
import { fakeIo } from './fakes'
import { data, ghOut } from './fixtures'
import type { Io } from '../hooks/io'
import { findGh, parseGh, runGh } from '../hooks/gh'

const ok = (stdout: string, exitCode = 0, stderr = '') => parseGh({ exitCode, stdout, stderr })

test('parses 200 with data', async () => {
  expect(ok(ghOut(200, {}, { data: data() }))).toEqual({ kind: 'ok', data: data(), failedPaths: [] })
})

test('exit 1 with data and errors still yields data', async () => {
  const errors = [
    { message: 'x', path: ['c3'] },
    { message: 'y', path: ['c3', 'ref'] },
  ]
  expect(ok(ghOut(200, {}, { data: data(), errors }), 1)).toEqual({
    kind: 'ok',
    data: data(),
    failedPaths: ['c3'],
  })
})

test('finds the body despite LF after the status line and CRLF after headers', async () => {
  const raw = 'HTTP/2.0 200 OK\nContent-Type: application/json\r\nX-Github-Request-Id: A\r\n\r\n{"data":{"viewer":{"login":"me"}}}'
  const r = ok(raw)
  expect(r.kind).toBe('ok')
})

test('401 is auth', async () => {
  expect(ok(ghOut(401, {}, { message: 'Bad credentials' }), 1)).toEqual({ kind: 'auth' })
})

test('exit 4 with empty stdout is auth', async () => {
  expect(parseGh({ exitCode: 4, stdout: '', stderr: '' })).toEqual({ kind: 'auth' })
  expect(parseGh({ exitCode: 1, stdout: '', stderr: 'try: gh auth login' })).toEqual({ kind: 'auth' })
})

test('403 with Retry-After: 120 is rate', async () => {
  expect(ok(ghOut(403, { 'Retry-After': '120' }, { message: 'nope' }), 1)).toEqual({
    kind: 'rate',
    retryAfterMs: 120000,
    resetAt: null,
  })
})

test('200 with x-ratelimit-remaining 0, x-ratelimit-reset 1800000000 and no data is rate', async () => {
  const r = ok(ghOut(200, { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1800000000' }, {}))
  expect(r).toEqual({ kind: 'rate', retryAfterMs: null, resetAt: 1800000000000 })
})

test('200 with errors type RATE_LIMITED and no data is rate', async () => {
  const r = ok(ghOut(200, {}, { errors: [{ type: 'RATE_LIMITED', message: 'slow down' }] }), 1)
  expect(r.kind).toBe('rate')
})

test('502 is offline', async () => {
  expect(ok(ghOut(502, {}, { message: 'Bad Gateway' }), 1)).toEqual({ kind: 'offline' })
})

test('empty stdout with exit 1 is offline', async () => {
  expect(parseGh({ exitCode: 1, stdout: '', stderr: 'dial tcp: no such host' })).toEqual({ kind: 'offline' })
})

test('200 with errors and no data is query', async () => {
  const r = ok(ghOut(200, {}, { errors: [{ message: 'Field foo missing' }] }), 1)
  expect(r).toEqual({ kind: 'query', message: 'Field foo missing' })
})

test('findGh falls back to homebrew when gh is not on PATH', async () => {
  const { io } = fakeIo({ run: (a) => (a[0] === '/opt/homebrew/bin/gh' ? { exitCode: 0 } : 'throw') })
  expect(await findGh(io)).toBe('/opt/homebrew/bin/gh')
  const none = fakeIo({ run: () => 'throw' })
  expect(await findGh(none.io)).toBeNull()
})

test('runGh passes the query and variables as -f fields with -i', async () => {
  const { io, argv } = fakeIo({ run: () => ({ exitCode: 0, stdout: ghOut(200, {}, { data: data() }) }) })
  const built = { query: 'query{x}', variables: { mine: 'm', rr: 'r', merged: 'g' }, aliases: {} }
  const r = await runGh(io, 'gh', built)
  expect(r.kind).toBe('ok')
  expect(argv[0]).toEqual(['gh', 'api', 'graphql', '-i', '-f', 'query=query{x}', '-f', 'mine=m', '-f', 'rr=r', '-f', 'merged=g'])
})

test('runGh maps a rejected run to offline', async () => {
  const { io } = fakeIo({ run: () => 'throw' })
  expect(await runGh(io, 'gh', { query: 'q', variables: {}, aliases: {} })).toEqual({ kind: 'offline' })
})

test('a PR title mentioning rate limit in data is still ok', async () => {
  const d = data({ mine: { issueCount: 1, nodes: [{ title: 'Add rate limit to API' } as never] } })
  expect(ok(ghOut(200, {}, { data: d })).kind).toBe('ok')
})

test('200 with x-ratelimit-remaining 0 and data is ok', async () => {
  expect(ok(ghOut(200, { 'X-RateLimit-Remaining': '0' }, { data: data() })).kind).toBe('ok')
})

test('a non-numeric Retry-After becomes null', async () => {
  const r = ok(ghOut(403, { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }, { message: 'x' }), 1)
  expect(r).toEqual({ kind: 'rate', retryAfterMs: null, resetAt: null })
})

test('findGh and runGh pass their timeouts', async () => {
  const inits: unknown[] = []
  const io = {
    process: {
      run: async (_a: readonly string[], init?: unknown) => {
        inits.push(init)
        return { exitCode: 0, stdout: ghOut(200, {}, { data: data() }), stderr: '' }
      },
    },
  } as unknown as Io
  await findGh(io)
  await runGh(io, 'gh', { query: 'q', variables: {}, aliases: {} })
  expect(inits).toEqual([{ timeoutMs: 5000 }, { timeoutMs: 30000 }])
})
