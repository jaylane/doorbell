import type { Alias, Data, Item, Pending, State } from '../../types'
import { labelOf, type Ctx, type Event, type TriggerOut } from './types'

type Out = TriggerOut & Pick<State, 'pendingShip' | 'releases' | 'latest'>
type Release = { tagName: string; isDraft: boolean; isPrerelease: boolean }
type Probe = { releases?: { nodes: Release[] }; ref?: { compare: { status: string } | null } | null } | null

export function shipped(d: Data, aliases: Record<string, Alias>, ctx: Ctx): Out {
  const { prev } = ctx
  const fadeMs = ctx.cfg.fadeMinutes * 60_000
  const latest = { ...prev.latest }
  const releases = { ...prev.releases }
  const waiting: Record<string, Pending> = ctx.failed.has('merged') ? { ...prev.pendingShip } : {}
  if (!ctx.failed.has('merged')) {
    for (const pr of d.merged.nodes) {
      if (!pr.mergeCommit || `s:${pr.id}` in prev.seen) continue
      waiting[pr.id] = { ...prev.pendingShip[pr.id], repo: pr.repository.nameWithOwner, number: pr.number, title: pr.title, url: pr.url, mergeOid: pr.mergeCommit.oid }
    }
  }

  const contained: [string, string][] = []
  for (const [id, a] of Object.entries(aliases)) {
    const v = ctx.failed.has(id) ? null : (d[id] as Probe | undefined) ?? null
    if (a.kind === 'release') {
      const tag = v?.releases?.nodes.find((r) => !r.isDraft && !r.isPrerelease)?.tagName
      if (tag) latest[a.repo] = tag
      continue
    }
    // An errored compare is retried, so it leaves the PR's compared tag as it was.
    if (!v || (v.ref && !v.ref.compare)) continue
    releases[a.repo] = a.tag
    if (waiting[a.prId]) waiting[a.prId] = { ...waiting[a.prId]!, compared: a.tag }
    if (v.ref && ['BEHIND', 'IDENTICAL'].includes(v.ref.compare!.status)) contained.push([a.prId, a.tag])
  }

  const events: Event[] = []
  const fresh: Item[] = []
  for (const [prId, tag] of contained) {
    const p = prev.pendingShip[prId] ?? waiting[prId]
    if (!p) continue
    delete waiting[prId]
    const known = prev.releases[p.repo] !== undefined
    events.push({ key: `s:${prId}`, kind: 'shipped', notify: known, prId, label: labelOf(p.repo, p.number), title: p.title, who: '', detail: tag })
    if (known) {
      fresh.push({
        key: `s:${prId}`, kind: 'shipped', prId, repo: p.repo.split('/').pop() ?? '', number: p.number,
        title: p.title, url: p.url, at: ctx.now, who: [], count: 1, dim: false, tag,
      })
    }
  }
  // Faded by age alone, so a failed search never drops or revives one.
  const kept = prev.items.filter((i) => i.kind === 'shipped' && ctx.now - i.at < fadeMs && !fresh.some((f) => f.key === i.key))
  return { items: [...kept, ...fresh], events, pendingShip: waiting, releases, latest }
}

export const giveUpCompares = (prev: State, aliases: Record<string, Alias>): Pick<State, 'releases' | 'pendingShip'> => {
  const releases = { ...prev.releases }
  const pendingShip = { ...prev.pendingShip }
  for (const a of Object.values(aliases)) {
    if (a.kind !== 'compare') continue
    releases[a.repo] = a.tag
    if (pendingShip[a.prId]) pendingShip[a.prId] = { ...pendingShip[a.prId]!, compared: a.tag }
  }
  return { releases, pendingShip }
}
