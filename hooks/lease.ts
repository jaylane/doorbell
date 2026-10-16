import type { Io } from './io'

const TTL_MS = 90_000
const STALE_LOCK_MS = 5_000

type Lease = { sessionId: string; expiresAt: number }

async function run(io: Io, argv: string[]) {
  try {
    return (await io.process.run(argv)).exitCode === 0
  } catch {
    return false
  }
}

export async function ensureDir(io: Io, dir: string): Promise<void> {
  await run(io, ['mkdir', '-p', '-m', '700', dir])
}

async function readLease(io: Io, dir: string): Promise<Lease | null> {
  try {
    return JSON.parse(await io.fs.read(`${dir}/lease.json`)) as Lease
  } catch {
    return null
  }
}

// A crashed holder leaves the lock behind, so one older than 5 s is removed and retried once.
async function withLock<T>(io: Io, dir: string, now: number, fn: () => Promise<T>): Promise<T | null> {
  const lock = `${dir}/lease.lock`
  if (!(await run(io, ['mkdir', lock]))) {
    const age = await io.fs.stat(lock).then((s) => s.mtimeMs, () => now)
    if (age >= now - STALE_LOCK_MS) return null
    await run(io, ['rmdir', lock])
    if (!(await run(io, ['mkdir', lock]))) return null
  }
  try {
    return await fn()
  } finally {
    await run(io, ['rmdir', lock])
  }
}

export async function tryLead(io: Io, dir: string, sessionId: string, now: number): Promise<boolean> {
  const led = await withLock(io, dir, now, async () => {
    const lease = await readLease(io, dir)
    if (lease && lease.sessionId !== sessionId && lease.expiresAt > now) return false
    await io.fs.write(`${dir}/lease.json`, JSON.stringify({ sessionId, expiresAt: now + TTL_MS }))
    return true
  })
  return led ?? false
}

export async function release(io: Io, dir: string, sessionId: string, now: number): Promise<void> {
  await withLock(io, dir, now, async () => {
    if ((await readLease(io, dir))?.sessionId !== sessionId) return
    await io.fs.write(`${dir}/lease.json`, JSON.stringify({ sessionId, expiresAt: 0 }))
  })
}
