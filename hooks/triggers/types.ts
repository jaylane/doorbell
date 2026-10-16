import type { Config, Item, Kind, State } from '../../types'

export type Ctx = { now: number; me: string; cfg: Config; prev: State; failed: Set<string> }
export type Event = {
  key: string
  kind: Kind
  notify: boolean
  prId: string
  fullRepo: string
  /** repo#n */
  label: string
  title: string
  who: string
  detail: string
}
export type TriggerOut = { items: Item[]; events: Event[] }

export const labelOf = (nameWithOwner: string, n: number): string => `${nameWithOwner.split('/').pop()}#${n}`
