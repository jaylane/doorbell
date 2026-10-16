import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Alias, Built, Config, Note, PaneState, Run, Settings, State } from '../types'
import { afterFailure } from './backoff'
import { segments } from './band'
import { findGh, runGh, type GhOutcome } from './gh'
import { addHandled, handledMtime, readHandled } from './handled'
import { ensureDir, release, tryLead } from './lease'
import { send } from './notify'
import { drawPane, paneView } from './pane'
import { buildQuery } from './query'
import { reduce } from './reduce'
import { listRepos } from './repos'
import { checkAgents, runAction, runSession } from './run'
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
let handled: string[] = []
let lastHandledMtime: number | null | undefined
let marking: Promise<unknown> = Promise.resolve()
let acting: Promise<unknown> = Promise.resolve()
let actionFailed = false
const pressing = new Set<string>()
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
  runs: [] as Run[],
})

const outcome = (s: State, o: GhOutcome, built: Built, now: number, prefs: Settings): { state: State; notes: Note[]; runs: Run[] } => {
  if (o.kind !== 'ok') return failed(s, o, now, o.kind === 'query' ? dropCompares(s, o.paths, built.aliases) : {})
  try {
    return reduce(s, o.data, o.failedPaths, built.aliases, now, cfg, prefs, handled)
  } catch (err) {
    // Data the triggers cannot read backs off like a query error, but blames no compare.
    return failed(s, { kind: 'query', message: String(err), paths: [] }, now)
  }
}

async function poll($: EngineInterface, s: State, now: number) {
  inFlight = true
  try {
    const built = buildQuery(s, now)
    const { state: next, notes, runs } = outcome(s, await runGh($, gh!, built), built, now, await read($, settings))
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
    // A run waits for the session to go idle, which must not hold up the next poll.
    if (runs.length) acting = acting.then(() => perform($, runs))
  } finally {
    inFlight = false
  }
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))

async function perform($: EngineInterface, runs: Run[]) {
  for (const run of runs) {
    try {
      await runAction($, run, cfg.notify)
      actionFailed = false
    } catch (err) {
      $.ui.log(`doorbell: ${reason(err)}`)
      actionFailed = true
    }
  }
  $.ui.invalidate('ui.render')
}

async function reloadHandled($: EngineInterface) {
  const mtime = await handledMtime($, dir)
  if (mtime === lastHandledMtime) return
  lastHandledMtime = mtime
  handled = await readHandled($, dir)
}

// handled.json shares one tmp file per session, so its writes queue like settings writes.
async function runAsk($: EngineInterface, id: string) {
  const ask = (await read($, state)).asks.find((a) => a.id === id)
  if (!ask || pressing.has(id)) return
  pressing.add(id)
  try {
    try {
      await runSession($, ask.text)
    } catch (err) {
      actionFailed = true
      throw err
    }
    actionFailed = false
    const turn = marking.then(() => addHandled($, dir, sessionId, id))
    marking = turn.catch(() => {})
    await turn
    lastHandledMtime = undefined
    await reloadHandled($)
  } finally {
    pressing.delete(id)
    $.ui.invalidate('ui.render')
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
  await reloadHandled($)
  // A failed agent list must not stop this beat from renewing the lease.
  await checkAgents($, cfg.notify).catch((err) => $.ui.log(`doorbell: ${reason(err)}`))
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
  await reloadHandled($)
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
    lastHandledMtime = undefined
    actionFailed = false
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
    await reloadHandled($)
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
    const s = await read($, state)
    // An ask this session marked handled hides at once, before the leader drops it.
    const shown = { ...s, asks: s.asks.filter((a) => !handled.includes(a.id)) }
    const segs = segments(shown, await $.clock.now(), ghMissing, await read($, settings), actionFailed)
    if (!segs.length) return next(e)
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    return (
      <Box flexWrap="wrap" gap={2}>
        {segs.flatMap((seg, i) => {
          const text = (
            <Text key={String(i)} dimColor={seg.dim} {...(seg.warn ? { color: 'yellow' } : {})}>
              {seg.text}
            </Text>
          )
          const el = seg.href ? <Link key={String(i)} href={seg.href}>{text}</Link> : text
          const id = seg.ask
          if (!id) return [el]
          return [el, <Button key={`ask:${id}`} onPress={() => void runAsk($, id).catch((err) => $.ui.log(`doorbell: ${reason(err)}`))}>▶</Button>]
        })}
      </Box>
    )
  })
}
