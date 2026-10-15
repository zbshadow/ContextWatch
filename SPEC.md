# ContextWatch — Mod Spec

> Port of [`claude-context-meter`](https://github.com/zbshadow/claude-context-meter) (npm, v1.0.6) from a `statusLine` command script to a Claude Code **mod** (a plugin of function hooks). This document is the hand-off for the implementing agent.

## 1. Goal

Show, at all times during a Claude Code session, a single line with:

```
Sonnet 4.6 · Context: 24k (18%) · [GitHub/my-project/main]
```

- the active model,
- context-window usage (tokens + percent), color-coded by pressure,
- a `/compact` hint when pressure is high,
- version-control state (platform / repo / branch, dirty flag, detached HEAD, TFVC).

Behaviour must match the existing meter (§5) except where §8 says otherwise. The mod replaces the npm installer + `settings.json` rewiring entirely: it is installed with `/plugin install` and touches no user settings.

## 2. Before you start

1. **Load the `plugin-authoring` skill.** It holds the authoritative, build-specific API (`types/claude-code.d.ts`, ~14k lines), the examples, and `reference.md`. The mod API is early access and moves between releases — **the types file wins over anything in this spec**. Grep it for every API named below before using it.
2. Read the source being ported: `~/Projects/Claude Observation Plugin/context_meter.js` (293 lines) and its tests `tests/test_context_meter.js` (~95 cases). Port logic from there, not from memory.
3. Develop in this repo (`~/Projects/ContextWatch`) and run it with `claude --plugin-dir ~/Projects/ContextWatch` (interactive sessions hot-reload on save).

## 3. Repository layout

The repo root **is** the mod folder and its own marketplace.

```
ContextWatch/
├── .claude-plugin/
│   ├── plugin.json          # { name: "context-watch", version, description, types, userConfig }
│   └── marketplace.json     # one entry, source "./"
├── hooks/
│   ├── hooks.json           # { "modules": ["./register.tsx"] }
│   ├── register.tsx         # hooks module: wiring only (events, $ calls, drawing)
│   ├── meter.ts             # pure: formatTokens, classify, buildSegments
│   └── vcs.ts               # pure parsers + detectVcs(run, cwd, exists)
├── types/
│   └── index.d.ts           # PluginState contract for $.state
├── tests/
│   ├── meter.test.ts
│   ├── vcs.test.ts
│   └── register.test.ts     # engine-level tests via claude-code/testing
├── tsconfig.json            # extends .claude-plugin/types/tsconfig.json
├── README.md
├── LICENSE                  # exists (MIT)
└── SPEC.md                  # this file
```

Notes:
- `.claude-plugin/types/` is written by the engine on load and git-ignored by it; don't commit it.
- Every file the module imports must be `.ts`/`.tsx` and imported with a static `import` (no dynamic `import()` — the module won't load).
- The module runs with **no Node and no DOM**: no `child_process`, `fs`, `https`, `process.cwd()`. Everything goes through `$` (§6).

## 4. Architecture

```
 events ──► refresh() ──► Snapshot (in $.state) ──► ui.render AbovePrompt ──► band
            │  $.session.usage()      ▲
            │  $.session.model()      │ write only from events, never from render
            │  detectVcs($.process.run)
```

- **`refresh($)`** gathers usage, model and VCS state, builds a `Snapshot`, and writes it with `update($, snapshotAtom, ...)`. All I/O lives here.
- **Render hook** only reads the atom and draws. It never calls `$.process.run`, never writes state (writes while drawing are denied).
- **Pure modules** (`meter.ts`, `vcs.ts`) take plain inputs and return plain data — no `$`. They're what the ported unit tests target.

### State contract (`types/index.d.ts`)

```ts
export type Zone = 'green' | 'yellow' | 'red'

export type VcsState =
  | { type: 'none' }
  | { type: 'branch'; platform: string | null; repo: string | null; branch: string; dirty: boolean }
  | { type: 'detached'; platform: string | null; repo: string | null; hash: string; dirty: boolean }
  | { type: 'tfvc'; platform: string; repo: string | null; branch: string | null; dirty: boolean }

export type Snapshot = {
  model: string | null
  tokens: number
  percent: number
  vcs: VcsState
}

declare module 'claude-code' {
  interface PluginState {
    'context-watch': { snapshot: Snapshot | null; isHidden: boolean }
  }
}
```

`plugin.json` names it: `"types": "./types/index.d.ts"`. Atoms: `atom({ plugin: 'context-watch', key: 'snapshot' } as const, null)` etc. (see `examples/band.tsx`).

## 5. Behaviour (parity with v1.0.6)

### 5.1 Tokens and percent

Source: `$.session.usage()` (the plain call — free; **do not** pass `breakdown`).
- `tokens` ← `context.tokens ?? 0` (same figure as the old `total_input_tokens`).
- `percent` ← `context.percent ?? 0`, displayed rounded: `Math.round`.

`formatTokens(n)`:
| Input | Output |
|---|---|
| `< 1000` | `String(n)` |
| `≥ 1000` | `${Math.round(n/1000)}k` (1499→`1k`, 1500→`2k`) |
| `≥ 1_000_000` | `${Math.round(n/1_000_000)}M` |

### 5.2 Zones

`classify(tokens)` — absolute token counts, boundaries exactly as today:
| Zone | Rule | Color |
|---|---|---|
| green | `< 70_000` | theme `success` |
| yellow | `70_000 ≤ n ≤ 100_000` | theme `warning` |
| red | `> 100_000` | theme `error` |

Thresholds become `userConfig` (§7); defaults above.

### 5.3 Model

`$.session.model()` returns the model "as `/model` shows it". Verify what this build actually returns. If it is a model ID (`claude-sonnet-4-6`) rather than a display name, add a pure `displayModel(id)` that turns it into `Sonnet 4.6` style, and fall back to the raw string. If empty, leave out the model segment and its `·`.

### 5.4 Line composition

Segments in order, separated by ` · ` in dim/gray:

1. `<model>` — dim (left out when null)
2. `Context: ` dim + `<formatted> (<pct>%)` in the zone color
3. Red zone only: `Consider /compact or /clear` — dim
4. VCS segment (§5.5)

`buildSegments(snapshot) → Array<{ text: string; color?: Color; dim?: boolean }>` is the pure function; the render hook maps segments to `<Text>`. This replaces the old ANSI-string `render()`/`formatVcs()`. **No ANSI escapes anywhere** — color comes from `Text` props.

### 5.5 VCS segment

| State | Text | Style |
|---|---|---|
| none | `[No version control]` | dim |
| branch, clean | `[GitHub/my-project/main]` | dim |
| branch, dirty | `[GitHub/my-project/main*]` | `cyan` (raw color, as today) |
| detached, clean | `[GitHub/my-project] (HEAD detached at a3f9c12)` | dim |
| detached, dirty | `… (HEAD detached at a3f9c12)*` (star after the paren) | `cyan` |
| tfvc | `[<platform>/<repo>/<branch>]` + `*` when dirty | dim / `cyan` |
| unknown type | `[Unknown VCS]` | dim |

Empty parts are dropped from the `/`-join (no remote → `[main]`; no platform+repo on detached → no bracket prefix).

### 5.6 VCS detection (port of `detectVcs`)

Keep the provider design exactly: a list of `{ key, marker, detect }` providers; providers whose marker (`.git`, `$tf`) is found walking up from the cwd go first, then the rest; first non-null result wins, else `{ type: 'none' }`.

Port mapping:
| Old | New |
|---|---|
| `process.cwd()` | `await $.session.cwd()` |
| `execSync(cmd)` | `$.process.run(argv, { cwd, timeoutMs })` — **argv arrays, no shell**. Treat `exitCode !== 0` as a throw (old code relied on `execSync` throwing). Trim `stdout`. |
| `fs.existsSync(p)` | `$.fs.stat(p)` (resolves/rejects — check the types for the exact miss behaviour) |

Inject `run` and `exists` as parameters so `vcs.ts` stays pure and testable, same as today.

Git (`.git` marker):
- `git branch --show-current` — failure ⇒ not git (return null). Empty ⇒ detached.
- `git remote get-url origin` → `parseRemoteUrl` (SSH `git@host:owner/repo(.git)` and URL forms; `github.com`→GitHub, `gitlab.com`→GitLab, `bitbucket.org`→Bitbucket, else raw host). Failure ⇒ platform/repo null.
- `git status --porcelain` — non-empty ⇒ dirty; failure ⇒ clean.
- Detached: `git rev-parse --short HEAD`, fallback `HEAD`.

TFVC (`$tf` marker):
- `tf workfold /noprompt` — parse `Workspace :`, `Collection :`, first `$/…` server path. Failure, or neither workspace nor path ⇒ null.
- `parseTfvcPlatform(url)`: `dev.azure.com/<org>` ⇒ org (fallback `Azure DevOps`); `<org>.visualstudio.com` ⇒ org; other host ⇒ host; null/unparseable ⇒ `TFS`.
- repo = first server-path segment (fallback workspace name); branch = rest joined by `/`.
- `tf status /noprompt /recursive` — non-empty and not `/no pending changes/i` ⇒ dirty; failure ⇒ clean.

Use a short `timeoutMs` (e.g. 3000) on each run; a timeout is a failure for that step, never an exception out of `refresh`.

## 6. Engine wiring (`register.tsx`)

### 6.1 When to refresh

The old script ran whenever Claude Code redrew the status line. Equivalent triggers here — no polling, no background timers:

| Event | Why |
|---|---|
| `session.start` | initial paint (call after `await next(e)`) |
| `turn.complete` | usage + model change after every response (after `await next(e)`) |
| `session.compact` | usage drops after compaction (after `await next(e)`) |
| `tool.call` completing for `Bash` (and file-edit tools) | git branch/dirty may have changed; `await next(e)` then refresh |
| `session.end` with `reason: 'clear'` | reset snapshot to zero usage; next `turn.complete` repaints |

Coalesce: if a refresh is already in flight, mark "dirty" and run one more when it finishes — never more than one concurrent `refresh`. Every hook returns `next(e)`'s result unchanged; this mod observes and never alters or blocks anything. A failed refresh leaves the previous snapshot in place.

`refresh` must not block the turn noticeably: run VCS commands after `next(e)` resolves, and don't await `refresh` from a `tool.call` hook if that would delay the tool result (check hook budget rules in `reference.md` → "Work that outlives a dispatch").

### 6.2 Drawing

`on('ui.render', { component: 'AbovePrompt' }, …)`:
- `return next(e)` (draw nothing) when `e.props.hasSurvey`, `isHidden`, or snapshot is null.
- Otherwise one row: `<Box>` of `<Text>` segments from `buildSegments`, built from `$.ui.resolve(e)`.
- Fit `e.props.bodyColumns`; on overflow truncate at the end (`wrap="truncate-end"`), and prefer dropping the `Consider /compact` hint before the VCS segment.
- Must validate on `terminal` **and** `desktop` surfaces (tests loop both).

### 6.3 Slash command

Register in `session.start`: `$.command.register({ name: 'context-watch', description: 'Show or hide the context meter band' })`. `command.run` toggles `isHidden`, persists it with `$.store.set('isHidden', …)`, and answers `{ text: 'ContextWatch shown.' | 'ContextWatch hidden.' }`. On `session.start`, seed `isHidden` from `$.store`.

## 7. Configuration (`userConfig` in `plugin.json`)

| Field | Type | Default | Meaning |
|---|---|---|---|
| `yellowAt` | number | `70000` | tokens at which yellow starts |
| `redAbove` | number | `100000` | tokens above which red starts |
| `showVcs` | boolean | `true` | include the VCS segment |

Read from `register(on, options)`. Check the `userConfig` schema in the types for exact field syntax. If `yellowAt >= redAbove`, fall back to defaults and `$.ui.log` a warning.

## 8. Deliberate changes from v1.0.6

| Old | New | Reason |
|---|---|---|
| `statusLine` command in `~/.claude/settings.json` | `AbovePrompt` band | Mods don't own the status line command; the band supports theme-aware color. Does **not** touch an existing `statusLine`. |
| ANSI escape codes | `Text` `color` / `dimColor` | Surfaces draw color; works in desktop too. |
| `npx … install/uninstall`, `cli.js`, settings backup | `/plugin install`, `/plugin uninstall` | Plugin system handles install. |
| npm update check + `.update-cache.json` + "New version available" line | **Removed** | `claude plugin update` handles updates; no network calls from the mod. |
| `CURRENT_VERSION` constant | `version` in `plugin.json` only | Single source of truth. |
| Synchronous `execSync` | async `$.process.run` with argv + timeout | No Node; no shell injection surface. |

## 9. Tests

`claude plugin test .` runs `tests/*.test.ts` (import `test`, `expect`, `mock` from `claude-code/testing`).

1. **Port every case** from `tests/test_context_meter.js` that covers `formatTokens`, `classify`, `parseRemoteUrl`/`detectVcs` (git: GitHub HTTPS, Bitbucket/GitLab SSH, no remote, unknown host, detached clean/dirty, no repo, status failure), `parseTfvcPlatform`, `detectTfvc`, provider ordering by marker, and `formatVcs`/`render` text+color outcomes — asserting on `buildSegments` output (`text`, `color`, `dim`) instead of ANSI strings.
2. **Drop** `parseInput` tests (stdin JSON is gone) and `isNewer`/`checkForUpdate` tests (feature removed).
3. **Add**: `displayModel` (if needed); threshold config incl. invalid config fallback; `refresh` with mocked `$.session.usage`/`$.process.run`; render hook draws nothing when hidden/no snapshot/`hasSurvey`; band validates on `['terminal', 'desktop']`; `/context-watch` toggles and persists; a hook never changes `next(e)`'s result.

## 10. Acceptance criteria

- [ ] `claude plugin validate .` passes with no refusals.
- [ ] `tsc -p .` passes.
- [ ] `claude plugin test .` passes.
- [ ] In `claude --plugin-dir .`: band shows on start, updates after each response, turns yellow/red at thresholds, shows the compact hint in red, reflects `git checkout`/edits made via Bash, shows `[No version control]` outside a repo.
- [ ] `/context-watch` hides/shows, and the choice survives a new session.
- [ ] No ANSI codes, no network requests, no writes outside `$.state`/`$.store`.
- [ ] `.claude-plugin/marketplace.json` present; README has the install line `/plugin install context-watch --marketplace zbshadow/ContextWatch` plus the shell and desktop-app variants from `reference.md` → "Sharing a mod".

## 11. Open questions (decide during build, note the answer in the README or an ADR)

1. **Zones by tokens or by percent?** Absolute thresholds made sense at 200k windows; with 1M-token windows, 100k is 10%. Parity says tokens (default); consider adding a `zoneBasis: "tokens" | "percent"` option.
2. **Also call `$.ui.status`?** A plain-text duplicate under the prompt for users who hide the band. Default: no.
3. **Refresh VCS on file-edit tools too, or Bash only?** Edits make the tree dirty; include `Edit`/`Write`/`NotebookEdit` unless it proves noisy.
