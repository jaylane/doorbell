import type { Io } from './io'

const QUERY = `query($cursor:String){ viewer{ repositories(first:100, after:$cursor,
  affiliations:[OWNER,COLLABORATOR,ORGANIZATION_MEMBER],
  orderBy:{field:PUSHED_AT,direction:DESC}){
  nodes{ nameWithOwner isArchived } pageInfo{ hasNextPage endCursor } } } }`

const MAX_PAGES = 5

type Repos = {
  nodes: { nameWithOwner: string; isArchived: boolean }[]
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
}

// Partial GraphQL errors can null any field; the settings pane waits on this promise, so it must never reject.
export async function listRepos(io: Io, gh: string): Promise<{ repos: string[]; error: string | null }> {
  const repos: string[] = []
  try {
    return await fetchPages(io, gh, repos)
  } catch {
    return { repos, error: 'GitHub error' }
  }
}

async function fetchPages(io: Io, gh: string, repos: string[]): Promise<{ repos: string[]; error: string | null }> {
  let cursor: string | null = null
  for (let i = 0; i < MAX_PAGES; i++) {
    const argv = [gh, 'api', 'graphql', '-f', `query=${QUERY}`, ...(cursor ? ['-F', `cursor=${cursor}`] : [])]
    let stdout: string
    try {
      stdout = (await io.process.run(argv, { timeoutMs: 30_000 })).stdout
    } catch {
      return { repos, error: 'offline' }
    }
    if (!stdout.trim()) return { repos, error: 'offline' }
    let body: { data?: { viewer?: { repositories?: Repos } }; errors?: { message?: string }[] } = {}
    try {
      body = JSON.parse(stdout) ?? {}
    } catch {}
    const page = body.data?.viewer?.repositories
    if (!page) return { repos, error: body.errors?.[0]?.message ?? 'GitHub error' }
    for (const n of page.nodes ?? []) if (n && !n.isArchived) repos.push(n.nameWithOwner)
    if (!page.pageInfo?.hasNextPage || !page.pageInfo.endCursor) break
    cursor = page.pageInfo.endCursor
  }
  return { repos, error: null }
}
