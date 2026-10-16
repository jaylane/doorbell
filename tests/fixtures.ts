import type { Data, MergedPr, MinePr, Pending, RrPr, State } from '../types'
import { EMPTY } from '../hooks/store'

export const minePr = (over: Partial<MinePr> = {}): MinePr => ({
  id: 'PR1',
  number: 1,
  title: 'Add thing',
  url: 'https://github.com/acme/app/pull/1',
  isDraft: false,
  reviewDecision: null,
  repository: { nameWithOwner: 'acme/app' },
  commits: { nodes: [] },
  latestOpinionatedReviews: { nodes: [] },
  reviews: { nodes: [] },
  reviewThreads: { nodes: [] },
  comments: { nodes: [] },
  ...over,
})

export const rrPr = (over: Partial<RrPr> = {}): RrPr => ({
  id: 'PR1',
  number: 1,
  title: 'Add thing',
  url: 'https://github.com/acme/app/pull/1',
  isDraft: false,
  author: { login: 'alice', __typename: 'User' },
  repository: { nameWithOwner: 'acme/app' },
  reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'me' } }] },
  ...over,
})

export const mergedPr = (over: Partial<MergedPr> = {}): MergedPr => ({
  id: 'PR1',
  number: 1,
  title: 'Add thing',
  url: 'https://github.com/acme/app/pull/1',
  mergeCommit: { oid: 'abc123' },
  repository: { nameWithOwner: 'acme/app' },
  ...over,
})

export const data = (over: Partial<Data> = {}): Data => ({
  viewer: { login: 'me' },
  mine: { issueCount: 0, nodes: [] },
  rr: { issueCount: 0, nodes: [] },
  merged: { issueCount: 0, nodes: [] },
  ...over,
})

export const state = (over: Partial<State> = {}): State => ({ ...EMPTY, ...over })

export const pending = (repo: string, over: Partial<Pending> = {}): Pending => ({
  repo,
  number: 1,
  title: 'Add thing',
  url: `https://github.com/${repo}/pull/1`,
  mergeOid: 'abc123',
  ...over,
})

export const releaseNode = (tags: { tagName: string; isDraft?: boolean; isPrerelease?: boolean }[]) => ({
  releases: {
    nodes: tags.map((t) => ({ isDraft: false, isPrerelease: false, ...t })),
  },
})

export const compareNode = (status: 'BEHIND' | 'IDENTICAL' | 'AHEAD' | 'DIVERGED' | null) =>
  status ? { ref: { compare: { status } } } : { ref: null }

/** Raw `gh api -i` stdout: status line, CRLF headers, blank line, JSON body. */
export const ghOut = (status: number, headers: Record<string, string>, body: unknown) => {
  const head = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')
  return `HTTP/2.0 ${status} ${status === 200 ? 'OK' : 'Error'}\n${head}\r\n${JSON.stringify(body)}`
}
