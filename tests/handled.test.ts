import { expect, test } from 'claude-code/testing'
import { fakeIo } from './fakes'
import { addHandled, handledMtime, readHandled } from '../hooks/handled'

const D = '/c'

test('readHandled: missing, garbage and wrong shapes read as empty', async () => {
  expect(await readHandled(fakeIo().io, D)).toEqual([])
  for (const text of ['{"ids":', 'null', '[]', '{}', '{"ids":"a"}', '{"ids":[1]}']) {
    expect(await readHandled(fakeIo({ files: { [`${D}/handled.json`]: text } }).io, D)).toEqual([])
  }
  const ok = fakeIo({ files: { [`${D}/handled.json`]: '{"ids":["a","b"]}' } })
  expect(await readHandled(ok.io, D)).toEqual(['a', 'b'])
})

test('addHandled twice keeps one, and handledMtime follows the file', async () => {
  const { io } = fakeIo()
  expect(await handledMtime(io, D)).toBeNull()
  await addHandled(io, D, 'S1', 'x')
  await addHandled(io, D, 'S1', 'x')
  await addHandled(io, D, 'S1', 'y')
  expect(await readHandled(io, D)).toEqual(['x', 'y'])
  expect(await handledMtime(io, D)).toBe(1_000)
})

test('addHandled writes tmp then mv, and rejects when mv fails', async () => {
  const { io, argv, files } = fakeIo()
  await addHandled(io, D, 'S1', 'x')
  expect(argv).toContainEqual(['mv', `${D}/handled.json.S1.tmp`, `${D}/handled.json`])
  expect(JSON.parse(files.get(`${D}/handled.json`)!.text)).toEqual({ ids: ['x'] })
  const orig = io.process.run
  io.process.run = async (a, i) => (a[0] === 'mv' ? { exitCode: 1, stdout: '', stderr: 'x' } : orig(a, i))
  let failed = false
  await addHandled(io, D, 'S1', 'z').catch(() => (failed = true))
  expect(failed).toBe(true)
})
