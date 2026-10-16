import type { EngineInterface, ResolveInput } from 'claude-code'

import type { ActionMode, Item, Kind, PaneState, Settings, Trigger } from '../types'
import { ICON } from './band'
import {
  KINDS,
  TRIGGERS,
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
import { PLACEHOLDERS, unknownPlaceholders } from './template'

export type PaneRow = { repo: string; tracked: boolean; all: Group; kinds: Record<Kind, boolean> }
export type PaneView = {
  allRepos: boolean
  defaults: Record<Kind, boolean>
  column: { all: Group; kinds: Record<Kind, Group> }
  rows: PaneRow[]
  actions: Record<Trigger, { mode: ActionMode; prompt: string; problem: string | null }>
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
// fetched list so they are listed first under the 40-row cap.
export function paneView(
  s: Settings,
  repos: string[] | null,
  loadError: string | null,
  items: Item[],
  filter: string,
  drafts: PaneState['drafts'] = {},
): PaneView {
  const needle = filter.toLowerCase()
  const candidates = [...new Set([...Object.keys(s.repos), ...items.map((i) => i.fullRepo), ...(repos ?? [])])]
    .filter((r) => r.toLowerCase().includes(needle))
  const failed = loadError ? `couldn't load repos: ${loadError}` : null
  const capped = candidates.length > ROW_CAP ? `showing ${ROW_CAP} of ${candidates.length} · type to filter` : null
  const footer = repos === null && !loadError ? 'loading repos…' : [failed, capped].filter(Boolean).join(' · ') || null
  return {
    allRepos: s.allRepos,
    defaults: byKind((k) => s.defaults.includes(k)),
    column: { all: columnState(s, 'all'), kinds: byKind((k) => columnState(s, k)) },
    rows: candidates.slice(0, ROW_CAP).map((r) => row(s, r)),
    actions: Object.fromEntries(
      TRIGGERS.map((t) => {
        const { mode } = s.actions[t]
        const prompt = drafts[t] ?? s.actions[t].prompt
        const unknown = unknownPlaceholders(prompt)
        const problem = unknown.length
          ? `unknown: ${unknown.map((n) => `{${n}}`).join(', ')}`
          : mode !== 'off' && prompt.trim() === '' ? 'off: prompt is empty' : null
        return [t, { mode, prompt, problem }]
      }),
    ) as PaneView['actions'],
    footer,
  }
}

const BOX: Record<Group, string> = { on: '[x]', off: '[ ]', mixed: '[-]' }
const box = (on: boolean) => BOX[on ? 'on' : 'off']

export type PaneHandlers = {
  press: (change: (s: Settings) => Settings) => Promise<unknown>
  filter: (text: string) => Promise<unknown>
  mode: (t: Trigger, mode: ActionMode) => Promise<unknown>
  prompt: (t: Trigger, text: string) => Promise<unknown>
  draft: (t: Trigger, text: string) => Promise<unknown>
}

const TRIGGER_LABEL: Record<Trigger, string> = { review: '👀 review requested', comment: '💬 new comment' }
const MODE_OPTIONS = [
  { value: 'off', label: 'off' },
  { value: 'ask', label: 'ask' },
  { value: 'session', label: 'auto · session' },
  { value: 'background', label: 'auto · background' },
]

export async function drawPane($: EngineInterface, e: ResolveInput, view: PaneView, p: PaneState, on: PaneHandlers) {
  const els = $.ui.resolve(e)
  const { Box, Button, Text } = els
  const logged = (p: Promise<unknown>) => void p.catch((err) => $.ui.log(`doorbell: ${String(err)}`))
  const btn = (key: string, label: string, change: (s: Settings) => Settings) => (
    <Button key={key} onPress={() => logged(on.press(change))}>
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
      {'Select' in els &&
        'Input' in els &&
        TRIGGERS.map((t) => (
          <Box key={`action:${t}`} flexDirection="column">
            <Box gap={1}>
              <Text>{TRIGGER_LABEL[t]}</Text>
              <els.Select key={`mode:${t}`} options={MODE_OPTIONS} value={view.actions[t].mode} onSelect={(v: string) => logged(on.mode(t, v as ActionMode))} />
            </Box>
            <els.Input
              key={`prompt:${t}`}
              value={view.actions[t].prompt}
              rows={2}
              submitLabel="save"
              onInput={(v: string) => logged(on.draft(t, v))}
              onSubmit={(v: string) => logged(on.prompt(t, v))}
            />
            {view.actions[t].problem && <Text color="yellow">{view.actions[t].problem}</Text>}
          </Box>
        ))}
      {'Select' in els && 'Input' in els && (
        <Text dimColor>{`placeholders: ${PLACEHOLDERS.map((n) => `{${n}}`).join(' ')} · max 3 automatic runs per hour`}</Text>
      )}
      {'Input' in els && (
        <els.Input
          key="filter"
          label="filter:"
          value={p.filter}
          onInput={(v: string) => logged(on.filter(v))}
          onSubmit={(v: string) => logged(on.filter(v))}
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
