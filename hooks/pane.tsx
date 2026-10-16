import type { EngineInterface, ResolveInput } from 'claude-code'

import type { Item, Kind, PaneState, Settings } from '../types'
import { ICON } from './band'
import {
  KINDS,
  columnState,
  effective,
  groupState,
  isTracked,
  toggleAllRepos,
  toggleColumn,
  toggleDefault,
  toggleRepoAll,
  toggleRepoKind,
  toggleTracked,
} from './settings'
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

const BOX: Record<Group, string> = { on: '[x]', off: '[ ]', mixed: '[-]' }
const box = (on: boolean) => BOX[on ? 'on' : 'off']

export type PaneHandlers = {
  press: (change: (s: Settings) => Settings) => Promise<unknown>
  filter: (text: string) => Promise<unknown>
}

export async function drawPane($: EngineInterface, e: ResolveInput, view: PaneView, p: PaneState, on: PaneHandlers) {
  const els = $.ui.resolve(e)
  const { Box, Button, Text } = els
  const btn = (key: string, label: string, change: (s: Settings) => Settings) => (
    <Button key={key} onPress={() => void on.press(change)}>
      {label}
    </Button>
  )
  return (
    <Box flexDirection="column">
      <Box gap={1}>
        {btn('all-repos', `${box(view.allRepos)} All repos (live)`, toggleAllRepos)}
        <Text>new repos get:</Text>
        {KINDS.map((k) => btn(`default:${k}`, `${box(view.defaults[k])}${ICON[k]}`, (s) => toggleDefault(s, k)))}
        {p.save && <Text dimColor>{p.save === 'saved' ? 'saved' : '⚠ not saved'}</Text>}
      </Box>
      {p.isInvalid && <Text dimColor>settings file unreadable, using defaults</Text>}
      {'Input' in els && (
        <els.Input
          key="filter"
          label="filter:"
          value={p.filter}
          onInput={(v: string) => void on.filter(v)}
          onSubmit={(v: string) => void on.filter(v)}
        />
      )}
      <Box gap={1}>
        <Text>every tracked repo</Text>
        {btn('col:all', `${BOX[view.column.all]} all`, (s) => toggleColumn(s, 'all'))}
        {KINDS.map((k) => btn(`col:${k}`, `${BOX[view.column.kinds[k]]}${ICON[k]}`, (s) => toggleColumn(s, k)))}
      </Box>
      {view.rows.map((r) => (
        <Box key={r.repo} gap={1}>
          {btn(`track:${r.repo}`, box(r.tracked), (s) => toggleTracked(s, r.repo))}
          <Text>{r.repo}</Text>
          {r.tracked
            ? [
                btn(`row:${r.repo}`, `${BOX[r.all]} all`, (s) => toggleRepoAll(s, r.repo)),
                ...KINDS.map((k) => btn(`kind:${r.repo}:${k}`, box(r.kinds[k]), (s) => toggleRepoKind(s, r.repo, k))),
              ]
            : ['all', ...KINDS].map((c) => (
                <Text key={c} dimColor>
                  ·
                </Text>
              ))}
        </Box>
      ))}
      {view.footer && <Text dimColor>{view.footer}</Text>}
    </Box>
  )
}
