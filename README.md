<h1 align="center">Doorbell</h1>

A Claude Code mod that rings when a GitHub pull request needs you. It draws one wrapping row above the prompt and sends a notification when something new appears. The band is hidden when there is nothing to show and no error, and it yields to a survey.

```
👀 api#412   💬 web#88 ×3   ✅ api#405   🚀 api#398 v1.8.0
```

## Install

At the prompt of a terminal session:

```
/plugin install doorbell --marketplace jaylane/doorbell
```

Answer `y` to add the marketplace, then pick a scope. It uses your existing `gh auth login`; there is nothing else to configure.

## The band

Segments appear in this order. Each item is a link to its pull request, or for 🚀 to its release page; cmd+click opens it in most terminals (iTerm2, Ghostty, WezTerm, kitty, VS Code). Terminal.app has no hyperlink support and prints the URL after the item instead.

| Segment | Meaning |
|---|---|
| `👀 <repo>#<n>` | Review requested from you. Dim for team requests, drafts and bot-opened PRs. |
| `💬 <repo>#<n> ×<count>` | New comments on your PR. |
| `✅ <repo>#<n>` | Your PR was approved. Fades after `fadeMinutes`. |
| `🚀 <repo>#<n> <tag>` | Your merged PR is in a release. Fades after `fadeMinutes`. |

One status segment may follow, last.

| Status | Meaning |
|---|---|
| `⚠ gh not found` | No `gh` binary at `gh`, `/opt/homebrew/bin/gh` or `/usr/local/bin/gh`. |
| `⚠ run gh auth login` | `gh` is not authenticated. |
| `⚠ offline` | Three consecutive failed polls. |
| `⚠ rate limited` | GitHub rate limit; polling resumes when it resets. |
| `⚠ GitHub error` | GitHub answered with errors and no data. |
| `⚠ partial` | One part of the response failed, or a search overflowed its page. |
| `stale <m>m` | The last successful poll is more than 3 minutes old. |

## Settings pane

`/doorbell` opens a pane to choose which repos Doorbell watches and which of the four events (👀 💬 ✅ 🚀) each one shows. Escape closes it.

```
[x] All repos (live) new repos get: [x]👀 [x]💬 [x]✅ [x]🚀
filter: _
every tracked repo [-] all [x]👀 [-]💬 [x]✅ [x]🚀
[x] acme/api [-] all [x] [ ] [x] [x]
[ ] acme/legacy · · · · ·
```

**All repos (live)** means a repo you have never touched follows the "new repos get" row, so a repo created tomorrow shows up on the band without a visit here. Pressing any box on a repo freezes that repo at its current state, and later changes to the defaults stop reaching it. Unticking All repos makes untouched repos silent.

The boxes read `[x]` on, `[ ]` off and `[-]` for a mixed group. The "every tracked repo" row and each repo's `all` box set a whole column or row at once. The first box on a repo row tracks or untracks it; an untracked repo shows dots in place of its other boxes.

Every press saves at once to `settings.json` beside the shared state, and the pane shows `saved` or `⚠ not saved` next to the defaults. Other sessions pick the change up within 10 seconds.

Doorbell fetches the repo list once when the pane opens and shows at most 40 rows. Repos with a saved entry, or with something on the band, sort first, so the cap never hides them. When more match, the footer says `showing 40 of <n> · type to filter`. The filter box matches repo names in memory, so filtering makes no extra API calls.

## How it works

One session at a time holds a lease and polls GitHub through your `gh` login, every `pollSeconds`, and at once after the machine wakes from sleep. Other sessions read the shared state file under `~/.cache/doorbell` (mode 0700, since it holds private PR titles), so each event gives one notification however many sessions are open. If the leader exits cleanly, another session takes over within 20 seconds; if it crashed, within about 2 minutes, once its 90-second lease runs out. Backoff state lives in the same file, so a new leader inherits it.

## Settings

In `/config`:

| Key | Default | Meaning |
|---|---|---|
| `pollSeconds` | 60 | Seconds between polls, minimum 30. |
| `fadeMinutes` | 5 | How long approvals and ships stay on the band. |
| `includeBots` | false | Show bot comments on the band. |
| `notify` | true | Send notifications at all. |

## Development

```
claude plugin validate .
claude plugin test .
tsc -p .
```

`.claude-plugin/types/` is gitignored. Copy it from the SDK (as in Pilot Light) before `tsc` runs.

## Manual checks

Behaviours nobody has observed against a live account yet.

- [ ] A reply on a review thread clears 💬.
- [ ] A dismissed approval clears ✅ early.
- [ ] A team review request leaves the band once a teammate reviews. If it does not, that is a known limit.
- [ ] Two sessions produce one notification per event in total, and one takes over within 20 s of the leader quitting cleanly.
- [ ] `/doorbell`, untick 🚀 on a repo, and its next release does not notify.
- [ ] A real lid-close of a minute or more polls on wake.

## License

MIT. See `LICENSE`.
