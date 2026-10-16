import type { Alias, Built, State } from '../types'

const DAY = 86_400_000

const PR_FIELDS = {
  mine: `... on PullRequest{
   id number title url isDraft reviewDecision repository{nameWithOwner}
   commits(last:1){nodes{commit{committedDate author{user{login}}}}}
   latestOpinionatedReviews(first:10){nodes{id state author{login __typename}}}
   reviews(last:10){nodes{id state bodyText viewerDidAuthor createdAt author{login __typename}}}
   reviewThreads(last:30){nodes{comments(last:3){nodes{id viewerDidAuthor createdAt author{login __typename}}}}}
   comments(last:10){nodes{id viewerDidAuthor createdAt author{login __typename}}}
 }`,
  rr: `... on PullRequest{
   id number title url isDraft author{login __typename} repository{nameWithOwner}
   reviewRequests(first:20){nodes{requestedReviewer{__typename ... on User{login} ... on Team{slug} ... on Bot{login}}}}
 }`,
  merged: `... on PullRequest{
   id number title url mergeCommit{oid} repository{nameWithOwner}
 }`,
}

export const PAGE = { mine: 30, rr: 30, merged: 50 } as const

const search = (name: keyof typeof PR_FIELDS) =>
  ` ${name}: search(query:$${name},type:ISSUE,first:${PAGE[name as keyof typeof PAGE]}){ issueCount nodes{ ${PR_FIELDS[name]}}}`

const repoOf = (nameWithOwner: string) => {
  const [owner, name] = nameWithOwner.split('/')
  return `repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)})`
}

export const buildQuery = (state: State, now: number): Built => {
  const aliases: Record<string, Alias> = {}
  const extra: string[] = []
  const add = (a: Alias, id: string, selection: string) => {
    aliases[id] = a
    extra.push(` ${id}: ${repoOf(a.repo)}{${selection}}`)
  }

  const pending = Object.entries(state.pendingShip)
  const repos = [...new Set(pending.map(([, p]) => p.repo))]
  repos.forEach((repo, i) =>
    add(
      { kind: 'release', repo },
      `r${i}`,
      'releases(first:5,orderBy:{field:CREATED_AT,direction:DESC}){nodes{tagName isDraft isPrerelease}}',
    ),
  )
  let c = 0
  for (const [prId, p] of pending) {
    const tag = state.latest[p.repo]
    if (!tag || state.releases[p.repo] === tag) continue
    add(
      { kind: 'compare', repo: p.repo, tag, prId },
      `c${c++}`,
      `ref(qualifiedName:${JSON.stringify(`refs/tags/${tag}`)}){compare(headRef:${JSON.stringify(p.mergeOid)}){status}}`,
    )
  }

  const since = new Date(now - 14 * DAY).toISOString().slice(0, 10)
  const query = [
    'query($mine:String!,$rr:String!,$merged:String!){',
    ' rateLimit{cost remaining}',
    ' viewer{login}',
    search('mine'),
    search('rr'),
    search('merged'),
    ...extra,
    '}',
  ].join('\n')
  return {
    query,
    variables: {
      mine: 'is:pr is:open author:@me archived:false',
      rr: 'is:pr is:open review-requested:@me archived:false',
      merged: `is:pr is:merged author:@me merged:>=${since}`,
    },
    aliases,
  }
}
