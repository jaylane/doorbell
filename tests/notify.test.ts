import { expect, test } from 'claude-code/testing'
import { fakeIo } from './fakes'
import { send } from '../hooks/notify'

const note = { title: 'Comments on app#1', body: 'alice: 2 new' }
const osa = (body: string, title: string) => ['osascript', '-e', `display notification "${body}" with title "${title}"`]

test('sends through ui.notify with title Doorbell', async () => {
  const calls: unknown[][] = []
  const { io, argv } = fakeIo({ notify: async (...a) => (calls.push(a), { isSent: true as const, channel: 'iterm2' }) })
  await send(io, [note])
  expect(calls).toEqual([['Comments on app#1: alice: 2 new', { title: 'Doorbell' }]])
  expect(argv).toEqual([])
})

test('falls back to osascript on terminal_bell', async () => {
  const { io, argv } = fakeIo({ notify: async () => ({ isSent: true as const, channel: 'terminal_bell' }) })
  await send(io, [note])
  expect(argv).toEqual([osa('alice: 2 new', 'Comments on app#1')])
})

test('falls back on no-channel and no-surface, never on disabled or refused', async () => {
  for (const [reason, n] of [['no-channel', 1], ['no-surface', 1], ['disabled', 0], ['refused', 0]] as const) {
    const { io, argv } = fakeIo({ notify: async () => ({ isSent: false as const, reason }) })
    await send(io, [note])
    expect(argv).toHaveLength(n)
  }
})

test('escapes quotes and backslashes', async () => {
  const { io, argv } = fakeIo({ notify: async () => ({ isSent: true as const, channel: 'terminal_bell' }) })
  await send(io, [{ title: 'a"b', body: 'c\\d "e"' }])
  expect(argv).toEqual([osa('c\\\\d \\"e\\"', 'a\\"b')])
})

test('notify errors are swallowed', async () => {
  const { io } = fakeIo({ notify: async () => { throw new Error('boom') } })
  await send(io, [note, note])
})

test('osascript failure is swallowed and later notes still send', async () => {
  const { io, argv } = fakeIo({
    notify: async () => ({ isSent: true as const, channel: 'terminal_bell' }),
    run: () => 'throw',
  })
  await send(io, [note, note])
  expect(argv).toHaveLength(2)
})
