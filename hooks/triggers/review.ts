import type { Data, Item } from '../../types'
import { isBot } from '../bots'
import { labelOf, type Ctx, type Event, type TriggerOut } from './types'

export function reviews(d: Data, ctx: Ctx): TriggerOut {
  const before = ctx.prev.items.filter((i) => i.kind === 'review')
  if (ctx.failed.has('rr')) return { items: before, events: [] }

  const items: Item[] = []
  const events: Event[] = []
  for (const pr of d.rr.nodes) {
    const bot = isBot(pr.author)
    if (bot && !ctx.cfg.includeBots) continue
    const direct = pr.reviewRequests.nodes.some(
      (n) => n.requestedReviewer?.__typename === 'User' && n.requestedReviewer.login === ctx.me,
    )
    const dim = !direct || pr.isDraft || bot
    const old = before.find((i) => i.prId === pr.id)
    const key = old?.key ?? `rr:${pr.id}:${ctx.now}`
    const who = pr.author?.login ?? 'ghost'
    items.push({
      key,
      kind: 'review',
      prId: pr.id,
      repo: pr.repository.nameWithOwner.split('/').pop() ?? '',
      number: pr.number,
      title: pr.title,
      url: pr.url,
      at: old?.at ?? ctx.now,
      who: [who],
      count: 1,
      dim,
      tag: null,
    })
    const ready = !!old?.dim && !dim
    if (old && !ready) continue
    events.push({
      key: ready ? `${key}:ready` : key,
      kind: 'review',
      notify: !dim,
      prId: pr.id,
      label: labelOf(pr.repository.nameWithOwner, pr.number),
      title: pr.title,
      who,
      detail: '',
    })
  }
  return { items, events }
}
