import type { Data, Item } from '../../types'
import { isBot } from '../bots'
import { labelOf, type Ctx, type Event, type TriggerOut } from './types'

export function approvals(d: Data, ctx: Ctx): TriggerOut {
  const fadeMs = ctx.cfg.fadeMinutes * 60_000
  const before = ctx.prev.items.filter((i) => i.kind === 'approved')
  const live = (at: number) => ctx.now - at < fadeMs
  if (ctx.failed.has('mine')) return { items: before.filter((i) => live(i.at)), events: [] }

  const items: Item[] = []
  const events: Event[] = []
  for (const pr of d.mine.nodes) {
    for (const r of pr.latestOpinionatedReviews.nodes) {
      if (r.state !== 'APPROVED' || isBot(r.author) || r.author?.login === ctx.me) continue
      const key = `a:${r.id}`
      const old = before.find((i) => i.key === key)
      const at = old?.at ?? ctx.now
      const first = !old && !(key in ctx.prev.seen)
      if (live(at) && (old || first)) {
        items.push({
          key,
          kind: 'approved',
          prId: pr.id,
          repo: pr.repository.nameWithOwner.split('/').pop() ?? '',
          number: pr.number,
          title: pr.title,
          url: pr.url,
          at,
          who: [r.author?.login ?? ''],
          count: 1,
          dim: false,
          tag: null,
        })
      }
      // Always emitted so reduce keeps refreshing the seen time while the approval stands.
      events.push({
        key,
        kind: 'approved',
        notify: first,
        prId: pr.id,
        label: labelOf(pr.repository.nameWithOwner, pr.number),
        title: pr.title,
        who: r.author?.login ?? '',
        detail: pr.reviewDecision === 'APPROVED' ? 'ready to merge' : '',
      })
    }
  }
  return { items, events }
}
