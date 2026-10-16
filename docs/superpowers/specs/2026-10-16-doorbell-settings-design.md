# Doorbell settings: which repos, which alerts

## Intent

Let a person cut Doorbell's noise down to what they care about: choose the repos it
watches and, per repo, which of the four alerts (👀 review requested, 💬 comments,
✅ approved, 🚀 shipped) reach the band and notifications. One click selects every
repo they can access; one click selects every alert type.

Agreed with the owner on 2026-10-16: layout A (one table of repos × alert types),
opened by `/doorbell`, with live "all repos".

## Settings

Stored in `~/.cache/doorbell/settings.json`, next to `state.json` but separate from it:
the leader rewrites `state.json` every poll, and an edit made from any session would
race with it. Written with the same tmp-file-then-`mv` as the state file. Every
interactive session re-reads it when its `mtimeMs` changes (on the existing 10 s
follower check, and on the leader's heartbeat), so a change reaches all sessions
within 10 s.

```ts
type Settings = {
  allRepos: boolean                                  // live "all"
  defaults: Kind[]                                   // types a tracked repo gets
  repos: Record<string, { tracked: boolean; kinds: Kind[] }>  // owner/name → overrides
}
```

- A repo is tracked when its entry says `tracked: true`, or, without an entry, when
  `allRepos` is on.
- A repo's effective alert types: its own entry if it has one (`[]` when its entry is
  untracked); otherwise `defaults` when `allRepos` is on; otherwise none.
- Missing file: `allRepos: true`, `defaults` = all four kinds, `repos: {}`, which is
  today's behaviour.
- An unreadable or invalid file is treated as missing, and the pane shows a dim line
  `settings file unreadable, using defaults`. The next toggle rewrites it cleanly.

## Filtering

Settings filter at the edges. The poll, the triggers, `reduce` and `seen` keep
working on everything.

- The band shows an item only when its kind is in its repo's effective types.
- A notification fires only for events whose kind is in their repo's effective types.
  `seen` still records every event, so turning a type back on shows its current items
  at once and sends no notifications for them.
- Status segments (`⚠ …`, `stale Nm`) are never filtered.

`Item` and `Event` gain `fullRepo` (`owner/name`, from `repository.nameWithOwner`),
because `repo` holds only the name. The stored state shape tag moves to `v3`.

## The screen

`/doorbell` is registered at `session.start` (interactive sessions only) and opens a
pane with id `doorbell-settings`, title `Doorbell settings`, `focus` and
`closeOnEscape`. Running it again while open re-focuses it.

Layout, top to bottom:

1. Header row: `[x] All repos (live)` toggle, then `new repos get:` and four default
   kind toggles `[x]👀 [x]💬 [x]✅ [x]🚀`. Right side, dim: `saved` after a successful
   write, `⚠ not saved` after a failed one.
2. `filter:` text input. Each keystroke narrows the repo rows to `owner/name`
   containing the text, case-insensitive.
3. Column row, label `every tracked repo`: an `all` group box, then one group box per
   kind.
4. One row per repo: a tracking toggle and the repo's `owner/name`, then an `all` group
   box and four kind toggles. An untracked repo shows dim `·` in place of the five boxes.
5. Footer, dim: `showing N of M · type to filter` when rows are capped; `loading
   repos…` while the list loads; `couldn't load repos: <reason>` after a failure.

Boxes are `Button`s. Tab or arrows move focus; Enter or a click toggles. Every press
writes `settings.json` immediately; there is no Save button.

Group boxes are tri-state: `[x]` all on, `[ ]` all off, `[-]` mixed. Pressing `[-]` or
`[ ]` turns the whole group on; pressing `[x]` turns it off.

| Control | Group | On | Off |
|---|---|---|---|
| Repo tracking toggle | that repo | entry `{tracked: true, kinds: defaults}` | entry `{tracked: false, kinds: []}` |
| Repo `all` box | that repo's 4 kinds | kinds = all four | kinds = none, still tracked |
| Repo kind box | one kind | add kind | remove kind |
| Column `all` box | all kinds in `defaults` and in every tracked entry | all four everywhere | none everywhere |
| Column kind box | that kind in `defaults` and in every tracked entry | add kind everywhere | remove kind everywhere |
| `All repos (live)` | `allRepos` | true | false; repos without an entry become untracked, repos with an entry keep it |
| Default kind toggle | `defaults` | add kind | remove kind |

When a press changes a repo that has no entry, the repo gets an entry holding its new
effective state, so later changes to `defaults` stop affecting it. Column presses
change `defaults` and every existing entry, so repos without an entry follow through
`defaults`.

### Repo list

Loaded each time the pane opens, with one `gh api graphql` query:
`viewer.repositories(first: 100, affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER],
orderBy: {field: PUSHED_AT, direction: DESC})` selecting `nameWithOwner`, paged by
cursor up to 5 pages (500 repos). Archived repos are skipped.

Rows shown: every repo that has an entry in `settings.repos` or a current band item,
then the rest in pushed-at order, capped at 40 rows in total when the filter is empty.
With a filter, all matching repos show, capped at 40 with the same footer.

While loading, rows show from settings and band items only. If the query fails, the
footer names the reason and those rows stay editable.

## Errors

| Case | Behaviour |
|---|---|
| Settings file missing | Defaults: everything on |
| Settings file unreadable | Defaults, dim notice in the pane, rewritten on next toggle |
| Repo list query fails | Footer reason; known repos stay editable |
| Settings write fails | `⚠ not saved` in the header; the in-memory settings revert at the next file read |
| Repo renamed or access lost | Its entry stays, is listed, and matches nothing |
| Everything switched off | Band shows only status segments; hidden otherwise |

## Not in this change

Separate band and notification settings, org-wide toggles, syncing settings across
machines, and filtering inside the GitHub query.
