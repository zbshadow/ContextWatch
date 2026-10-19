# Design notes

Decisions taken on the open questions in `SPEC.md`. ContextWatch succeeds the `claude-context-meter` npm package (v1.0.6), replacing its `statusLine` script with a band above the prompt.

- **Zones are by token count, not percent.** This matches v1.0.6. With 1M-token context windows the default red line (100k) sits at 10% of the window, so users can raise `yellowAt`/`redAbove`. If `yellowAt` is not below `redAbove`, the defaults are used and a warning is logged.
- **No status-line duplicate.** The mod only draws the band; it does not also call `$.ui.status`.
- **Updates are pushed by the engine, not polled.** Usage comes from `session.measure` at the end of each turn and is re-read after every tool call, so it moves during long turns too. The model changes as soon as the user switches (`/model`, fast mode, fallback).
- **Effort is learned from the first model request.** The engine has no getter for it, so the mod reads it off each main-loop `turn.step` (the level actually sent, after any downgrade for the model). It appears once the first prompt of a session is sent and follows `/effort` and `/model` from the next request on.
- **VCS refreshes after `Bash`, `Edit`, `Write` and `NotebookEdit`.** File edits make the tree dirty, so they count as well as shell commands. The mod also has the engine watch git's `HEAD` and `index`, so a checkout or commit made in another terminal shows up right away, and it refreshes when the session's working directory changes (e.g. entering a worktree).
- **Line counts** come from `git diff --numstat HEAD` (staged and unstaged); untracked files aren't counted, as in `git diff`.
- **Red-zone notification** fires once on crossing into red and again only after usage drops back out.
- **Degrades under managed settings.** Where an organization manages Claude Code, hooks on `classic.*` events and `session.compact` run only for plugins the organization lists. Without them the band still updates after each tool call and turn, but a model switch shows after the next tool call and outside git changes after the next turn.
- **No update check, no network.** `claude plugin update` handles updates.
