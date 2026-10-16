import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Config, State } from '../types'
import { afterFailure } from './backoff'
import { segments } from './band'
import { findGh, runGh } from './gh'
import { ensureDir, release, tryLead } from './lease'
import { send } from './notify'
import { buildQuery } from './query'
import { reduce } from './reduce'
import { shouldPoll } from './schedule'
import { cacheDir, EMPTY, readState, stateMtime, writeState } from './store'
import { giveUpCompares } from './triggers/shipped'

// The shape tag versions the stored value: bump it whenever State gains a field,
// or a reload reads the previous version's value and its missing fields land
// undefined in the triggers.
const state = atom({ plugin: 'doorbell', key: 'state' } as const, EMPTY, { shape: 'v2' })

let sessionId = ''
let dir = ''
let gh: string | null = null
let ghMissing = false
let inFlight = false
let lastBeatAt = 0
let lastMtime: number | null = null
let cfg: Config = { pollSeconds: 60, fadeMinutes: 5, includeBots: false, notify: true }

async function set($: EngineInterface, s: State) {
  await update($, state, () => s)
}

async function poll($: EngineInterface, s: State, now: number) {
  inFlight = true
  try {
    const built = buildQuery(s, now)
    const o = await runGh($, gh!, built)
    const { state: next, notes } =
      o.kind === 'ok'
        ? reduce(s, o.data, o.failedPaths, built.aliases, now, cfg)
        : {
            state: {
              ...s,
              lastAttemptAt: now,
              ...afterFailure(s, o, now),
              ...(o.kind === 'query' ? giveUpCompares(s, built.aliases) : {}),
            },
            notes: [],
          }
    await writeState($, dir, sessionId, next)
    await set($, next)
    if (cfg.notify) await send($, notes)
  } finally {
    inFlight = false
  }
}

// A session that cannot run gh stays a follower, so it never takes the lease from one that can.
async function heartbeat($: EngineInterface) {
  if (ghMissing) return
  const now = await $.clock.now()
  if (await tryLead($, dir, sessionId, now)) {
    const s = await read($, state)
    if (!inFlight && shouldPoll(s, lastBeatAt, now, cfg)) await poll($, s, now)
  }
  lastBeatAt = now
}

async function followerRefresh($: EngineInterface) {
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
    lastBeatAt = 0
    lastMtime = null
    sessionId = await $.session.id()
    dir = cacheDir((await $.env.get('HOME')) ?? (await $.session.cwd()))
    await ensureDir($, dir)
    const s = await readState($, dir)
    if (s) await set($, s)
    gh = await findGh($)
    ghMissing = gh === null
    $.clock.every(20_000, () => void heartbeat($).catch((err) => $.ui.log(`doorbell: ${String(err)}`)))
    $.clock.every(10_000, () => void followerRefresh($).catch((err) => $.ui.log(`doorbell: ${String(err)}`)))
    return next(e)
  })

  // A /clear keeps the process and its timers, so the lease stays with them.
  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear' && dir) await release($, dir, sessionId, await $.clock.now())
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const segs = segments(await read($, state), await $.clock.now(), ghMissing)
    if (!segs.length) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexWrap="wrap" gap={2}>
        {segs.map((seg, i) => (
          <Text key={String(i)} dimColor={seg.dim} {...(seg.warn ? { color: 'yellow' } : {})}>
            {seg.text}
          </Text>
        ))}
      </Box>
    )
  })
}
