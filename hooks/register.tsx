import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Alias, Built, Config, Note, PaneState, Settings, State } from '../types'
import { afterFailure } from './backoff'
import { segments } from './band'
import { findGh, runGh, type GhOutcome } from './gh'
import { ensureDir, release, tryLead } from './lease'
import { send } from './notify'
import { drawPane, paneView } from './pane'
import { buildQuery } from './query'
import { reduce } from './reduce'
import { listRepos } from './repos'
import { shouldPoll } from './schedule'
import { DEFAULT_SETTINGS, readSettings, settingsMtime, writeSettings } from './settings'
import { cacheDir, EMPTY, readState, stateMtime, writeState } from './store'
import { giveUpCompares } from './triggers/shipped'

// The shape tag versions the stored value: bump it whenever State gains a field,
// or a reload reads the previous version's value and its missing fields land
// undefined in the triggers.
const state = atom({ plugin: 'doorbell', key: 'state' } as const, EMPTY, { shape: 'v4' })
const settings = atom({ plugin: 'doorbell', key: 'settings' } as const, DEFAULT_SETTINGS, { shape: 'v1' })
const CLOSED: PaneState = { repos: null, error: null, filter: '', save: null, isInvalid: false }
const pane = atom({ plugin: 'doorbell', key: 'pane' } as const, CLOSED, { shape: 'v1' })
const PANE = 'doorbell-settings'

let sessionId = ''
let dir = ''
let gh: string | null = null
let ghMissing = false
let inFlight = false
let leading = false
let lastBeatAt = 0
let lastMtime: number | null = null
// undefined forces a read, since null already means no file.
let lastSettingsMtime: number | null | undefined
let saving: Promise<unknown> = Promise.resolve()
// A reload while a press is unwritten would read the file from before it and overwrite the press in the atom.
let pendingWrites = 0
let opens = 0
let cfg: Config = { pollSeconds: 60, fadeMinutes: 5, includeBots: false, notify: true }

async function set($: EngineInterface, s: State) {
  await update($, state, () => s)
}

// A pathless error cannot say which compare broke the query, so they get one retry before all are given up.
const dropCompares = (s: State, paths: string[], aliases: Record<string, Alias>): Partial<State> => {
  const compares = Object.entries(aliases).filter(([, a]) => a.kind === 'compare')
  if (paths.length) return giveUpCompares(s, Object.fromEntries(compares.filter(([id]) => paths.includes(id))))
  if (!compares.length) return {}
  if (!s.pathlessQueryFailures) return { pathlessQueryFailures: 1 }
  return { ...giveUpCompares(s, aliases), pathlessQueryFailures: 0 }
}

const failed = (s: State, o: Exclude<GhOutcome, { kind: 'ok' }>, now: number, extra: Partial<State> = {}) => ({
  state: { ...s, lastAttemptAt: now, ...afterFailure(s, o, now), ...extra },
  notes: [] as Note[],
})

const outcome = (s: State, o: GhOutcome, built: Built, now: number, prefs: Settings): { state: State; notes: Note[] } => {
  if (o.kind !== 'ok') return failed(s, o, now, o.kind === 'query' ? dropCompares(s, o.paths, built.aliases) : {})
  try {
    return reduce(s, o.data, o.failedPaths, built.aliases, now, cfg, prefs)
  } catch (err) {
    // Data the triggers cannot read backs off like a query error, but blames no compare.
    return failed(s, { kind: 'query', message: String(err), paths: [] }, now)
  }
}

async function poll($: EngineInterface, s: State, now: number) {
  inFlight = true
  try {
    const built = buildQuery(s, now)
    const { state: next, notes } = outcome(s, await runGh($, gh!, built), built, now, await read($, settings))
    try {
      await writeState($, dir, sessionId, next)
    } catch (err) {
      // The old state stays so the next poll redoes the unsent notes; the attempt is kept so it waits its turn.
      $.ui.log(`doorbell: ${String(err)}`)
      await set($, { ...s, lastAttemptAt: next.lastAttemptAt, backoffUntil: next.backoffUntil })
      return
    }
    await set($, next)
    if (cfg.notify) await send($, notes)
  } finally {
    inFlight = false
  }
}

async function reloadSettings($: EngineInterface) {
  if (pendingWrites) return
  const mtime = await settingsMtime($, dir)
  if (mtime === lastSettingsMtime) return
  const r = await readSettings($, dir)
  // A press may land during the read; leaving the mtime unrecorded retries next tick.
  if (pendingWrites) return
  lastSettingsMtime = mtime
  await update($, settings, () => r.settings)
  await update($, pane, (p) => ({ ...p, isInvalid: r.isInvalid }))
}

// Presses share one tmp file per session, so writes queue; each writes the atom as it stands at its turn.
async function press($: EngineInterface, change: (s: Settings) => Settings) {
  pendingWrites++
  await update($, settings, change)
  const turn = saving.then(() => saveTurn($))
  saving = turn.catch(() => {})
  await turn
}

// The atom keeps a failed write's value until the next tick, which re-reads the file because the mtime is forgotten.
async function saveTurn($: EngineInterface) {
  let save: PaneState['save'] = 'saved'
  try {
    await writeSettings($, dir, sessionId, await read($, settings))
  } catch (err) {
    $.ui.log(`doorbell: ${String(err)}`)
    save = 'failed'
    lastSettingsMtime = undefined
  } finally {
    pendingWrites--
  }
  await update($, pane, (p) => ({ ...p, save, isInvalid: save === 'failed' && p.isInvalid }))
}

// A slow list from an earlier open must not overwrite the one a reopen started.
async function loadRepos($: EngineInterface) {
  const open = ++opens
  const { repos, error } = await listRepos($, gh!)
  if (open !== opens) return
  await update($, pane, (p) => ({ ...p, repos, error }))
}

// A session that cannot run gh stays a follower, so it never takes the lease from one that can.
async function heartbeat($: EngineInterface) {
  if (ghMissing) return
  await reloadSettings($)
  const now = await $.clock.now()
  const won = await tryLead($, dir, sessionId, now)
  if (won) {
    // The old leader may have written since this session last refreshed; polling from older seen keys would re-notify.
    if (!leading) {
      const file = await readState($, dir)
      if (file) await set($, file)
    }
    const s = await read($, state)
    if (!inFlight && shouldPoll(s, lastBeatAt, now, cfg)) await poll($, s, now)
  }
  leading = won
  lastBeatAt = now
}

async function followerRefresh($: EngineInterface) {
  await reloadSettings($)
  const mtime = await stateMtime($, dir)
  if (mtime !== lastMtime) {
    lastMtime = mtime
    const s = await readState($, dir)
    if (s) await set($, s)
  }
  // Redraw even without a new file, so the stale minutes keep counting.
  $.ui.invalidate('ui.render')
}

export const register: Register = (on, options) => {
  cfg = {
    pollSeconds: Number(options.pollSeconds ?? 60),
    fadeMinutes: Number(options.fadeMinutes ?? 5),
    includeBots: options.includeBots === true,
    notify: options.notify !== false,
  }

  on('session.start', async ($, e, next) => {
    if (!e.isInteractive) return next(e)
    inFlight = false
    leading = false
    lastBeatAt = 0
    lastMtime = null
    lastSettingsMtime = undefined
    sessionId = await $.session.id()
    dir = cacheDir((await $.env.get('HOME')) ?? (await $.session.cwd()))
    await ensureDir($, dir)
    const s = await readState($, dir)
    if (s) await set($, s)
    // gh is known before /doorbell can run, so the pane never reads it unset.
    gh = await findGh($)
    ghMissing = gh === null
    await $.command.register({ name: 'doorbell', description: 'Choose which repos and alerts Doorbell watches' })
    await reloadSettings($)
    $.clock.every(20_000, () => void heartbeat($).catch((err) => $.ui.log(`doorbell: ${String(err)}`)))
    $.clock.every(10_000, () => void followerRefresh($).catch((err) => $.ui.log(`doorbell: ${String(err)}`)))
    return next(e)
  })

  // A /clear keeps the process and its timers, so the lease stays with them.
  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear' && dir) await release($, dir, sessionId, await $.clock.now())
    return next(e)
  })

  on('command.run', { command: 'doorbell' }, async ($) => {
    await update($, pane, (p) => ({ ...p, repos: null, error: ghMissing ? 'gh not found' : null, filter: '', save: null }))
    await $.ui.open({ id: PANE, title: 'Doorbell settings', focus: true, closeOnEscape: true })
    if (!ghMissing) void loadRepos($).catch((err) => $.ui.log(`doorbell: ${String(err)}`))
    return { text: 'Doorbell settings opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const p = await read($, pane)
    const view = paneView(await read($, settings), p.repos, p.error, (await read($, state)).items, p.filter)
    return drawPane($, e, view, p, {
      press: (change) => press($, change),
      filter: (text) => update($, pane, (q) => ({ ...q, filter: text })),
    })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const segs = segments(await read($, state), await $.clock.now(), ghMissing, await read($, settings))
    if (!segs.length) return next(e)
    const { Box, Link, Text } = $.ui.resolve(e)
    return (
      <Box flexWrap="wrap" gap={2}>
        {segs.map((seg, i) => {
          const text = (
            <Text key={String(i)} dimColor={seg.dim} {...(seg.warn ? { color: 'yellow' } : {})}>
              {seg.text}
            </Text>
          )
          return seg.href ? <Link key={String(i)} href={seg.href}>{text}</Link> : text
        })}
      </Box>
    )
  })
}
