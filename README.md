# ContextWatch

[![Version](https://img.shields.io/badge/version-0.1.1-blue)](.claude-plugin/plugin.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-%E2%89%A52.1.287-d97757)](https://claude.com/claude-code)

A Claude Code mod that shows the model, context usage and repository status in a line above the prompt.

```
Opus 5.5 · Effort: high · Context: 24k (18%) · [GitHub/my-project/main*] +12 -3
```

<!-- TODO: add a screenshot of the band, e.g. ![ContextWatch in action](docs/screenshot.png) -->

## Features

- **Context meter**: tokens used and percentage of the context window, colored green, yellow or red.
- **Compact button**: shown next to the meter when usage is in the red.
- **Red-zone notification**: shown once when usage enters the red.
- **Model and effort**: the active model and its reasoning effort.
- **Repository status**: platform, repo, branch, uncommitted changes, and lines added and removed.
- **Supported version control**: GitHub, GitLab, Bitbucket, Azure DevOps and TFVC.
- **No network access**; does not modify `settings.json`.

## Requirements

- [Claude Code](https://claude.com/claude-code) 2.1.287 or later

## Installation

**In Claude Code:**

```
/plugin install context-watch --marketplace zbshadow/ContextWatch
```

Answer `y` to add the marketplace, then choose a scope.

**From a terminal:**

```sh
claude plugin install context-watch --marketplace zbshadow/ContextWatch
```

**In the Claude desktop app:** click **+** next to the prompt box, choose **Plugins** → **Add marketplace**, enter `zbshadow/ContextWatch`, then click **Add plugin**.

## Updating

```sh
claude plugin update context-watch@context-watch
```

Restart Claude Code to load the new version.

## Uninstalling

```sh
claude plugin uninstall context-watch@context-watch
```

To disable without uninstalling: `claude plugin disable context-watch@context-watch`.

## Usage

### Reading the band

| Segment | Example | Meaning |
|---|---|---|
| Model | `Opus 5.5` | Active model |
| Effort | `Effort: high` | Reasoning effort; shown after the first prompt |
| Context | `Context: 24k (18%)` | Tokens used and percentage of the context window |
| Repository | `[GitHub/my-project/main*]` | Platform, repo and branch; `*` means uncommitted changes |
| Changes | `+12 -3` | Lines added and removed since the last commit |

| Color | Default range |
|---|---|
| Green | under 70k tokens |
| Yellow | 70k – 100k tokens |
| Red | over 100k tokens |

### Compacting

In the red zone, click **Compact** or press `c` while the band is focused to run `/compact`. The button is hidden while Claude is working.

### Showing and hiding

`/context-watch` toggles the band. The setting persists across sessions.

## Configuration

Set options in `/config`, or from a terminal:

```sh
claude plugin configure context-watch@context-watch
```

| Option | Default | Description |
|---|---|---|
| `yellowAt` | `70000` | Tokens at which the meter turns yellow |
| `redAbove` | `100000` | Tokens above which the meter turns red |
| `showVcs` | `true` | Show the repository segment |

Thresholds are token counts, not percentages.

## Troubleshooting

**The band isn't showing.** Run `/context-watch` to show it. If it still doesn't appear, check that the plugin is enabled with `claude plugin list`.

**Effort isn't shown.** It appears after the first prompt of a session, and is omitted for models without effort levels.

**Updates are delayed under organization-managed settings.** Some managed installs restrict which events plugins receive. The band still refreshes after each tool call and response, but model switches and commits made outside the session can take longer to appear.

## Contributing

Issues and pull requests are welcome.

```sh
git clone https://github.com/zbshadow/ContextWatch.git
cd ContextWatch
claude --plugin-dir .        # run with live reload
claude plugin test .         # run tests
claude plugin validate .     # validate the plugin
```

Design notes: [docs/DESIGN.md](docs/DESIGN.md).

## License

[MIT](LICENSE) © Brice Bayless
