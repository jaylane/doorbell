import { expect, test } from 'claude-code/testing'
import { fakeIo } from './fakes'
import { EMPTY, readState, writeState } from '../hooks/store'
import { ensureDir, release, tryLead } from '../hooks/lease'

const D = '/c'
const NOW = 1_000_000
const lease = (files: Map<string, { text: string }>) => JSON.parse(files.get(`${D}/lease.json`)!.text)

test('writeState writes a tmp file then moves it over state.json', async () => {
  const { io, argv, files } = fakeIo()
  await writeState(io, D, 'S1', EMPTY)
  expect(argv).toContainEqual(['mv', `${D}/state.json.S1.tmp`, `${D}/state.json`])
  expect(JSON.parse(files.get(`${D}/state.json`)!.text)).toEqual(EMPTY)
})

test('writeState rejects when mv fails', async () => {
  const { io } = fakeIo()
  const orig = io.process.run
  io.process.run = async (a, i) => (a[0] === 'mv' ? { exitCode: 1, stdout: '', stderr: 'x' } : orig(a, i))
  let failed = false
  await writeState(io, D, 'S1', EMPTY).catch(() => (failed = true))
  expect(failed).toBe(true)
})

test('readState returns null on a half-written file', async () => {
  const { io } = fakeIo({ files: { [`${D}/state.json`]: '{"items":[' } })
  expect(await readState(io, D)).toBeNull()
  expect(await readState(fakeIo().io, D)).toBeNull()
})

test('ensureDir makes the folder private without keying on option flags', async () => {
  const { io, files, argv } = fakeIo()
  await ensureDir(io, D)
  await ensureDir(io, D)
  expect(argv[0]).toEqual(['mkdir', '-p', '-m', '700', D])
  expect(files.has(`${D}/`)).toBe(true)
  expect(files.has('-p/')).toBe(false)
})

test('takes a free lease', async () => {
  const { io, files } = fakeIo()
  expect(await tryLead(io, D, 'S1', NOW)).toBe(true)
  expect(lease(files)).toEqual({ sessionId: 'S1', expiresAt: NOW + 90000 })
  expect(files.has(`${D}/lease.lock/`)).toBe(false)
})

test('renews its own lease', async () => {
  const { io, files } = fakeIo({ files: { [`${D}/lease.json`]: JSON.stringify({ sessionId: 'S1', expiresAt: NOW + 10 }) } })
  expect(await tryLead(io, D, 'S1', NOW)).toBe(true)
  expect(lease(files).expiresAt).toBe(NOW + 90000)
})

test('respects a live lease held by another session', async () => {
  const held = JSON.stringify({ sessionId: 'S2', expiresAt: NOW + 10 })
  const { io, files } = fakeIo({ files: { [`${D}/lease.json`]: held } })
  expect(await tryLead(io, D, 'S1', NOW)).toBe(false)
  expect(files.get(`${D}/lease.json`)!.text).toBe(held)
  expect(files.has(`${D}/lease.lock/`)).toBe(false)
})

test('takes over an expired lease', async () => {
  const { io, files } = fakeIo({ files: { [`${D}/lease.json`]: JSON.stringify({ sessionId: 'S2', expiresAt: NOW - 1 }) } })
  expect(await tryLead(io, D, 'S1', NOW)).toBe(true)
  expect(lease(files).sessionId).toBe('S1')
})

test('takes over an unparsable lease', async () => {
  const { io } = fakeIo({ files: { [`${D}/lease.json`]: '{' } })
  expect(await tryLead(io, D, 'S1', NOW)).toBe(true)
})

test('two sessions racing: exactly one wins', async () => {
  const { io, now, argv } = fakeIo()
  now.ms = NOW
  const r = await Promise.all([tryLead(io, D, 'S1', NOW), tryLead(io, D, 'S2', NOW)])
  expect(r.filter(Boolean)).toHaveLength(1)
  // A stale-lock steal would add a second rmdir.
  expect(argv.filter((a) => a[0] === 'rmdir')).toHaveLength(1)
})

test('a loser leaves a fresh lock alone', async () => {
  const { io, files } = fakeIo()
  files.set(`${D}/lease.lock/`, { text: '', mtimeMs: NOW })
  expect(await tryLead(io, D, 'S1', NOW)).toBe(false)
  expect(files.has(`${D}/lease.lock/`)).toBe(true)
})

test('a stale lock older than 5s is removed and the lease taken', async () => {
  const { io, files } = fakeIo()
  files.set(`${D}/lease.lock/`, { text: '', mtimeMs: NOW - 6000 })
  expect(await tryLead(io, D, 'S1', NOW)).toBe(true)
  expect(files.has(`${D}/lease.lock/`)).toBe(false)
})

test('release writes expiresAt 0 only when it holds the lease', async () => {
  const mine = fakeIo({ files: { [`${D}/lease.json`]: JSON.stringify({ sessionId: 'S1', expiresAt: NOW }) } })
  await release(mine.io, D, 'S1', NOW)
  expect(lease(mine.files)).toEqual({ sessionId: 'S1', expiresAt: 0 })
  const theirs = fakeIo({ files: { [`${D}/lease.json`]: JSON.stringify({ sessionId: 'S2', expiresAt: NOW }) } })
  await release(theirs.io, D, 'S1', NOW)
  expect(lease(theirs.files)).toEqual({ sessionId: 'S2', expiresAt: NOW })
})

test('release leaves lease and a fresh foreign lock untouched', async () => {
  const held = JSON.stringify({ sessionId: 'S1', expiresAt: NOW })
  const { io, files } = fakeIo({ files: { [`${D}/lease.json`]: held } })
  files.set(`${D}/lease.lock/`, { text: '', mtimeMs: NOW })
  await release(io, D, 'S1', NOW)
  expect(files.get(`${D}/lease.json`)!.text).toBe(held)
  expect(files.has(`${D}/lease.lock/`)).toBe(true)
})
