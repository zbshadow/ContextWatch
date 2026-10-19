# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

ContextWatch is a Claude Code **mod** (plugin of function hooks): an `AbovePrompt` band showing model · context usage (zone-colored) · VCS state. It ports `claude-context-meter` v1.0.6 (`~/Projects/Claude Observation Plugin/context_meter.js`) from a `statusLine` script. `SPEC.md` is the original hand-off spec; `docs/DESIGN.md` records the decisions taken on its open questions; `README.md` is the public, user-facing page.

## Before changing hook code

Load the `plugin-authoring` skill. Its `types/claude-code.d.ts` is authoritative and wins over SPEC.md: the mod API is early access. Grep it for every `$.*` call, event and prop before using it.

## Commands

```sh
claude plugin test .         # all tests/*.test.ts(x); no per-test filter exists
claude plugin validate .     # must pass (the CLAUDE.md-at-root warning is expected)
claude --plugin-dir .        # run interactively; hot-reloads on save
claude -p --plugin-dir . "/context-watch"   # headless smoke test (toggles the persisted hidden flag; run twice)
tsc -p .                     # only after an interactive --plugin-dir load has laid .claude-plugin/types/
```

Without `.claude-plugin/types/`, type-check with a tsconfig outside the repo whose `include` names the skill's `types/claude-code.d.ts` plus `hooks`, `types` and `tests` (compiler options are in that file's header).

## Architecture

The repo root is both the mod and its own marketplace (`.claude-plugin/plugin.json` + `marketplace.json`, source `"./"`). `userConfig` (`yellowAt`, `redAbove`, `showVcs`) arrives as `register(on, options)`.

Flow: `events → (refresh | refreshVcs | refreshUsage | apply*) → snapshot atom in $.state → ui.render AbovePrompt → band`.

- `hooks/register.tsx`: wiring only. All I/O lives in top-level functions: `refresh` (whole snapshot, at `session.start`), `refreshVcs` (git), `refreshUsage` (one `$.session.usage()` read), `applyUsage`/`applyModel`/`applyEffort` (values handed in by an event). `requestRefresh($, settings, 'snapshot' | 'vcs')` coalesces each pass kind separately. The render hook only reads atoms; its Compact button calls `compactNow`, which re-reads usage itself because `$.session.compact()` skips the caller's own `session.compact` hook. `noteZone` toasts once on entering red (`isRedNotified` in `$.state`, so reloads don't repeat it). Triggers:
  - usage: `session.measure` (pushed, no I/O), every `tool.call` (awaited; it's one engine read), `session.compact`, and `session.end` with `reason: 'clear'`, which zeroes it
  - model: `classic.PostModelSwitch` (`e.to_model`)
  - effort: `turn.step` on the main loop (`e.agentId === undefined`), read from `e.effort` before forwarding with `yield* next(e)`; there is no `$.session` getter, so `refresh` carries the last known effort over
  - VCS: `tool.call` on Bash/Edit/Write/NotebookEdit (not awaited), `turn.complete` (fallback), `classic.CwdChanged`, and `classic.FileChanged` on the git `HEAD`/`index` paths that `classic.SessionStart` adds to `watchPaths`
  - `classic.*` and `session.compact` hooks don't run in org-managed installs, so `tool.call` and `turn.complete` must keep the band correct without them.
- `hooks/meter.ts`, `hooks/vcs.ts`: pure, with no `$`. `buildSegments` returns `{ text, color?, dim?, part }`, which the band maps to `<Text>`. `fitSegments` drops the `/compact` hint first when the line exceeds `bodyColumns`. `detectVcs(run, cwd, exists)` takes injected I/O. Git line counts come from `git diff --numstat HEAD`, run only when the tree is dirty; `formatChanges` draws them as `+N` (`success`) and `-N` (`error`).
- `types/index.d.ts`: the `PluginState['context-watch']` contract (`snapshot`, `isHidden`). `isHidden` is mirrored to `$.store` so it persists.

## Mod-runtime rules learned the hard way

- `$` may only be passed to functions declared at the top level of the module; otherwise `claude plugin validate` refuses the module. Closures inside `register` can't receive `$`.
- No Node/DOM, only static imports, argv-only `$.process.run` (non-zero exit is treated as failure by the `Run` wrapper).
- `$.session.model()` returns the model ID (`claude-opus-5-5`), not a display name; `displayModel` converts it.
- Observing hooks return `next(e)`'s result unchanged; gating ones carry `.catch(($, e, next) => next(e))`.
- No ANSI escapes: color comes from theme keys (`success`/`warning`/`error`) plus raw `cyan` for a dirty tree.

## Test-kit rules (`claude-code/testing`)

- Hooks the test registers with `on` are the bottom. For a call on `$` they must answer `{ value: ... }`; for an event (`session.start`, `turn.complete`, ...) they return the plain result.
- An event can't be registered twice on the test's `on`. Vary behavior through flags on the `world()` helper in `tests/register.test.tsx` instead.
- `$.session.compact()` from the mod needs a bottom `session.messages` answering at least one message, and the bottom `session.compact` must return at least one: a compaction never leaves an empty conversation.
- `ui.press` runs the Button's `onPress`; the tests read its effects right after.
- `$.ui.mount` needs a bottom `ui.render` hook. Tests draw an `ENGINE` marker there to detect "the mod drew nothing".
- Loop UI assertions over `['terminal', 'desktop']`.
