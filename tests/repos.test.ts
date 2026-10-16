import { expect, test } from 'claude-code/testing'
import { fakeIo } from './fakes'
import { listRepos } from '../hooks/repos'

const page = (names: string[], next: string | null, archived: string[] = []) =>
  JSON.stringify({
    data: {
      viewer: {
        repositories: {
          nodes: names.map((nameWithOwner) => ({ nameWithOwner, isArchived: archived.includes(nameWithOwner) })),
          pageInfo: { hasNextPage: next !== null, endCursor: next },
        },
      },
    },
  })

test('one page, archived skipped', async () => {
  const { io, argv } = fakeIo({ run: () => ({ exitCode: 0, stdout: page(['a/x', 'a/old', 'a/y'], null, ['a/old']) }) })
  expect(await listRepos(io, 'gh')).toEqual({ repos: ['a/x', 'a/y'], error: null })
  expect(argv).toHaveLength(1)
  expect(argv[0]!.slice(0, 3)).toEqual(['gh', 'api', 'graphql'])
  expect(argv[0]).not.toContain('-F')
})

test('follows endCursor across pages and stops at 5', async () => {
  let n = 0
  const { io, argv } = fakeIo({ run: () => ({ exitCode: 0, stdout: page([`a/r${++n}`], `c${n}`) }) })
  const r = await listRepos(io, 'gh')
  expect(r).toEqual({ repos: ['a/r1', 'a/r2', 'a/r3', 'a/r4', 'a/r5'], error: null })
  expect(argv).toHaveLength(5)
  expect(argv[1]!.slice(-2)).toEqual(['-F', 'cursor=c1'])
  expect(argv[4]!.slice(-2)).toEqual(['-F', 'cursor=c4'])
})

test('failure on page 2 returns page 1 repos with an error', async () => {
  let n = 0
  const { io } = fakeIo({
    run: () =>
      ++n === 1
        ? { exitCode: 0, stdout: page(['a/x'], 'c1') }
        : { exitCode: 1, stdout: JSON.stringify({ errors: [{ message: 'boom' }] }) },
  })
  expect(await listRepos(io, 'gh')).toEqual({ repos: ['a/x'], error: 'boom' })
})

test('offline gives error offline', async () => {
  expect(await listRepos(fakeIo({ run: () => ({ exitCode: 1 }) }).io, 'gh')).toEqual({ repos: [], error: 'offline' })
  expect(await listRepos(fakeIo({ run: () => 'throw' }).io, 'gh')).toEqual({ repos: [], error: 'offline' })
})

test('null nodes or pageInfo does not throw', async () => {
  const body = (repositories: unknown) => JSON.stringify({ data: { viewer: { repositories } } })
  expect(await listRepos(fakeIo({ run: () => ({ exitCode: 1, stdout: body({ nodes: null, pageInfo: null }) }) }).io, 'gh')).toEqual({ repos: [], error: null })
  expect(await listRepos(fakeIo({ run: () => ({ exitCode: 1, stdout: body({ nodes: [null, { nameWithOwner: 'a/x', isArchived: false }] }) }) }).io, 'gh')).toEqual({ repos: ['a/x'], error: null })
})

test('malformed JSON gives GitHub error', async () => {
  expect(await listRepos(fakeIo({ run: () => ({ exitCode: 0, stdout: '<html>' }) }).io, 'gh')).toEqual({ repos: [], error: 'GitHub error' })
  expect(await listRepos(fakeIo({ run: () => ({ exitCode: 0, stdout: '{"data":{"viewer":{"repositories":5}}}' }) }).io, 'gh')).toEqual({ repos: [], error: null })
})
