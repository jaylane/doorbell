import type { State } from '../types'
import type { Io } from './io'

export const EMPTY: State = {
  lastOkAt: 0,
  lastAttemptAt: 0,
  backoffUntil: 0,
  failures: 0,
  error: null,
  bootstrapped: false,
  items: [],
  seen: {},
  releases: {},
  latest: {},
  pendingShip: {},
  pathlessQueryFailures: 0,
  asks: [],
  actionRuns: { review: [], comment: [] },
  actionPaused: false,
}

export const cacheDir = (home: string) => `${home}/.cache/doorbell`

export async function readState(io: Io, dir: string): Promise<State | null> {
  try {
    // A file written before a field existed still reads with that field's empty value.
    const s = JSON.parse(await io.fs.read(`${dir}/state.json`)) as State | null
    return s && { ...EMPTY, ...s }
  } catch {
    return null
  }
}

// A per-session tmp name keeps two writers from clobbering each other's tmp file.
export async function writeState(io: Io, dir: string, sessionId: string, s: State): Promise<void> {
  const tmp = `${dir}/state.json.${sessionId}.tmp`
  await io.fs.write(tmp, JSON.stringify(s))
  const r = await io.process.run(['mv', tmp, `${dir}/state.json`])
  if (r.exitCode !== 0) throw new Error(`mv failed: ${r.stderr}`)
}

export async function stateMtime(io: Io, dir: string): Promise<number | null> {
  try {
    return (await io.fs.stat(`${dir}/state.json`)).mtimeMs
  } catch {
    return null
  }
}
