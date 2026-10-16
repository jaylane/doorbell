import type { Io } from './io'

export async function readHandled(io: Io, dir: string): Promise<string[]> {
  try {
    const v = JSON.parse(await io.fs.read(`${dir}/handled.json`))
    const ids = v?.ids
    return Array.isArray(ids) && ids.every((i) => typeof i === 'string') ? ids : []
  } catch {
    return []
  }
}

// Same per-session tmp name as writeSettings, for the same reason.
async function writeHandled(io: Io, dir: string, sessionId: string, ids: string[]): Promise<void> {
  const tmp = `${dir}/handled.json.${sessionId}.tmp`
  await io.fs.write(tmp, JSON.stringify({ ids }))
  const r = await io.process.run(['mv', tmp, `${dir}/handled.json`])
  if (r.exitCode !== 0) throw new Error(`mv failed: ${r.stderr}`)
}

export async function addHandled(io: Io, dir: string, sessionId: string, id: string): Promise<void> {
  const ids = await readHandled(io, dir)
  if (ids.includes(id)) return
  await writeHandled(io, dir, sessionId, [...ids, id])
}

export async function pruneHandled(io: Io, dir: string, sessionId: string, keep: (id: string) => boolean): Promise<void> {
  const ids = await readHandled(io, dir)
  const kept = ids.filter(keep)
  if (kept.length < ids.length) await writeHandled(io, dir, sessionId, kept)
}

export async function handledMtime(io: Io, dir: string): Promise<number | null> {
  try {
    return (await io.fs.stat(`${dir}/handled.json`)).mtimeMs
  } catch {
    return null
  }
}
