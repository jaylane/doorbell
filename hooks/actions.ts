import type { Ask, Item, Run, Settings, State, Trigger } from '../types'
import { effectiveMode } from './settings'
import { render } from './template'
import type { Event } from './triggers/types'

const HOUR = 3_600_000
const CAP = 3
const TRIGGERS: readonly Trigger[] = ['review', 'comment']

const askOf = (t: Trigger, id: string, e: Event, prompt: string, author: string, comments: string): Ask => ({
  id,
  trigger: t,
  prId: e.prId,
  label: e.label,
  text: render(prompt, { pr_url: e.url, repo: e.fullRepo, number: String(e.number), title: e.title, author, comments }),
})

export function firings(fresh: Event[], settings: Settings): Ask[] {
  const out: Ask[] = []
  const review = settings.actions.review
  if (effectiveMode(review) !== 'off') {
    for (const e of fresh) if (e.kind === 'review') out.push(askOf('review', `act:${e.key}`, e, review.prompt, e.who, ''))
  }
  const comment = settings.actions.comment
  if (effectiveMode(comment) !== 'off') {
    const byPr = new Map<string, Event[]>()
    for (const e of fresh) if (e.kind === 'comment') byPr.set(e.prId, [...(byPr.get(e.prId) ?? []), e])
    for (const [prId, cs] of byPr) {
      const last = cs[cs.length - 1]!
      const author = [...new Set(cs.map((c) => c.who))].join(', ')
      const lines = cs.map((c) => `- ${c.who}: ${c.excerpt}`).join('\n')
      out.push(askOf('comment', `act:c:${prId}:${last.key}`, last, comment.prompt, author, lines))
    }
  }
  return out
}

export function plan(
  prev: State,
  fired: Ask[],
  settings: Settings,
  now: number,
  handled: readonly string[],
  items: Item[],
): { runs: Run[]; asks: Ask[]; actionRuns: Record<Trigger, number[]>; actionPaused: boolean } {
  const actionRuns = {
    review: prev.actionRuns.review.filter((t) => t >= now - HOUR),
    comment: prev.actionRuns.comment.filter((t) => t >= now - HOUR),
  }
  const runs: Run[] = []
  const fresh: Ask[] = []
  for (const a of fired) {
    const mode = effectiveMode(settings.actions[a.trigger])
    if ((mode === 'session' || mode === 'background') && actionRuns[a.trigger].length < CAP) {
      runs.push({ ...a, mode })
      actionRuns[a.trigger].push(now)
    } else fresh.push(a)
  }
  // The band shows one ask per PR and trigger, so a newer ask replaces the one it would hide.
  const stale = (p: Ask) => fresh.some((f) => f.trigger === p.trigger && f.prId === p.prId)
  const live = (a: Ask) => !handled.includes(a.id) && items.some((i) => i.prId === a.prId && i.kind === a.trigger)
  return {
    runs,
    asks: [...prev.asks.filter((p) => !stale(p)), ...fresh].filter(live),
    actionRuns,
    actionPaused: TRIGGERS.some((t) => actionRuns[t].length >= CAP),
  }
}
