import type { Item, Kind, Settings } from '../types'
import { KINDS, columnState, effective, groupState, isTracked } from './settings'
import type { Group } from './settings'

export type PaneRow = { repo: string; tracked: boolean; all: Group; kinds: Record<Kind, boolean> }
export type PaneView = {
  allRepos: boolean
  defaults: Record<Kind, boolean>
  column: { all: Group; kinds: Record<Kind, Group> }
  rows: PaneRow[]
  footer: string | null
}

const ROW_CAP = 40

const byKind = <T,>(f: (k: Kind) => T): Record<Kind, T> =>
  Object.fromEntries(KINDS.map((k) => [k, f(k)])) as Record<Kind, T>

const row = (s: Settings, repo: string): PaneRow => {
  const on = effective(s, repo)
  return {
    repo,
    tracked: isTracked(s, repo),
    all: isTracked(s, repo) ? groupState(on.length, KINDS.length) : 'off',
    kinds: byKind((k) => on.includes(k)),
  }
}

// Repos the user has an entry for, or that show on the band, sort ahead of the
// fetched list so the 40-row cap never hides them.
export function paneView(
  s: Settings,
  repos: string[] | null,
  loadError: string | null,
  items: Item[],
  filter: string,
): PaneView {
  const needle = filter.toLowerCase()
  const candidates = [...new Set([...Object.keys(s.repos), ...items.map((i) => i.fullRepo), ...(repos ?? [])])]
    .filter((r) => r.toLowerCase().includes(needle))
  const footer =
    repos === null && !loadError
      ? 'loading repos…'
      : loadError
        ? `couldn't load repos: ${loadError}`
        : candidates.length > ROW_CAP
          ? `showing ${ROW_CAP} of ${candidates.length} · type to filter`
          : null
  return {
    allRepos: s.allRepos,
    defaults: byKind((k) => s.defaults.includes(k)),
    column: { all: columnState(s, 'all'), kinds: byKind((k) => columnState(s, k)) },
    rows: candidates.slice(0, ROW_CAP).map((r) => row(s, r)),
    footer,
  }
}
