import type { Built, Data } from '../types'
import type { Io } from './io'

export type GhOutcome =
  | { kind: 'ok'; data: Data; failedPaths: string[] }
  | { kind: 'rate'; retryAfterMs: number | null; resetAt: number | null }
  | { kind: 'auth' }
  | { kind: 'offline' }
  | { kind: 'query'; message: string; paths: string[] }

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
  const paths = [...new Set(errors.map((e) => e.path?.[0]).filter((p): p is string => typeof p === 'string'))]

  const exhausted = header('x-ratelimit-remaining') === '0'
  const rateText = [body.message, ...errors.map((e) => e.message)].some((m) => /rate limit/i.test(m ?? ''))
  if (status === 401) return { kind: 'auth' }
  if (
    status === 429 ||
    (status === 403 && (header('retry-after') !== undefined || exhausted || rateText)) ||
    (exhausted && !body.data) ||
    (!body.data && rateText) ||
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
  // Any other 403, such as an SSO or permission block, needs the user to act, like a 401.
  if (status === 403) return { kind: 'auth' }
  if (status >= 500) return { kind: 'offline' }
  if (body.data) return { kind: 'ok', data: body.data, failedPaths: paths }
  if (errors.length) return { kind: 'query', message: errors[0]?.message ?? 'GraphQL error', paths }
  return { kind: 'offline' }
}

// Claude Code's PATH can miss Homebrew, so the usual install locations are probed explicitly.
export async function findGh(io: Io): Promise<string | null> {
  for (const gh of ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh']) {
    try {
      if ((await io.process.run([gh, '--version'], { timeoutMs: 5000 })).exitCode === 0) return gh
    } catch {}
  }
  return null
}

export async function runGh(io: Io, gh: string, built: Built): Promise<GhOutcome> {
  const fields = Object.entries({ query: built.query, ...built.variables }).flatMap(([k, v]) => ['-f', `${k}=${v}`])
  try {
    return parseGh(await io.process.run([gh, 'api', 'graphql', '-i', ...fields], { timeoutMs: 30_000 }))
  } catch {
    return { kind: 'offline' }
  }
}
