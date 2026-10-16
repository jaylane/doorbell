# Doorbell Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/doorbell` settings pane that chooses which repos Doorbell watches and which of the four alert types each repo gets, with one-click "all repos" (live) and "all types".

**Architecture:** Settings live in `~/.cache/doorbell/settings.json` and filter only at the edges, in the band's segments and in the notes `reduce` builds. Polling, the triggers and `seen` are unchanged. A pure `paneView` turns settings plus the repo list into rows of tri-state boxes, `register.tsx` draws them as `Button`s in a Pane, and each press applies a pure toggle and writes the file.

**Tech Stack:** Claude Code mod SDK (Pane, Button, Input, `$.command.register`, `atom`), TypeScript + JSX (`h`), `gh api graphql`.

**Spec:** `docs/superpowers/specs/2026-10-16-doorbell-settings-design.md`

## Global Constraints

- Module loader rule: a function that receives `$` (or an `Io`) across files must be an `async function` declaration, not an arrow const. The validator also rejects a runtime `const io: Io = $`.
- Pure modules never read the clock. Time is `$.clock.now()`, passed in.
- Settings file: `~/.cache/doorbell/settings.json`, written as `settings.json.<sessionId>.tmp` and then moved into place with `mv`, as `writeState` does.
- Pane id `doorbell-settings`, title `Doorbell settings`, opened with `focus: true, closeOnEscape: true`. The command name is `doorbell`, with description `Choose which repos and alerts Doorbell watches`.
- Kinds and their order, everywhere: `review`, `comment`, `approved`, `shipped`, with icons 👀 💬 ✅ 🚀.
- Box text: `[x]` on, `[ ]` off, `[-]` mixed. Untracked repo cells are `·`. Row cap 40.
- State shape tag `v3` (Item and Event gain `fullRepo`). Settings session atom: `atom({ plugin: 'doorbell', key: 'settings' } as const, DEFAULT_SETTINGS, { shape: 'v1' })`.
- Gate before every commit: `claude plugin validate . && claude plugin test . && tsc -p .`. Never commit `.superpowers/` and never push.

## Review Focus

1. **A repo without an entry when you press one of its boxes.** It gets an entry holding its new effective state, so later default changes stop affecting it. Pinned in Task 2.
2. **Turning a type back on.** Its current items reappear on the band and no notification fires. Pinned in Task 3.
3. **Settings changed in one session.** Another session's band follows within one follower check. Pinned in Task 6.
4. **More than 40 repos.** Repos with entries or band items always show, and the footer says `showing 40 of N · type to filter`. Pinned in Task 5.
5. **An unreadable settings file.** Everything stays on, the pane says so, and the next toggle rewrites the file. Pinned in Tasks 2 and 6.

---

## File Structure

| File | Change |
|---|---|
| `types/index.d.ts` | `fullRepo` on Item; `Settings` type |
| `hooks/triggers/types.ts` | `fullRepo` on Event |
| `hooks/triggers/{review,approved,comments,shipped}.ts` | Set `fullRepo` |
| `hooks/settings.ts` | New: defaults, `effective`, `isTracked`, `groupState`, toggles, parse, file I/O |
| `hooks/band.tsx` | `segments` takes settings and filters items |
| `hooks/reduce.ts` | `reduce` takes settings and filters note events |
| `hooks/repos.ts` | New: `listRepos` |
| `hooks/pane.tsx` | New: `paneView` (pure) |
| `hooks/register.tsx` | Command, pane render, presses, filter input, settings atom and reload, `v3` |
| `tests/settings.test.ts`, `tests/repos.test.ts`, `tests/pane.test.ts` | New |
| `tests/band.test.ts`, `tests/reduce.test.ts`, trigger tests, `tests/doorbell.test.tsx`, `tests/fixtures.ts` | Updated |
| `README.md` | Settings section |

---

### Task 1: `fullRepo` on items and events

**Files:** Modify `types/index.d.ts`, `hooks/triggers/types.ts`, the four trigger files, `tests/fixtures.ts`, and the trigger tests that assert whole items or events.

**Interfaces:**
- Produces: `Item.fullRepo: string` and `Event.fullRepo: string`, each the `owner/name` from `repository.nameWithOwner`. For shipped, it's `Pending.repo`, which is already `owner/name`.

- [ ] **Step 1:** Extend the trigger tests so that each kind's item and event carry `fullRepo: 'acme/app'`, for the fixture repo `acme/app`. Run them and expect FAIL.
- [ ] **Step 2:** Add the field to both types and set it in all four triggers. Update fixtures and any whole-object `toEqual` that the new field breaks.
- [ ] **Step 3:** Run the gate and expect PASS. Commit `feat: carry owner/name on items and events`.

(The `v3` shape bump lands in Task 6, together with the other `register.tsx` changes.)

---

### Task 2: Settings model

**Files:** Create `hooks/settings.ts`, `tests/settings.test.ts`. Add `Settings` to `types/index.d.ts`.

**Interfaces:**

```ts
// types/index.d.ts
export type RepoSetting = { tracked: boolean; kinds: Kind[] }
export type Settings = { allRepos: boolean; defaults: Kind[]; repos: Record<string, RepoSetting> }
// hooks/settings.ts
export const KINDS: readonly Kind[]                    // ['review','comment','approved','shipped']
export const DEFAULT_SETTINGS: Settings                // { allRepos: true, defaults: [...KINDS], repos: {} }
export type Group = 'on' | 'off' | 'mixed'
export function isTracked(s: Settings, repo: string): boolean
export function effective(s: Settings, repo: string): Kind[]     // [] when untracked; KINDS order
export function allows(s: Settings, repo: string, kind: Kind): boolean
export function groupState(on: number, total: number): Group      // 0 → off, total → on, else mixed
export function columnState(s: Settings, kind: Kind | 'all'): Group  // over defaults + tracked entries
export function toggleTracked(s: Settings, repo: string): Settings
export function toggleRepoAll(s: Settings, repo: string): Settings
export function toggleRepoKind(s: Settings, repo: string, kind: Kind): Settings
export function toggleColumn(s: Settings, kind: Kind | 'all'): Settings
export function toggleAllRepos(s: Settings): Settings
export function toggleDefault(s: Settings, kind: Kind): Settings
export function parseSettings(text: string): Settings | null     // null when invalid
export async function readSettings(io: Io, dir: string): Promise<{ settings: Settings; isInvalid: boolean }>
export async function writeSettings(io: Io, dir: string, sessionId: string, s: Settings): Promise<void>
export async function settingsMtime(io: Io, dir: string): Promise<number | null>
```

Rules, taken from the spec's control table:
- **Group presses:** pressing a group that is `off` or `mixed` turns it all on; pressing one that is `on` turns it off.
- **Repos without an entry:** a press on such a repo first materialises its entry as `{ tracked: isTracked, kinds: effective }`, then applies the change.
- **Column presses** change `defaults` and every entry with `tracked: true`.
- **`toggleAllRepos` turning off** leaves entries untouched.
- **Kind lists** are always returned in `KINDS` order and deduplicated.
- **`parseSettings`** accepts only a well-formed object (a boolean `allRepos`, a `defaults` array of known kinds, and a `repos` object of `{ tracked: boolean, kinds: Kind[] }`) and returns `null` for anything else.
- **`readSettings`** returns `DEFAULT_SETTINGS` with `isInvalid: false` when the file is missing, and with `isInvalid: true` when the file is unparsable or invalid.

- [ ] **Step 1: Write failing tests in `tests/settings.test.ts`:**
  - `defaults track everything with all kinds`
  - `effective: own entry wins; no entry follows allRepos and defaults`
  - `toggleTracked on a repo without an entry under allRepos creates {tracked:false,kinds:[]}`, then again gives `{tracked:true,kinds:defaults}`
  - `toggleRepoKind on a repo without an entry materialises it, then a defaults change leaves it alone` (Review Focus 1)
  - `toggleRepoAll: mixed → all four, all four → none but still tracked`
  - `toggleColumn('approved') adds to defaults and every tracked entry, leaves untracked entries alone`; `toggleColumn('all')` with mixed → everything on, then off
  - `columnState over defaults plus tracked entries is mixed when they disagree`
  - `toggleAllRepos off keeps entries; repos without an entry become untracked`
  - `toggleDefault adds and removes in KINDS order`
  - `parseSettings rejects unknown kinds, wrong types and non-objects`
  - `readSettings: missing file gives defaults, garbage gives defaults with isInvalid` (Review Focus 5)
  - `writeSettings writes tmp then mv` (use `fakeIo`)
- [ ] **Step 2:** Run and expect FAIL. **Step 3:** Implement. **Step 4:** Run the gate and expect PASS.
- [ ] **Step 5:** Commit `feat: settings model with live all-repos and per-repo kinds`.

---

### Task 3: Filter the band and notifications

**Files:** Modify `hooks/band.tsx`, `hooks/reduce.ts`, `tests/band.test.ts`, `tests/reduce.test.ts`, and the call sites in `hooks/register.tsx` (pass `DEFAULT_SETTINGS` for now; Task 6 wires the real settings).

**Interfaces:**
- `segments(s: State, now: number, ghMissing: boolean, settings: Settings): Segment[]`: item segments only where `allows(settings, item.fullRepo, item.kind)`. The status segment is never filtered.
- `reduce(prev, d, failedPaths, aliases, now, cfg, settings: Settings)`: notes are built only from events where `allows(settings, e.fullRepo, e.kind)`. `seen` still records every event, and the state's `items` stay unfiltered.

- [ ] **Step 1: Write failing tests:**
  - band: `an item whose repo is untracked or whose kind is off is hidden; status segments stay`
  - reduce: `events of an off kind record seen but send no note`
  - reduce: `turning a kind back on shows its items with no note` (Review Focus 2). Poll with the kind off, then poll again with the same data and the kind on: the items are present in both polls and the notes are `[]`.
- [ ] **Step 2:** Run and expect FAIL. **Step 3:** Implement and update existing callers and tests to pass `DEFAULT_SETTINGS`. **Step 4:** Run the gate and expect PASS.
- [ ] **Step 5:** Commit `feat: filter band items and notifications by settings`.

---

### Task 4: Repo list

**Files:** Create `hooks/repos.ts`, `tests/repos.test.ts`.

**Interfaces:**
- `export async function listRepos(io: Io, gh: string): Promise<{ repos: string[]; error: string | null }>`
- Query, per page, sent with `gh api graphql -f query=… -F cursor=…`, or omitting `cursor` on the first page. This is the one place `-F` is fine, because the value is a cursor and not user text.

```graphql
query($cursor:String){ viewer{ repositories(first:100, after:$cursor,
  affiliations:[OWNER,COLLABORATOR,ORGANIZATION_MEMBER],
  orderBy:{field:PUSHED_AT,direction:DESC}){
  nodes{ nameWithOwner isArchived } pageInfo{ hasNextPage endCursor } } } }
```

- Up to 5 pages, skipping archived repos, in the order returned. On a non-zero exit or a body without `data`, return the repos gathered so far, with `error` set to a short reason: the first error message, or `offline` for an empty stdout.

- [ ] **Step 1: Write failing tests** (`fakeIo` `run` answering canned bodies):
  - `one page, archived skipped`
  - `follows endCursor across pages and stops at 5`
  - `failure on page 2 returns page 1 repos with an error`
  - `offline gives error 'offline'`
- [ ] **Step 2:** Run and expect FAIL. **Step 3:** Implement with a `timeoutMs` of 30 000. **Step 4:** Run the gate and expect PASS.
- [ ] **Step 5:** Commit `feat: list repos the viewer can access`.

---

### Task 5: Pane view model

**Files:** Create `hooks/pane.tsx`, `tests/pane.test.ts`.

**Interfaces:**

```ts
export type PaneRow = { repo: string; tracked: boolean; all: Group; kinds: Record<Kind, boolean> }
export type PaneView = {
  allRepos: boolean
  defaults: Record<Kind, boolean>
  column: { all: Group; kinds: Record<Kind, Group> }
  rows: PaneRow[]
  footer: string | null
}
export function paneView(s: Settings, repos: string[] | null, loadError: string | null,
  items: Item[], filter: string): PaneView
```

- `repos === null` means the list is still loading.
- **Candidate order:** repos with an entry in `s.repos`, then repos of current `items`, then `repos`. Duplicates are removed and the first position wins.
- **Filter:** keeps repos whose name contains the text, case-insensitive. When more than 40 match, show the first 40.
- **Footer**, first match wins:
  1. `loading repos…` while loading.
  2. `couldn't load repos: <loadError>` when there is a load error.
  3. `showing 40 of <M> · type to filter` when capped, where M is the number of matching candidates.
  4. Otherwise `null`.

- [ ] **Step 1: Write failing tests:**
  - `rows reflect effective kinds and tracking; untracked rows have all kinds false and all 'off'`
  - `column groups come from columnState`
  - `repos with entries and band items come first, even beyond the 40-row cap` (Review Focus 4): 60 repos, one with an entry at position 55 → it appears in the rows, and the footer is `showing 40 of 60 · type to filter`
  - `filter narrows case-insensitively`
  - `loading and error footers`
- [ ] **Step 2:** Run and expect FAIL. **Step 3:** Implement. **Step 4:** Run the gate and expect PASS.
- [ ] **Step 5:** Commit `feat: settings pane view model`.

---

### Task 6: Wire the command, the pane and settings into the mod

**Files:** Modify `hooks/register.tsx`, `tests/doorbell.test.tsx`.

**Behaviour:**
- **Shape tag:** the state atom's shape tag becomes `v3`.
- **New session atoms:**
  - `settings` (shape `v1`, initial `DEFAULT_SETTINGS`)
  - `pane`: `{ repos: string[] | null, error: string | null, filter: string, save: 'saved' | 'failed' | null, isInvalid: boolean }`
- **`session.start`** (interactive): `$.command.register({ name: 'doorbell', description: … })`, then load settings into the atom with `readSettings` and remember `settingsMtime`.
- **`command.run` for `doorbell`:** reset `pane` to `repos: null` and an empty filter, call `$.ui.open(...)`, then start `listRepos` without awaiting it before returning. It writes `repos` and `error` when done. Return `{ text: 'Doorbell settings opened.' }`. If `gh` is missing, set `error: 'gh not found'` and skip loading.
- **Settings reload:** the existing `followerRefresh`, and the leader's heartbeat, also check `settingsMtime` and re-read the file into the atom when it changed. A failed `readSettings` keeps the atom.
- **`ui.render` for `{ component: 'Pane', requestId: 'doorbell-settings' }`:** draw `paneView(read settings, pane.repos, pane.error, read(state).items, pane.filter)` as described in the spec's layout section.
  - Button keys: `all-repos`, `default:<kind>`, `col:all`, `col:<kind>`, `track:<repo>`, `row:<repo>`, `kind:<repo>:<kind>`.
  - The `Input` has key `filter`, and its `onInput` sets `pane.filter`.
  - Show the dim `settings file unreadable, using defaults` line when `isInvalid` is set. The header status shows `saved` or `⚠ not saved` from `pane.save`.
- **Each `onPress`:** apply the matching toggle to the current settings, set the atom, then `writeSettings`. Set `pane.save` to `saved`, or to `failed` when the write throws, in which case the atom still holds the new value until the next file read.
- **Band and reduce:** both now receive the settings atom's value instead of `DEFAULT_SETTINGS`.

- [ ] **Step 1: Write failing engine tests,** reusing the `world`. Add `command.register`, `command.run` and `ui.open` stubs if the kit needs them. Mount the pane with `component: 'Pane'` and the pane's `requestId`; check `MountTarget` and `$.ui.press` in `claude-code.d.ts` for the exact fields.
  - `/doorbell opens the settings pane and lists repos from gh`
  - `pressing a kind box writes settings.json and the band hides that kind`
  - `the all-repos and column boxes toggle every repo at once`
  - `another session's settings change reaches this band at the next follower check` (Review Focus 3): write `settings.json` with a new mtime, then `clock.advance(10_000)`, and the band no longer shows that item
  - `an unreadable settings.json shows the notice and keeps alerts on` (Review Focus 5)
  - `a failed repo list still shows repos from settings and band items`
- [ ] **Step 2:** Run and expect FAIL. **Step 3:** Implement. Keep `register.tsx` readable; if it passes about 250 lines, move the pane's JSX into an `async function drawPane($, e, …)` in `hooks/pane.tsx`. **Step 4:** Run the gate and expect PASS.
- [ ] **Step 5:** Commit `feat: /doorbell settings pane`.

---

### Task 7: README

**Files:** Modify `README.md`.

- [ ] **Step 1:** Add a `## Settings` section after the band section. It covers `/doorbell`, what live "All repos" means, the `[x]` / `[ ]` / `[-]` boxes, that every press saves at once and reaches other sessions within 10 s, the 40-row cap and the filter box, and that filtering never costs extra API calls. Add one manual check: `/doorbell, untick 🚀 on a repo, and its next release does not notify`.
- [ ] **Step 2:** Commit `docs: settings pane`.
