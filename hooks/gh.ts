import type { Built, Data } from '../types'
import type { Io } from './io'

export type GhOutcome =
  | { kind: 'ok'; data: Data; failedPaths: string[] }
  | { kind: 'rate'; retryAfterMs: number | null; resetAt: number | null }
  | { kind: 'auth' }
  | { kind: 'offline' }
  | { kind: 'query'; message: string }

type GhError = { message?: string; type?: string; path?: unknown[] }

// Exit 1 is normal for a partial response, so classification reads the HTTP status and body instead.
export const parseGh = (r: { exitCode: number; stdout: string; stderr: string }): GhOutcome => {
  if (!r.stdout.trim()) {
    return r.exitCode === 4 || /gh auth login/.test(r.stderr) ? { kind: 'auth' } : { kind: 'offline' }
  }
  const split = r.stdout.search(/\r?\n\r?\n/)
  const head = split < 0 ? r.stdout : r.stdout.slice(0, split)
  const text = split < 0 ? '' : r.stdout.slice(split).trim()
  const status = Number(/^HTTP\/\S+ (\d{3})/.exec(head)?.[1] ?? 0)
  const header = (name: string) => new RegExp(`^${name}:[ \\t]*(.*?)\\r?$`, 'im').exec(head)?.[1]

  let body: { data?: Data; errors?: GhError[]; message?: string } = {}
  try {
    body = JSON.parse(text) ?? {}
  } catch {}
  const errors = body.errors ?? []

  if (status === 401) return { kind: 'auth' }
  if (
    status === 403 ||
    status === 429 ||
    (header('x-ratelimit-remaining') === '0' && !body.data) ||
    (!body.data && [body.message, ...errors.map((e) => e.message)].some((m) => /rate limit/i.test(m ?? ''))) ||
    errors.some((e) => e.type === 'RATE_LIMITED')
  ) {
    // Retry-After may be an HTTP-date; a NaN here would stall polling forever.
    const seconds = (v?: string) => (v && Number.isFinite(Number(v)) ? Number(v) * 1000 : null)
    const retry = header('retry-after')
    const reset = header('x-ratelimit-reset')
    return {
      kind: 'rate',
      retryAfterMs: seconds(retry),
      resetAt: seconds(reset),
    }
  }
  if (status >= 500) return { kind: 'offline' }
  if (body.data) {
    const failedPaths = [...new Set(errors.map((e) => e.path?.[0]).filter((p): p is string => typeof p === 'string'))]
    return { kind: 'ok', data: body.data, failedPaths }
  }
  if (errors.length) return { kind: 'query', message: errors[0]?.message ?? 'GraphQL error' }
  return { kind: 'offline' }
}

// Claude Code's PATH can miss Homebrew, so the usual install locations are probed explicitly.
export const findGh = async (io: Io): Promise<string | null> => {
  for (const gh of ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh']) {
    try {
      if ((await io.process.run([gh, '--version'], { timeoutMs: 5000 })).exitCode === 0) return gh
    } catch {}
  }
  return null
}

export const runGh = async (io: Io, gh: string, built: Built): Promise<GhOutcome> => {
  const fields = Object.entries({ query: built.query, ...built.variables }).flatMap(([k, v]) => ['-f', `${k}=${v}`])
  try {
    return parseGh(await io.process.run([gh, 'api', 'graphql', '-i', ...fields], { timeoutMs: 30_000 }))
  } catch {
    return { kind: 'offline' }
  }
}
