import { expect, test } from 'claude-code/testing'

import { buildQuery } from '../hooks/query'
import { pending, state } from './fixtures'

test('always asks for viewer, rateLimit and the three searches', async () => {
  const { query, variables } = buildQuery(state(), Date.UTC(2026, 9, 16))
  expect(query).toMatch(/viewer\s*{\s*login/)
  expect(query).toMatch(/rateLimit\s*{\s*cost/)
  expect(variables.mine).toBe('is:pr is:open author:@me archived:false')
  expect(variables.rr).toBe('is:pr is:open review-requested:@me archived:false')
  expect(variables.merged).toBe('is:pr is:merged author:@me merged:>=2026-10-02')
})
test('adds one release alias per repo with waiting PRs', async () => {
  const s = state({ pendingShip: { P1: pending('acme/app'), P2: pending('acme/app'), P3: pending('acme/lib') } })
  const { aliases } = buildQuery(s, 0)
  expect(Object.values(aliases).filter(a => a.kind === 'release').map(a => a.repo).sort()).toEqual(['acme/app', 'acme/lib'])
})
test('adds a compare per waiting PR only where the latest tag is not compared yet', async () => {
  const s = state({
    pendingShip: { P1: pending('acme/app'), P2: pending('acme/lib') },
    latest: { 'acme/app': 'v2', 'acme/lib': 'v9' }, releases: { 'acme/app': 'v1', 'acme/lib': 'v9' },
  })
  const compares = Object.values(buildQuery(s, 0).aliases).filter(a => a.kind === 'compare')
  expect(compares).toEqual([{ kind: 'compare', repo: 'acme/app', tag: 'v2', prId: 'P1' }])
})
test('quotes owner, name, tag and oid as GraphQL string literals', async () => {
  const s = state({ pendingShip: { P1: pending('acme/app', { mergeOid: 'abc' }) }, latest: { 'acme/app': 'v"1' } })
  expect(buildQuery(s, 0).query).toContain('qualifiedName:"refs/tags/v\\"1"')
})
