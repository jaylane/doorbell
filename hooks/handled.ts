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
export async function addHandled(io: Io, dir: string, sessionId: string, id: string): Promise<void> {
  const ids = await readHandled(io, dir)
  if (ids.includes(id)) return
  const tmp = `${dir}/handled.json.${sessionId}.tmp`
  await io.fs.write(tmp, JSON.stringify({ ids: [...ids, id] }))
  const r = await io.process.run(['mv', tmp, `${dir}/handled.json`])
  if (r.exitCode !== 0) throw new Error(`mv failed: ${r.stderr}`)
}

export async function handledMtime(io: Io, dir: string): Promise<number | null> {
  try {
    return (await io.fs.stat(`${dir}/handled.json`)).mtimeMs
  } catch {
    return null
  }
}
