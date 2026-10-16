import type { Item, Kind, Settings, State } from '../types'
import { allows } from './settings'

export type Segment = { text: string; dim: boolean; warn: boolean; href?: string; ask?: string }

export const ICON: Record<Kind, string> = { review: '👀', comment: '💬', approved: '✅', shipped: '🚀' }
const STALE_MS = 180_000

const STATUS = {
  auth: '⚠ run gh auth login',
  offline: '⚠ offline',
  rate: '⚠ rate limited',
  query: '⚠ GitHub error',
  partial: '⚠ partial',
} as const

// A ship is about the release, so it links there; the PR URL already names owner and repo.
const hrefOf = (i: Item): string =>
  i.kind === 'shipped' && i.tag ? i.url.replace(/\/pull\/\d+$/, `/releases/tag/${i.tag.split('/').map(encodeURIComponent).join('/')}`) : i.url

const warn = (text: string): Segment => ({ text, dim: false, warn: true })

const status = (s: State, now: number, ghMissing: boolean, actionFailed: boolean): Segment | null => {
  if (ghMissing) return warn('⚠ gh not found')
  if (s.error && s.error !== 'partial') return warn(STATUS[s.error])
  if (actionFailed) return warn('⚠ action failed')
  if (s.error) return warn(STATUS.partial)
  if (s.actionPaused) return warn('⚠ action paused')
  if (s.lastOkAt > 0 && now - s.lastOkAt > STALE_MS) {
    return { text: `stale ${Math.floor((now - s.lastOkAt) / 60_000)}m`, dim: true, warn: false }
  }
  return null
}

export const segments = (s: State, now: number, ghMissing: boolean, settings: Settings, actionFailed = false): Segment[] => {
  const items = s.items.filter((i) => allows(settings, i.fullRepo, i.kind)).map((i): Segment => {
    const label = `${ICON[i.kind]} ${i.repo}#${i.number}`
    const extra = i.kind === 'comment' ? ` ×${i.count}` : i.kind === 'shipped' ? ` ${i.tag}` : ''
    const ask = s.asks.find((a) => a.prId === i.prId && a.trigger === i.kind)
    return { text: label + extra, dim: i.dim, warn: false, href: hrefOf(i), ...(ask ? { ask: ask.id } : {}) }
  })
  const st = status(s, now, ghMissing, actionFailed)
  return st ? [...items, st] : items
}
