import type { Kind, State } from '../types'

export type Segment = { text: string; dim: boolean; warn: boolean }

const ICON: Record<Kind, string> = { review: '👀', comment: '💬', approved: '✅', shipped: '🚀' }
const STALE_MS = 180_000

const STATUS = {
  auth: '⚠ run gh auth login',
  offline: '⚠ offline',
  rate: '⚠ rate limited',
  query: '⚠ GitHub error',
  partial: '⚠ partial',
} as const

const status = (s: State, now: number, ghMissing: boolean): Segment | null => {
  if (ghMissing) return { text: '⚠ gh not found', dim: false, warn: true }
  if (s.error) return { text: STATUS[s.error], dim: false, warn: true }
  if (s.lastOkAt > 0 && now - s.lastOkAt > STALE_MS) {
    return { text: `stale ${Math.floor((now - s.lastOkAt) / 60_000)}m`, dim: true, warn: false }
  }
  return null
}

export const segments = (s: State, now: number, ghMissing: boolean): Segment[] => {
  const items = s.items.map((i): Segment => {
    const label = `${ICON[i.kind]} ${i.repo}#${i.number}`
    const extra = i.kind === 'comment' ? ` ×${i.count}` : i.kind === 'shipped' ? ` ${i.tag}` : ''
    return { text: label + extra, dim: i.dim, warn: false }
  })
  const st = status(s, now, ghMissing)
  return st ? [...items, st] : items
}
