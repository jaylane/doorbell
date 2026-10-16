import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import { checkAgents, runAction, runSession } from '../hooks/run'
import type { Run } from '../types'

type Status = 'running' | 'idle' | 'completed' | 'failed' | 'killed'

// Only the calls run.ts makes; the engine-level tests cannot hand the plugin an agentId.
const fake = (opts: { commands?: string[]; spawn?: { agentId?: string; deny?: string } } = {}) => {
  const calls: unknown[][] = []
  const notes: string[] = []
  const agents: { id: string; status: Status }[] = []
  const $ = {
    command: {
      list: async () => (opts.commands ?? ['review']).map((name) => ({ name })),
      run: async (a: unknown) => (calls.push(['command.run', a]), {}),
    },
    prompt: { submit: async (a: { text: string }) => (calls.push(['prompt.submit', a]), { text: a.text }) },
    agent: {
      spawn: async (a: unknown) => (calls.push(['agent.spawn', a]), { model: 'm', ...(opts.spawn ?? { agentId: 'A1' }) }),
      list: async () => agents,
    },
    ui: { notify: async (text: string) => (notes.push(text), { isSent: true as const, channel: 'iterm2' }) },
    process: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
  } as unknown as EngineInterface
  return { $, calls, notes, agents }
}
const run = (over: Partial<Run> = {}): Run => ({
  id: 'act:x', trigger: 'review', prId: 'PR2', label: 'app#2', text: '/review https://x/2', mode: 'background', ...over,
})

test('runSession runs a listed slash command and submits plain text', async () => {
  const f = fake()
  await runSession(f.$, '/review https://x/2')
  await runSession(f.$, 'Look at https://x/2')
  expect(f.calls).toEqual([
    ['command.run', { command: 'review', args: 'https://x/2' }],
    ['prompt.submit', { text: 'Look at https://x/2' }],
  ])
})

test('runSession rejects a command the session does not have, without running it', async () => {
  const f = fake({ commands: [] })
  await expect(runSession(f.$, '/review u')).rejects.toThrow('command not found: /review')
  expect(f.calls).toEqual([])
})

test('background spawns with the Skill-tool prompt and notifies Running', async () => {
  const f = fake({ spawn: { agentId: 'B1' } })
  await runAction(f.$, run(), true, 0)
  expect(f.calls).toEqual([['agent.spawn', { prompt: 'Use the review skill (Skill tool) with these arguments: https://x/2', description: 'Doorbell: app#2' }]])
  expect(f.notes).toEqual(['Running app#2: in a background agent'])
  f.agents.push({ id: 'B1', status: 'completed' })
  await checkAgents(f.$, true, 0)
})

test('a denied spawn rejects with the reason', async () => {
  const f = fake({ spawn: { deny: 'no agents here' } })
  await expect(runAction(f.$, run(), true, 0)).rejects.toThrow('no agents here')
  expect(f.notes).toEqual([])
})

test('Finished once the agent reports completed; idle is not done', async () => {
  const f = fake({ spawn: { agentId: 'C1' } })
  await runAction(f.$, run(), true, 0)
  f.agents.push({ id: 'C1', status: 'running' })
  await checkAgents(f.$, true, 0)
  f.agents[0]!.status = 'idle'
  await checkAgents(f.$, true, 0)
  expect(f.notes).toEqual(['Running app#2: in a background agent'])
  f.agents[0]!.status = 'completed'
  await checkAgents(f.$, true, 0)
  await checkAgents(f.$, true, 0)
  expect(f.notes).toEqual(['Running app#2: in a background agent', 'Finished app#2: background agent done'])
})

test('Finished when a seen agent vanishes, not before it was ever listed', async () => {
  const f = fake({ spawn: { agentId: 'D1' } })
  await runAction(f.$, run(), false, 0)
  await checkAgents(f.$, true, 0)
  expect(f.notes).toEqual([])
  f.agents.push({ id: 'D1', status: 'running' })
  await checkAgents(f.$, true, 0)
  f.agents.length = 0
  await checkAgents(f.$, true, 0)
  expect(f.notes).toEqual(['Finished app#2: background agent done'])
})

test('failed and killed agents are done', async () => {
  const f = fake({ spawn: { agentId: 'E1' } })
  await runAction(f.$, run(), false, 0)
  const g = fake({ spawn: { agentId: 'E2' } })
  await runAction(g.$, run({ label: 'app#3' }), false, 0)
  f.agents.push({ id: 'E1', status: 'failed' }, { id: 'E2', status: 'killed' })
  await checkAgents(f.$, true, 0)
  expect(f.notes).toEqual(['Finished app#2: background agent done', 'Finished app#3: background agent done'])
})

test('an agent never listed for 10 minutes is dropped without a Finished note', async () => {
  const f = fake({ spawn: { agentId: 'F1' } })
  await runAction(f.$, run(), false, 0)
  await checkAgents(f.$, true, 600_000)
  f.agents.push({ id: 'F1', status: 'completed' })
  await checkAgents(f.$, true, 600_001)
  expect(f.notes).toEqual(['Finished app#2: background agent done'])
  const g = fake({ spawn: { agentId: 'F2' } })
  await runAction(g.$, run(), false, 0)
  await checkAgents(g.$, true, 600_001)
  g.agents.push({ id: 'F2', status: 'completed' })
  await checkAgents(g.$, true, 600_002)
  expect(g.notes).toEqual([])
})
