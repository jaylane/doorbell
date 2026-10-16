export type Kind = 'review' | 'comment' | 'approved' | 'shipped'
export type Item = {
  key: string
  kind: Kind
  prId: string
  /** Name without owner, for display. */
  repo: string
  number: number
  title: string
  url: string
  /** First seen, epoch ms. */
  at: number
  who: string[]
  count: number
  /** Team, draft or bot-authored review request. */
  dim: boolean
  /** Shipped only. */
  tag: string | null
}
export type Pending = {
  /** owner/name */
  repo: string
  number: number
  title: string
  url: string
  mergeOid: string
  /** Last release tag this PR was compared against. */
  compared?: string
}
export type ErrorKind = 'auth' | 'offline' | 'rate' | 'query' | 'partial'
export type State = {
  lastOkAt: number
  lastAttemptAt: number
  backoffUntil: number
  failures: number
  error: ErrorKind | null
  bootstrapped: boolean
  items: Item[]
  /** Event key -> last poll that observed it. */
  seen: Record<string, number>
  /** owner/name -> tag compared this or an earlier poll; marks the repo as known. */
  releases: Record<string, string>
  /** owner/name -> newest release tag seen. */
  latest: Record<string, string>
  /** prId -> waiting PR. */
  pendingShip: Record<string, Pending>
  /** Consecutive whole-query failures whose errors named no alias, while compares were present. */
  pathlessQueryFailures: number
}
export type Config = { pollSeconds: number; fadeMinutes: number; includeBots: boolean; notify: boolean }
export type Note = { title: string; body: string }
export type Alias =
  | { kind: 'release'; repo: string }
  | { kind: 'compare'; repo: string; tag: string; prId: string }
export type Built = { query: string; variables: Record<string, string>; aliases: Record<string, Alias> }

export type Author = { login: string; __typename: string } | null
export type Opinion = { id: string; state: string; author: Author }
export type Review = Opinion & { bodyText: string; viewerDidAuthor: boolean; createdAt: string }
export type Comment = { id: string; viewerDidAuthor: boolean; createdAt: string; author: Author }
export type MinePr = {
  id: string
  number: number
  title: string
  url: string
  isDraft: boolean
  reviewDecision: string | null
  repository: { nameWithOwner: string }
  commits: { nodes: { commit: { committedDate: string; author: { user: { login: string } | null } | null } }[] }
  latestOpinionatedReviews: { nodes: Opinion[] }
  reviews: { nodes: Review[] }
  reviewThreads: { nodes: { comments: { nodes: Comment[] } }[] }
  comments: { nodes: Comment[] }
}
export type RrPr = {
  id: string
  number: number
  title: string
  url: string
  isDraft: boolean
  author: Author
  repository: { nameWithOwner: string }
  reviewRequests: {
    nodes: { requestedReviewer: { __typename: string; login?: string; slug?: string } | null }[]
  }
}
export type MergedPr = {
  id: string
  number: number
  title: string
  url: string
  mergeCommit: { oid: string } | null
  repository: { nameWithOwner: string }
}
export type Search<T> = { issueCount: number; nodes: T[] }
export type Data = {
  viewer: { login: string }
  mine: Search<MinePr>
  rr: Search<RrPr>
  merged: Search<MergedPr>
  [alias: string]: unknown
}

declare module 'claude-code' {
  interface PluginState {
    doorbell: { state: Shaped<State> }
  }
}
