# Doorbell: GitHub PR alerts in Claude Code

## Intent

Engineers spend most of the day in a Claude Code session. Doorbell tells them,
without a trip to the browser, when something on GitHub needs them:

1. a human commented on one of their open PRs
2. one of their PRs was approved
3. one of their merged PRs shipped in a GitHub Release
4. someone requested their review

Success: nobody leaves a review request sitting for hours, and nobody checks
github.com just to see whether anything happened.

Decisions marked **(default)** were made while writing this spec and were not
discussed; they are the cheapest to change.

## Constraints

- Auth is the person's existing `gh` login. No token, no server, no config needed
  to start.
- Polling, not webhooks. One `gh api graphql` request per poll.
- One poller per machine however many sessions are open. Only that session sends
  notifications.
- Only interactive sessions take part; `$.ui.notify` cannot reach a person from a
  headless one.
- Mod runtime: no Node. Everything goes through `$` (`$.process.run`, `$.fs`,
  `$.clock`, `$.ui`). `$.fs` has no rename, delete, lock or watch.

## Surfaces

- **Band above the prompt.** Persistent, never interrupts. Hidden when there is
  nothing to show and no error.
- **Notification** through `$.ui.notify('<title>: <body>', { title: 'Doorbell' })`,
  using the title and body from the Notifications table. When that returns
  `channel: 'terminal_bell'`, or `isSent: false` with reason `no-channel` or
  `no-surface`, fall back to
  `osascript -e 'display notification "<body>" with title "<title>"'` so a macOS
  banner still appears. Reasons `disabled` and `refused` are the person's or a
  hook's decision and send nothing.

## Architecture

A 20 s heartbeat starts on `session.start` (interactive only). Each heartbeat
renews or tries to take the lease. The lease holder polls every `pollSeconds`
(60 by default) and also polls at once when the gap since the last heartbeat
exceeds 40 s, which means the machine slept.

| Unit | Responsibility |
|---|---|
| `query` | Build the GraphQL document and an alias map from the current state |
| `gh` | Find the `gh` binary, run the query, classify the outcome |
| `triggers/*` | One pure function per trigger: data in, items and events out |
| `reduce` | Combine trigger outputs into the next state and the notifications to send |
| `lease` / `store` | Cross-session lease and atomic state file |
| `notify` | Send notifications, with the osascript fallback |
| `band` | Draw the band |
| `register` | Wire hooks, timer, backoff |

### Shared files

`~/.cache/doorbell/`, created with mode 0700 because it holds private PR titles.

- `lease.json`: `{ sessionId, expiresAt }`. TTL 90 s, renewed every heartbeat.
- `lease.lock/`: a directory used as a mutex. Taken with `mkdir`, released with
  `rmdir`, both through `$.process.run`. A lock older than 5 s is stale and removed.
- `state.json`: the whole `State`. Written to `state.json.<sessionId>.tmp` and then
  moved over with `mv`, so a reader never sees half a file. A reader that fails to
  parse keeps its last good copy.

A session ending writes `expiresAt: 0` if it holds the lease, so another session
takes over on its next heartbeat. A `/clear` is not an ending: the process and its
timers carry on, and so does the lease. The lease token is the session id read once
at `session.start`. A crashed leader is replaced within 90 s.
Followers `stat` `state.json` every 10 s and re-read it when `mtimeMs` changes.

## Query

One request per poll, containing:

- `viewer { login }`
- `mine`: `is:pr is:open author:@me archived:false`, first 30
- `rr`: `is:pr is:open review-requested:@me archived:false`, first 100 (team and
  code-owner requests make this the largest search for people on broad teams)
- `merged`: `is:pr is:merged author:@me merged:>=<today − 14 days>`, first 50
- one `repository(owner,name) { releases(first:5, CREATED_AT desc) }` alias per repo
  that has PRs waiting to ship
- one `repository { ref(qualifiedName:"refs/tags/<tag>") { compare(headRef:"<oid>") { status } } }`
  alias per waiting PR in a repo whose latest release changed last poll

Measured with one release and two compare aliases: 11 points and about 3 s. 660
points an hour is about 13% of the 5,000 hourly budget.

## Triggers

Bots are authors whose `__typename` is `Bot` or whose login ends in `[bot]`. By
**(default)** they are hidden entirely; `includeBots` shows them on the band, and
they never notify.

| Trigger | Shows while | Notifies |
|---|---|---|
| Review requested | The PR is in `rr` | Direct request on a non-draft PR. Team requests and drafts show dimmed, band only **(default)** |
| New comments | A human comment on my open PR is newer than my watermark | Once per new comment, coalesced per PR |
| Approved | `fadeMinutes` (5) after first seen, unless the approval disappears from `latestOpinionatedReviews` | Human approvals; adds "ready to merge" when `reviewDecision` is `APPROVED` |
| Shipped | `fadeMinutes` after first seen | Yes |

### Review requested

- Key `rr:<prId>:<firstSeenAt>`. While the PR stays in `rr` the item keeps its key.
  If it leaves `rr` (you reviewed) and returns (re-requested), it gets a new key and
  notifies again.
- Direct means the `viewer.login` is a `User` in `reviewRequests`. Anything else
  (team, code owner) counts as a team request.
- A PR opened by a bot (Dependabot, Renovate) shows dimmed and does not notify.
- When a draft becomes ready for review, the request notifies then.

### New comments

- Sources: issue comments (last 10), thread comments (last 3 of the last 30
  threads), and reviews (last 10) that are `CHANGES_REQUESTED`, or `COMMENTED`
  with a body. An approval's body belongs to the approval, not to comments.
- The watermark per PR is the later of:
  - the newest comment, thread comment or review whose `viewerDidAuthor` is true
  - the head commit's `committedDate`, when its author is you (a push)

  Both come from GitHub, so a comment posted between a push and the next poll is
  still judged against the push, not against when the poller noticed it.
- A comment shows while its `createdAt` is later than the watermark and its author is
  neither you nor a bot. Seen keys are `c:<nodeId>`.
- The band shows one item per PR with the count and authors. The item clears when
  you reply anywhere on the PR, push, or the PR closes. Resolving a thread does not
  clear it **(default)**, because you asked for "until you reply or push".

### Approved

- Key `a:<reviewId>`, from `latestOpinionatedReviews` where `state` is `APPROVED`
  and the author is neither you nor a bot.
- Added only if the key has not been seen before, so an approval does not come back
  after it fades.
- Removed early when the review is no longer an `APPROVED` entry, which covers a
  dismissal by a new push.

### Shipped

- Merged PRs from the last 14 days enter `pendingShip` with `{repo, mergeOid}`,
  unless `s:<prId>` is already in `seen` (it shipped, possibly silently).
- Each poll reads the latest non-draft, non-prerelease release for every repo with
  waiting PRs. The next poll compares each waiting PR whose own last-compared tag
  differs from that latest tag, so a PR that joins after its repo's tag was compared
  (search index lag right after a merge) is still compared against it.
- Compare status `BEHIND` or `IDENTICAL` means the tag contains the PR. Key
  `s:<prId>`; the PR leaves `pendingShip`. `AHEAD` and `DIVERGED` mean it does not.
- A compare whose `ref` is null (the tag was deleted) counts as not contained and
  the tag as compared. A compare listed in `errors[]` is retried next poll.
- A whole-query failure (GitHub returns only `errors`) gives up only the compare
  aliases its error paths name. When the errors carry no path and compares were in
  the query, the compares are retried once; a second consecutive pathless failure
  records them as compared, so one bad compare cannot fail every poll after it.
- First time a repo is seen: compare as usual, but mark contained PRs shipped
  silently, so already-released PRs neither notify nor linger.
- Releases only. Repos with tags and no Releases are ignored **(default)**, because
  build-number tags are not releases.
- A PR still waiting after 14 days falls out of the search and is dropped silently.

## Notifications

- Only for keys absent from `seen`. Every key observed in a poll is recorded in
  `seen` with that poll's time. Keys not observed for 30 days are pruned, so a
  long-lived approval or comment never re-notifies.
- Bootstrap: on the very first successful poll nothing notifies; the band still
  shows everything.
- One notification per PR per poll. When a PR has events of several kinds, the
  first kind in the order review, approved, comments, shipped gives the title and
  body, and ` · +<n> more` is appended for the other events. More than 3 PRs in
  one poll become a single summary.

| Kind | Title | Body |
|---|---|---|
| Review | `Review requested` | `<author> wants your review on <repo>#<n>: <title>` |
| Comments | `Comments on <repo>#<n>` | `<authors>: <count> new` |
| Approved | `<repo>#<n> approved` | `by <author>` or `by <author> · ready to merge` |
| Shipped | `<repo>#<n> shipped` | `in <tag>` |
| Summary | `<count> PR updates` | the PR labels joined with `, ` |

`<repo>` is the repository name without its owner.

## Band

One wrapping row of segments, in this order:

- `👀 <repo>#<n>` per review request, dim for team or draft
- `💬 <repo>#<n> ×<count>` per PR with comments
- `✅ <repo>#<n>` per approval
- `🚀 <repo>#<n> <tag>` per shipped PR

Status segment, last, at most one:

- `⚠ gh not found`
- `⚠ run gh auth login`
- `⚠ offline` (only after 3 consecutive failures)
- `⚠ rate limited`
- `⚠ GitHub error` when GitHub answered with errors and no data
- `⚠ partial` when one part of the response failed
- `stale <m>m` when the last success is more than 3 minutes old

The band yields to a survey (`hasSurvey`).

## Errors and backoff

`gh api graphql -i` returns the status line and headers with the body.

| Condition | Detection | Action |
|---|---|---|
| Rate limit | HTTP 429, a 403 carrying `Retry-After`, `X-RateLimit-Remaining: 0` or rate-limit text, or "rate limit" in an error message when there is no `data` | Wait `Retry-After`, else until `X-RateLimit-Reset`, else 60 s doubling to 15 min |
| Budget exhausted | `X-RateLimit-Remaining: 0` | Wait until `X-RateLimit-Reset` |
| Offline | No status line, a 5xx, or `gh` still running at 30 s | 15 s, 30 s, 60 s, then every 5 min |
| Query error | HTTP 200 with `errors` and no `data` | 60 s doubling to 15 min, and drop that poll's compares |
| Not authenticated | HTTP 401, any other 403 (for example SSO), or gh exit code 4 | Retry every 5 min |
| gh missing | No candidate runs | The session neither polls nor takes the lease; its own band shows the warning |
| Partial | `errors[]` alongside `data` | Use the data. Items from failed aliases keep their previous state |
| Overflow | `issueCount > first` on a search | Treat that search as failed (keep previous) and show `⚠ partial` |

Backoff state lives in `state.json`, so a new leader inherits it. `gh` is found by
trying `gh`, `/opt/homebrew/bin/gh` and `/usr/local/bin/gh` with `--version`.

## Configuration (`userConfig`)

| Key | Default | Meaning |
|---|---|---|
| `pollSeconds` | 60 | Seconds between polls, minimum 30 |
| `fadeMinutes` | 5 | How long approvals and ships stay |
| `includeBots` | false | Show bot comments on the band |
| `notify` | true | Send notifications at all |

## Testing

- The trigger functions and `reduce` are pure and tested against fixed GraphQL
  response fixtures.
- `register` is tested with the `claude-code/testing` engine: `process.run` and `fs.*`
  are answered from memory, and `mock.clock` drives the timers. This follows Pilot
  Light's harness.
- A manual pass against the live account checks the three GitHub behaviours nobody
  has observed yet.

## Not in v1

Acting on PRs, a `/prs` command, feeding events to Claude, deploy tracking, tag-only
releases, Linux and Windows notification fallbacks.
