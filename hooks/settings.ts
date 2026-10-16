import type { Kind, RepoSetting, Settings } from '../types'
import type { Io } from './io'

export const KINDS: readonly Kind[] = ['review', 'comment', 'approved', 'shipped']

export const DEFAULT_SETTINGS: Settings = { allRepos: true, defaults: [...KINDS], repos: {} }

export type Group = 'on' | 'off' | 'mixed'

const ordered = (kinds: readonly Kind[]): Kind[] => KINDS.filter((k) => kinds.includes(k))

export function isTracked(s: Settings, repo: string): boolean {
  return s.repos[repo]?.tracked ?? s.allRepos
}

export function effective(s: Settings, repo: string): Kind[] {
  const own = s.repos[repo]
  if (own) return own.tracked ? ordered(own.kinds) : []
  return s.allRepos ? ordered(s.defaults) : []
}

export function allows(s: Settings, repo: string, kind: Kind): boolean {
  return effective(s, repo).includes(kind)
}

export function groupState(on: number, total: number): Group {
  return on === 0 ? 'off' : on === total ? 'on' : 'mixed'
}

// The kind lists a column press reaches: defaults, plus every tracked entry.
const columnSets = (s: Settings): Kind[][] => [
  ...(s.allRepos ? [s.defaults] : []),
  ...Object.values(s.repos).filter((r) => r.tracked).map((r) => r.kinds),
]

export function columnState(s: Settings, kind: Kind | 'all'): Group {
  const sets = columnSets(s)
  if (kind === 'all') {
    return groupState(sets.reduce((n, k) => n + ordered(k).length, 0), sets.length * KINDS.length)
  }
  return groupState(sets.filter((k) => k.includes(kind)).length, sets.length)
}

// A press on a repo without an entry freezes its current effective state first,
// so later changes to defaults stop reaching it.
const withRepo = (s: Settings, repo: string, change: (r: RepoSetting) => RepoSetting): Settings => {
  const own = s.repos[repo] ?? { tracked: isTracked(s, repo), kinds: effective(s, repo) }
  const next = change(own)
  return { ...s, repos: { ...s.repos, [repo]: { tracked: next.tracked, kinds: ordered(next.kinds) } } }
}

const flip = (kinds: readonly Kind[], kind: Kind): Kind[] =>
  kinds.includes(kind) ? kinds.filter((k) => k !== kind) : [...kinds, kind]

export function toggleTracked(s: Settings, repo: string): Settings {
  return withRepo(s, repo, (r) =>
    r.tracked ? { tracked: false, kinds: [] } : { tracked: true, kinds: s.defaults },
  )
}

export function toggleRepoAll(s: Settings, repo: string): Settings {
  return withRepo(s, repo, (r) => ({
    tracked: r.tracked,
    kinds: ordered(r.kinds).length === KINDS.length ? [] : [...KINDS],
  }))
}

export function toggleRepoKind(s: Settings, repo: string, kind: Kind): Settings {
  return withRepo(s, repo, (r) => ({ tracked: r.tracked, kinds: flip(r.kinds, kind) }))
}

export function toggleColumn(s: Settings, kind: Kind | 'all'): Settings {
  const turnOn = columnState(s, kind) !== 'on'
  const apply = (kinds: Kind[]): Kind[] => {
    if (kind === 'all') return turnOn ? [...KINDS] : []
    return ordered(turnOn ? [...kinds, kind] : kinds.filter((k) => k !== kind))
  }
  const repos: Settings['repos'] = {}
  for (const [name, r] of Object.entries(s.repos)) {
    repos[name] = r.tracked ? { tracked: true, kinds: apply(r.kinds) } : r
  }
  return { ...s, defaults: apply(s.defaults), repos }
}

export function toggleAllRepos(s: Settings): Settings {
  return { ...s, allRepos: !s.allRepos }
}

export function toggleDefault(s: Settings, kind: Kind): Settings {
  return { ...s, defaults: ordered(flip(s.defaults, kind)) }
}

const isKinds = (v: unknown): v is Kind[] =>
  Array.isArray(v) && v.every((k) => KINDS.includes(k as Kind))

export function parseSettings(text: string): Settings | null {
  let v: any
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  const isObj = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x)
  if (!isObj(v) || typeof v.allRepos !== 'boolean' || !isKinds(v.defaults) || !isObj(v.repos)) return null
  const repos: Settings['repos'] = {}
  for (const [name, r] of Object.entries(v.repos)) {
    if (!isObj(r) || typeof r.tracked !== 'boolean' || !isKinds(r.kinds)) return null
    repos[name] = { tracked: r.tracked, kinds: ordered(r.kinds) }
  }
  return { allRepos: v.allRepos, defaults: ordered(v.defaults), repos }
}

export async function readSettings(io: Io, dir: string): Promise<{ settings: Settings; isInvalid: boolean }> {
  let text: string
  try {
    text = await io.fs.read(`${dir}/settings.json`)
  } catch {
    return { settings: DEFAULT_SETTINGS, isInvalid: false }
  }
  const settings = parseSettings(text)
  return settings ? { settings, isInvalid: false } : { settings: DEFAULT_SETTINGS, isInvalid: true }
}

// Same per-session tmp name as writeState, for the same reason.
export async function writeSettings(io: Io, dir: string, sessionId: string, s: Settings): Promise<void> {
  const tmp = `${dir}/settings.json.${sessionId}.tmp`
  await io.fs.write(tmp, JSON.stringify(s))
  const r = await io.process.run(['mv', tmp, `${dir}/settings.json`])
  if (r.exitCode !== 0) throw new Error(`mv failed: ${r.stderr}`)
}

export async function settingsMtime(io: Io, dir: string): Promise<number | null> {
  try {
    return (await io.fs.stat(`${dir}/settings.json`)).mtimeMs
  } catch {
    return null
  }
}
