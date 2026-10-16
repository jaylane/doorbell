import type { EngineInterface } from 'claude-code'

import type { Run } from '../types'
import { send } from './notify'
import { forSubagent, slashCommand } from './template'

const ENDED: readonly string[] = ['completed', 'failed', 'killed']
const LOST = 600_000
// An agent absent before it was ever listed may not be listed yet, so only a seen one counts as gone.
// One never listed within LOST is dropped silently, or the map would hold it for the life of the process.
const agents = new Map<string, { label: string; seen: boolean; spawnedAt: number }>()

// A subagent's prompt can hold a slash line, but this session's prompt cannot: submit would not run it as a command.
export async function runSession($: EngineInterface, text: string): Promise<void> {
  const c = slashCommand(text)
  if (!c) {
    const r = await $.prompt.submit({ text })
    if (r.drop !== undefined) throw new Error(`prompt dropped: ${r.drop}`)
    return
  }
  if (!(await $.command.list()).some((x) => x.name === c.command)) throw new Error(`command not found: /${c.command}`)
  await $.command.run(c)
}

export async function runAction($: EngineInterface, run: Run, notify: boolean, now: number): Promise<void> {
  if (run.mode === 'session') return runSession($, run.text)
  const r = await $.agent.spawn({ prompt: forSubagent(run.text), description: `Doorbell: ${run.label}` })
  if (!r.agentId) throw new Error(r.deny ?? 'background agent did not start')
  agents.set(r.agentId, { label: run.label, seen: false, spawnedAt: now })
  if (notify) await send($, [{ title: `Running ${run.label}`, body: 'in a background agent' }])
}

export async function checkAgents($: EngineInterface, notify: boolean, now: number): Promise<void> {
  if (!agents.size) return
  const list = await $.agent.list()
  for (const [id, a] of agents) {
    const info = list.find((x) => x.id === id)
    if (info && !ENDED.includes(info.status)) a.seen = true
    else if (info || a.seen) {
      agents.delete(id)
      if (notify) await send($, [{ title: `Finished ${a.label}`, body: 'background agent done' }])
    } else if (now - a.spawnedAt > LOST) agents.delete(id)
  }
}
