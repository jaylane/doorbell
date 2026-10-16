import type { Author, Data, Item, MinePr } from '../../types'
import { isBot } from '../bots'
import { labelOf, type Ctx, type Event, type TriggerOut } from './types'

const ms = (iso: string): number => Date.parse(iso)

/** Latest of my own activity on the PR, judged by GitHub timestamps so a late poll cannot misorder a push. */
export function watermarkOf(pr: MinePr, me: string): number {
  const mine = [
    ...pr.comments.nodes,
    ...pr.reviews.nodes,
    ...pr.reviewThreads.nodes.flatMap((t) => t.comments.nodes),
  ].filter((n) => n.viewerDidAuthor)
  const head = pr.commits.nodes[0]?.commit
  const times = mine.map((n) => ms(n.createdAt))
  if (head?.author?.user?.login === me) times.push(ms(head.committedDate))
  return Math.max(0, ...times)
}

type Candidate = { id: string; createdAt: string; author: Author }

export function comments(d: Data, ctx: Ctx): TriggerOut {
  const before = ctx.prev.items.filter((i) => i.kind === 'comment')
  if (ctx.failed.has('mine')) return { items: before, events: [] }

  const items: Item[] = []
  const events: Event[] = []
  for (const pr of d.mine.nodes) {
    const mark = watermarkOf(pr, ctx.me)
    const candidates: Candidate[] = [
      ...pr.comments.nodes,
      ...pr.reviewThreads.nodes.flatMap((t) => t.comments.nodes),
      ...pr.reviews.nodes.filter((r) => r.state === 'CHANGES_REQUESTED' || (r.state === 'COMMENTED' && r.bodyText !== '')),
    ]
    const counted = candidates
      .filter((c) => c.author?.login !== ctx.me && ms(c.createdAt) > mark && (ctx.cfg.includeBots || !isBot(c.author)))
      .sort((a, b) => ms(a.createdAt) - ms(b.createdAt))
    if (!counted.length) continue

    const label = labelOf(pr.repository.nameWithOwner, pr.number)
    for (const c of counted) {
      events.push({
        key: `c:${c.id}`,
        kind: 'comment',
        notify: !isBot(c.author),
        prId: pr.id,
        label,
        title: pr.title,
        who: c.author?.login ?? 'ghost',
        detail: '',
      })
    }
    items.push({
      key: `c:${pr.id}`,
      kind: 'comment',
      prId: pr.id,
      repo: pr.repository.nameWithOwner.split('/').pop() ?? '',
      number: pr.number,
      title: pr.title,
      url: pr.url,
      at: before.find((i) => i.prId === pr.id)?.at ?? ctx.now,
      who: [...new Set(events.filter((e) => e.prId === pr.id).map((e) => e.who))],
      count: counted.length,
      dim: false,
      tag: null,
    })
  }
  return { items, events }
}
