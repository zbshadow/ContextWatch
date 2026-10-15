# ContextWatch

A Claude Code mod that keeps one line above the prompt:

```
Sonnet 4.6 · Effort: high · Context: 24k (18%) · [GitHub/my-project/main*] +12 -3
```

- the active model
- the reasoning effort of the main loop (`low` … `max`), omitted for a model without effort
- context-window usage (tokens and percent), green / yellow / red by pressure
- `Consider /compact or /clear` once usage is in the red
- version control: platform/repo/branch, `*` and cyan when the tree is dirty, detached HEAD, or TFVC workspace
- lines changed against `HEAD` (staged and unstaged), `+N` in green and `-N` in red, after a git branch; untracked files aren't counted, as in `git diff`

It is the successor to the `claude-context-meter` npm package (v1.0.6). It replaces the `statusLine` script with a band above the prompt, and doesn't touch your `settings.json` or an existing `statusLine`.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install context-watch --marketplace zbshadow/ContextWatch
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```sh
claude plugin install context-watch --marketplace zbshadow/ContextWatch
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `zbshadow/ContextWatch`, then **Add plugin**.

## Use

`/context-watch` hides or shows the band. The choice is kept across sessions.

## Configuration

Set from `/config` (or `pluginConfigs["context-watch"].options` in settings):

| Option | Default | Meaning |
|---|---|---|
| `yellowAt` | `70000` | tokens at which the meter turns yellow |
| `redAbove` | `100000` | tokens above which it turns red and suggests `/compact` |
| `showVcs` | `true` | include the version-control segment |

If `yellowAt` is not below `redAbove`, the defaults are used and a warning is logged.

## Decisions

- **Zones are by token count, not percent.** This matches v1.0.6. With 1M-token context windows the default red line (100k) sits at 10% of the window, so raise `yellowAt`/`redAbove` if you'd rather be warned later.
- **No status-line duplicate.** The mod only draws the band; it does not also call `$.ui.status`.
- **Updates are pushed by the engine, not polled.** Usage comes from `session.measure` at the end of each turn and is re-read after every tool call, so it moves during long turns too. The model changes as soon as you switch (`/model`, fast mode, fallback).
- **Effort is learned from the first model request.** The engine has no getter for it, so the mod reads it off each main-loop `turn.step` (the level actually sent, after any downgrade for the model). It appears once the first prompt of a session is sent and follows `/effort` and `/model` from the next request on.
- **VCS refreshes after `Bash`, `Edit`, `Write` and `NotebookEdit`.** File edits make the tree dirty, so they count as well as shell commands. The mod also has the engine watch git's `HEAD` and `index`, so a checkout or commit made in another terminal shows up right away, and it refreshes when the session's working directory changes (e.g. entering a worktree).
- **Degrades under managed settings.** Where an organization manages Claude Code, hooks on `classic.*` events and `session.compact` run only for plugins the organization lists. Without them the band still updates after each tool call and turn, but a model switch shows after the next tool call and outside git changes after the next turn.
- **No update check, no network.** `claude plugin update` handles updates.

## Development

```sh
claude --plugin-dir .        # run it; interactive sessions hot-reload on save
claude plugin test .         # tests/*.test.ts(x)
claude plugin validate .
tsc -p .                     # after the engine has laid .claude-plugin/types/ (first --plugin-dir load)
```

## License

MIT
