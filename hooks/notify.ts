import type { Note } from '../types'
import type { Io } from './io'

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

// A bell or a missing surface shows nothing; `disabled` and `refused` are a decision, so they send nothing.
const needsFallback = (r: { isSent: true; channel: string } | { isSent: false; reason: string }) =>
  r.isSent ? r.channel === 'terminal_bell' : r.reason === 'no-channel' || r.reason === 'no-surface'

export const send = async (io: Io, notes: Note[]): Promise<void> => {
  for (const { title, body } of notes) {
    try {
      const r = await io.ui.notify(`${title}: ${body}`, { title: 'Doorbell' })
      if (needsFallback(r)) {
        await io.process.run(['osascript', '-e', `display notification "${esc(body)}" with title "${esc(title)}"`])
      }
    } catch {}
  }
}
