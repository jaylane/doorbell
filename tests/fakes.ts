import type { Io } from '../hooks/io'

type Run = (argv: string[]) => { exitCode: number; stdout?: string; stderr?: string } | 'throw'

export const fakeIo = (
  opts: { files?: Record<string, string>; run?: Run; notify?: Io['ui']['notify'] } = {},
) => {
  const now = { ms: 1_000 }
  const files = new Map<string, { text: string; mtimeMs: number }>()
  for (const [p, text] of Object.entries(opts.files ?? {})) files.set(p, { text, mtimeMs: now.ms })
  const argv: string[][] = []
  const need = (path: string) => {
    const f = files.get(path)
    if (!f) throw new Error(`ENOENT: ${path}`)
    return f
  }
  const dir = (p: string) => (p.endsWith('/') ? p : `${p}/`)

  const io: Io = {
    fs: {
      read: async (p) => need(p).text,
      write: async (p, text) => void files.set(p, { text, mtimeMs: now.ms }),
      exists: async (p) => files.has(p),
      stat: async (p) => ({ mtimeMs: need(p).mtimeMs }),
    },
    process: {
      run: async (args) => {
        argv.push([...args])
        const [cmd, a = '', b = ''] = args
        const ok = { exitCode: 0, stdout: '', stderr: '' }
        if (cmd === 'mkdir') {
          if (files.has(dir(a))) return { ...ok, exitCode: 1, stderr: 'File exists' }
          files.set(dir(a), { text: '', mtimeMs: now.ms })
          return ok
        }
        if (cmd === 'rmdir') {
          files.delete(dir(a))
          return ok
        }
        if (cmd === 'mv') {
          const f = need(a)
          files.delete(a)
          files.set(b, f)
          return ok
        }
        const r = opts.run?.([...args]) ?? { exitCode: 0 }
        if (r === 'throw') throw new Error('spawn failed')
        return { exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
      },
    },
    ui: {
      notify: opts.notify ?? (async () => ({ isSent: true as const, channel: 'test' })),
    },
  }
  return { io, files, argv, now }
}
