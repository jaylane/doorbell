import type { Alias, Config, Data, Note, State } from '../types'
import { afterSuccess } from './backoff'
import { PAGE } from './query'
import { approvals } from './triggers/approved'
import { comments } from './triggers/comments'
import { reviews } from './triggers/review'
import { shipped } from './triggers/shipped'
import type { Ctx, Event } from './triggers/types'

const DAY = 86_400_000
const ORDER = ['review', 'approved', 'comment', 'shipped']

export function failedSet(d: Data, failedPaths: string[]): Set<string> {
  const failed = new Set(failedPaths)
  for (const name of ['mine', 'rr', 'merged'] as const) if (d[name].issueCount > PAGE[name]) failed.add(name)
  return failed
}

export function reduce(
  prev: State,
  d: Data,
  failedPaths: string[],
  aliases: Record<string, Alias>,
  now: number,
  cfg: Config,
): { state: State; notes: Note[] } {
  const failed = failedSet(d, failedPaths)
  const ctx: Ctx = { now, me: d.viewer.login, cfg, prev, failed }
  const rv = reviews(d, ctx)
  const cm = comments(d, ctx)
  const ap = approvals(d, ctx)
  const sh = shipped(d, aliases, ctx)
  const events = [...rv.events, ...cm.events, ...ap.events, ...sh.events]

  const seen: Record<string, number> = { ...prev.seen }
  for (const e of events) seen[e.key] = now
  for (const k of Object.keys(seen)) if (seen[k]! < now - 30 * DAY) delete seen[k]

  const fresh = events.filter((e) => e.notify && !(e.key in prev.seen))
  const state: State = {
    ...prev,
    items: [...rv.items, ...cm.items, ...ap.items, ...sh.items],
    seen,
    releases: sh.releases,
    latest: sh.latest,
    pendingShip: sh.pendingShip,
    bootstrapped: true,
    pathlessQueryFailures: 0,
    lastOkAt: now,
    lastAttemptAt: now,
    ...afterSuccess(failed.size > 0),
  }
  return { state, notes: prev.bootstrapped ? notesOf(fresh) : [] }
}

const noteOf = (group: Event[]): Note => {
  const kind = ORDER.find((k) => group.some((e) => e.kind === k))!
  const own = group.filter((e) => e.kind === kind)
  const e = own[0]!
  const more = group.length - (kind === 'comment' ? own.length : 1)
  const tail = more > 0 ? ` · +${more} more` : ''
  switch (kind) {
    case 'review':
      return { title: 'Review requested', body: `${e.who} wants your review on ${e.label}: ${e.title}${tail}` }
    case 'approved':
      return { title: `${e.label} approved`, body: `by ${e.who}${e.detail === 'ready to merge' ? ' · ready to merge' : ''}${tail}` }
    case 'comment': {
      const who = [...new Set(own.map((c) => c.who))].join(', ')
      return { title: `Comments on ${e.label}`, body: `${who}: ${own.length} new${tail}` }
    }
    default:
      return { title: `${e.label} shipped`, body: `in ${e.detail}${tail}` }
  }
}

export function notesOf(events: Event[]): Note[] {
  const groups = new Map<string, Event[]>()
  for (const e of events) groups.set(e.prId, [...(groups.get(e.prId) ?? []), e])
  const all = [...groups.values()]
  if (all.length > 3) {
    return [{ title: `${all.length} PR updates`, body: all.map((g) => g[0]!.label).join(', ') }]
  }
  return all.map(noteOf)
}
