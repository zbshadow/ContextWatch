import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage } from 'claude-code'

import type { Snapshot, VcsState } from '../types'
import { displayModel, fitSegments, resolveThresholds } from './meter'
import type { Thresholds } from './meter'
import { detectVcs } from './vcs'
import type { Exists, Run } from './vcs'

const STORE_HIDDEN = 'isHidden'
const RUN_TIMEOUT_MS = 3000
const VCS_TOOLS = ['Bash', 'Edit', 'Write', 'NotebookEdit'] as const
// Files under the git dir that move on checkout, commit, stage and reset.
const GIT_WATCH_FILES = ['HEAD', 'index'] as const

const snapshotAtom = atom({ plugin: 'context-watch', key: 'snapshot' } as const, null)
const isHiddenAtom = atom({ plugin: 'context-watch', key: 'isHidden' } as const, false)

type Settings = { thresholds: Thresholds; showVcs: boolean }
type Pass = 'snapshot' | 'vcs'

// One pass of each kind at a time: a request while one runs asks for one more pass after it.
const gates: Record<Pass, { running: Promise<void> | null; isStale: boolean }> = {
  snapshot: { running: null, isStale: false },
  vcs: { running: null, isStale: false },
}
// The git files the engine watches for this mod (classic.FileChanged).
let watchedPaths: string[] = []

function runner($: EngineInterface, cwd: string): Run {
  return async argv => {
    const { exitCode, stdout } = await $.process.run(argv, { cwd, timeoutMs: RUN_TIMEOUT_MS })
    if (exitCode !== 0) throw new Error(`${argv.join(' ')} exited ${exitCode}`)
    return stdout.trim()
  }
}

async function readVcs($: EngineInterface, settings: Settings): Promise<VcsState> {
  if (!settings.showVcs) return { type: 'none' }
  const cwd = await $.session.cwd()
  const exists: Exists = path => $.fs.exists(path)
  return detectVcs(runner($, cwd), cwd, exists)
}

/** The whole snapshot: model, usage and VCS. Session start only; later passes move one part. */
async function refresh($: EngineInterface, settings: Settings): Promise<void> {
  try {
    const [usage, model, vcs] = await Promise.all([
      $.session.usage(),
      $.session.model().catch(() => ''),
      readVcs($, settings),
    ])
    const snapshot: Snapshot = {
      model: displayModel(model),
      // No engine getter for effort: it is learned from the next turn.step.
      effort: (await read($, snapshotAtom))?.effort ?? null,
      tokens: usage.context.tokens ?? 0,
      percent: usage.context.percent ?? 0,
      vcs,
    }
    await update($, snapshotAtom, () => snapshot)
  } catch {
    // keep the previous snapshot
  }
}

async function refreshVcs($: EngineInterface, settings: Settings): Promise<void> {
  if (!settings.showVcs) return
  try {
    const vcs = await readVcs($, settings)
    await update($, snapshotAtom, snapshot => (snapshot ? { ...snapshot, vcs } : snapshot))
  } catch {
    // keep the previous VCS state
  }
}

async function applyUsage($: EngineInterface, context: SessionContextUsage): Promise<void> {
  // A window with no response yet has no fill: keep what is shown.
  if (context.tokens === undefined) return
  const tokens = context.tokens
  const percent = context.percent ?? 0
  await update($, snapshotAtom, snapshot => (snapshot ? { ...snapshot, tokens, percent } : snapshot))
}

/** Usage alone, read from the engine: no processes, cheap enough to run after every tool. */
async function refreshUsage($: EngineInterface): Promise<void> {
  try {
    await applyUsage($, (await $.session.usage()).context)
  } catch {
    // keep the previous usage
  }
}

async function applyModel($: EngineInterface, model: string): Promise<void> {
  const shown = displayModel(model)
  await update($, snapshotAtom, snapshot => (snapshot ? { ...snapshot, model: shown } : snapshot))
}

async function applyEffort($: EngineInterface, effort: string | number | null): Promise<void> {
  try {
    await update($, snapshotAtom, snapshot =>
      snapshot && snapshot.effort !== effort ? { ...snapshot, effort } : snapshot,
    )
  } catch {
    // never hold up the model request: keep the previous effort
  }
}

function requestRefresh($: EngineInterface, settings: Settings, pass: Pass): Promise<void> {
  const gate = gates[pass]
  if (gate.running) {
    gate.isStale = true
    return gate.running
  }
  gate.running = (async () => {
    try {
      do {
        gate.isStale = false
        if (pass === 'vcs') await refreshVcs($, settings)
        else await refresh($, settings)
      } while (gate.isStale)
    } finally {
      gate.running = null
    }
  })()
  return gate.running
}

/** The git dir's files worth watching, absolute; none outside a git repo. */
async function gitWatchPaths($: EngineInterface, cwd: string): Promise<string[]> {
  try {
    const gitDir = await runner($, cwd)(['git', 'rev-parse', '--absolute-git-dir'])
    return gitDir ? GIT_WATCH_FILES.map(file => `${gitDir}/${file}`) : []
  } catch {
    return []
  }
}

export const register: Register = (on, options) => {
  const { thresholds, warning } = resolveThresholds(options)
  const settings: Settings = { thresholds, showVcs: options.showVcs !== false }
  let hasWarned = false

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if (warning && !hasWarned) {
      hasWarned = true
      $.ui.log(warning)
    }
    await $.command.register({ name: 'context-watch', description: 'Show or hide the context meter band' })
    const stored = await $.store.get(STORE_HIDDEN).catch(() => undefined)
    await update($, isHiddenAtom, () => stored === true)
    await requestRefresh($, settings, 'snapshot')
    return result
  })

  // Usage as the engine measures it, pushed after each main-thread turn.
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (e.changed.includes('context')) await applyUsage($, e.context)
    return result
  })

  // Mid-turn, each tool call follows a response, so usage has moved; git may have too.
  // Usage is one engine read, so it is awaited; git is not, so the tool result isn't held back.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    await refreshUsage($)
    if ((VCS_TOOLS as readonly string[]).includes(e.tool)) void requestRefresh($, settings, 'vcs')
    return result
  }).catch(($, e, next) => next(e))

  // Effort as each main-loop request sends it (after the model's downgrade): /effort, /model, a fallback.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) await applyEffort($, e.effort ?? null)
    return yield* next(e)
  })

  // A safety net for git changes made outside the session where no watch is set.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await requestRefresh($, settings, 'vcs')
    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    await refreshUsage($)
    return result
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    const result = await next(e)
    if (e.reason === 'clear') {
      await update($, snapshotAtom, snapshot => (snapshot ? { ...snapshot, tokens: 0, percent: 0 } : snapshot))
    }
    return result
  })

  // /model, the picker, fast mode or a fallback: show the new model now, not after the next turn.
  on('classic.PostModelSwitch', async ($, e, next) => {
    const result = await next(e)
    await applyModel($, e.to_model)
    await refreshUsage($)
    return result
  }).catch(($, e, next) => next(e))

  // Have the engine watch git's HEAD and index, so a checkout or commit in another terminal shows.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if (!settings.showVcs) return result
    watchedPaths = await gitWatchPaths($, e.cwd)
    if (watchedPaths.length === 0) return result
    return { ...result, watchPaths: [...(result.watchPaths ?? []), ...watchedPaths] }
  }).catch(($, e, next) => next(e))

  on('classic.FileChanged', async ($, e, next) => {
    const result = await next(e)
    if (watchedPaths.includes(e.file_path)) await requestRefresh($, settings, 'vcs')
    return result
  }).catch(($, e, next) => next(e))

  // Entering or leaving a worktree moves the session to another checkout.
  on('classic.CwdChanged', async ($, e, next) => {
    const result = await next(e)
    await requestRefresh($, settings, 'vcs')
    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'context-watch' }, async $ => {
    const isHidden = !(await read($, isHiddenAtom))
    await update($, isHiddenAtom, () => isHidden)
    await $.store.set(STORE_HIDDEN, isHidden)
    return { text: isHidden ? 'ContextWatch hidden.' : 'ContextWatch shown.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const snapshot = await read($, snapshotAtom)
    const isHidden = await read($, isHiddenAtom)
    if (snapshot === null || isHidden) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const segments = fitSegments(snapshot, e.props.bodyColumns, settings)

    return (
      <Box>
        <Text wrap="truncate-end">
          {segments.map(segment => (
            <Text color={segment.color} dimColor={segment.dim}>
              {segment.text}
            </Text>
          ))}
        </Text>
      </Box>
    )
  })
}
