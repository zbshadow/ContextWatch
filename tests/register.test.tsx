import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const PLUGIN = 'context-watch'
const ENGINE = 'ENGINE'
const SURFACES = ['terminal', 'desktop'] as const

type World = {
  tokens: number
  percent: number
  model: string
  branch: string | Error
  remote: string | Error
  status: string
  numstat: string | Error
  gitDir: string | Error
  markers: readonly string[]
  isUsageBroken: boolean
  runs: string[]
  runInits: unknown[]
  logs: string[]
  toasts: string[]
  compacts: number
  compactSkip: string | null
  isCompactBroken: boolean
  store: Record<string, unknown>
}

/** The world beneath the mod: usage, model, cwd, the file system's markers and the commands it runs. */
function world(on: On, store: Record<string, unknown> = {}, init: Partial<World> = {}): World {
  const w: World = {
    tokens: 24_300,
    percent: 18.3,
    model: 'claude-sonnet-4-6',
    branch: 'main\n',
    remote: 'https://github.com/zbshadow/my-project.git\n',
    status: '',
    numstat: '',
    gitDir: '/repo/.git\n',
    markers: ['/repo/.git'],
    isUsageBroken: false,
    runs: [],
    runInits: [],
    logs: [],
    toasts: [],
    compacts: 0,
    compactSkip: null,
    isCompactBroken: false,
    store: { ...store },
    ...init,
  }
  on('store.get', (_$, e) => ({ value: w.store[e.key] }))
  on('store.set', (_$, e) => {
    w.store[e.key] = e.value
    return { value: undefined }
  })
  on('session.usage', () => {
    if (w.isUsageBroken) throw new Error('usage unavailable')
    return {
      value: {
        startedAt: 0,
        context: { tokens: w.tokens, window: 200_000, percent: w.percent },
        rateLimits: [],
      },
    }
  })
  on('session.model', () => ({ value: w.model }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', (_$, e) => ({ value: w.markers.includes(e.path) }))
  on('process.run', (_$, e) => {
    const cmd = e.argv.join(' ')
    w.runs.push(cmd)
    w.runInits.push(e.init)
    const answer = (out: string | Error) => {
      if (out instanceof Error) {
        return { value: { exitCode: 128, stdout: '', stderr: out.message, isStdoutTruncated: false, isStderrTruncated: false } }
      }
      return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (cmd === 'git branch --show-current') return answer(w.branch)
    if (cmd === 'git remote get-url origin') return answer(w.remote)
    if (cmd === 'git status --porcelain') return answer(w.status)
    if (cmd === 'git diff --numstat HEAD') return answer(w.numstat)
    if (cmd === 'git rev-parse --short HEAD') return answer('a3f9c12\n')
    if (cmd === 'git rev-parse --absolute-git-dir') return answer(w.gitDir)
    return answer(new Error(`${e.argv[0]}: not found`))
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.log', (_$, e) => {
    w.logs.push(String(e.text))
    return { value: undefined }
  })
  // What the engine would draw in the band when the mod passes: a marker to tell it apart.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{ENGINE}</Text>
  })
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  const conversation = [{ role: 'user' as const, text: 'hello', toolUses: [] }]
  on('session.messages', () => ({ value: conversation }))
  // /compact: the engine compacts down to a few thousand tokens.
  on('session.compact', () => {
    if (w.isCompactBroken) throw new Error('a turn is running')
    if (w.compactSkip !== null) return { skip: w.compactSkip }
    w.compacts += 1
    w.tokens = 5_000
    w.percent = 2.5
    return { messages: [{ role: 'assistant' as const, text: 'summary', toolUses: [] }] }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.measure', (_$, e) => ({ changed: [...e.changed] }))
  on('classic.SessionStart', () => ({}))
  on('classic.PostModelSwitch', () => ({}))
  on('classic.FileChanged', () => ({}))
  on('classic.CwdChanged', () => ({}))
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never)
  on('command.run', () => ({ text: 'core' }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  return w
}

const start = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

const completeTurn = ($: Engine) =>
  $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

const measure = ($: Engine, tokens: number, percent: number) =>
  $.session.measure({ context: { tokens, window: 200_000, percent }, rateLimits: [], changed: ['context'] })

const callTool = ($: Engine, tool: 'Bash' | 'Read') =>
  tool === 'Bash'
    ? $.tool.call({ tool: 'Bash', id: 'tu1', command: 'git checkout -b x' } as never)
    : $.tool.call({ tool: 'Read', id: 'tu2', file_path: '/repo/a.ts' } as never)

const step = async ($: Engine, effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number | undefined, agentId?: string) => {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort, messageCount: 1, agentId })
  for await (const _chunk of stream);
  return stream.result
}

const switchModel = ($: Engine, to: string) =>
  $.classic.PostModelSwitch({
    from_model: 'claude-sonnet-4-6',
    to_model: to,
    requested_model: null,
    source: 'command',
    context_tokens: 0,
    prompt_cache_warm: false,
    cache_ttl: '5m',
    estimated_cache_write_usd: 0,
    pricing: 'default',
  })

const runCommand = ($: Engine) =>
  $.command.run({
    command: PLUGIN,
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

const bandProps = (bodyColumns = 120, hasSurvey = false, isWorking = false) => ({
  hasSurvey,
  isWorking,
  maxRows: 10,
  bodyColumns,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
})

async function bandText($: Engine, surface: (typeof SURFACES)[number], bodyColumns = 120, hasSurvey = false) {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: bandProps(bodyColumns, hasSurvey) })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  return texts
}

/** The band's whole line: the outer Text's shown text, or undefined when the mod left the band to the engine. */
async function bandLine($: Engine, surface: (typeof SURFACES)[number], bodyColumns = 120, hasSurvey = false) {
  const texts = await bandText($, surface, bodyColumns, hasSurvey)
  const line = texts[0]?.text
  return line === ENGINE ? undefined : line
}

describe('band', () => {
  test('draws model, usage and VCS on every surface after session.start', async ($, on) => {
    world(on)
    await start($)
    for (const surface of SURFACES) {
      expect(await bandLine($, surface)).toBe('Sonnet 4.6 · Context: 24k (18%) · [GitHub/my-project/main]')
    }
  })

  test('usage is colored by zone and the VCS segment by dirtiness', async ($, on) => {
    world(on, {}, { tokens: 112_000, percent: 56, status: ' M a.ts\n' })
    await start($)
    for (const surface of SURFACES) {
      const texts = await bandText($, surface)
      expect(texts.find(t => t.text === '112k (56%)')?.props.color).toBe('error')
      const hint = texts.find(t => t.text === ' Consider /compact or /clear ')
      expect(hint?.props).toMatchObject({ color: 'error', bold: true, inverse: true })
      expect(texts.find(t => t.text === '[GitHub/my-project/main*]')?.props.color).toBe('cyan')
    }
    await measure($, 85_000, 42)
    const texts = await bandText($, 'terminal')
    expect(texts.find(t => t.text.startsWith('85k'))?.props.color).toBe('warning')
  })

  test('line changes follow the branch in green and red', async ($, on) => {
    world(on, {}, { status: ' M a.ts\n', numstat: '12\t3\ta.ts\n' })
    await start($)
    for (const surface of SURFACES) {
      expect(await bandLine($, surface)).toEndWith('[GitHub/my-project/main*] +12 -3')
      const texts = await bandText($, surface)
      expect(texts.find(t => t.text === '+12')?.props.color).toBe('success')
      expect(texts.find(t => t.text === '-3')?.props.color).toBe('error')
    }
  })

  test('draws nothing before the first snapshot', async ($, on) => {
    world(on)
    for (const surface of SURFACES) expect(await bandLine($, surface)).toBeUndefined()
  })

  test('draws nothing while a survey holds the band', async ($, on) => {
    world(on)
    await start($)
    for (const surface of SURFACES) expect(await bandLine($, surface, 120, true)).toBeUndefined()
  })

  test('drops the compact hint first when short of room', async ($, on) => {
    world(on, {}, { tokens: 112_000, percent: 56 })
    await start($)
    for (const surface of SURFACES) {
      const line = await bandLine($, surface, 70)
      expect(line).not.toContain('Consider')
      expect(line).toContain('[GitHub/my-project/main]')
    }
  })

  test('shows no version control outside a repo', async ($, on) => {
    world(on, {}, { branch: new Error('not a git repository'), markers: [] })
    await start($)
    expect(await bandLine($, 'terminal')).toEndWith('[No version control]')
  })

  test('a display-name model passes through', async ($, on) => {
    world(on, {}, { model: 'Opus 4.6' })
    await start($)
    expect(await bandLine($, 'terminal')).toStartWith('Opus 4.6 · Context:')
  })
})

const mountBand = ($: Engine, surface: (typeof SURFACES)[number], isWorking = false) =>
  $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: bandProps(120, false, isWorking) })

describe('red zone', () => {
  test('a Compact button shows in the red zone and compacts on press', async ($, on) => {
    const w = world(on, {}, { tokens: 112_000, percent: 56 })
    await start($)
    const ui = await mountBand($, 'terminal')
    expect(await ui.find({ key: 'compact' })).toBeDefined()
    await ui.press({ key: 'compact' })
    await ui.unmount()
    expect(w.compacts).toBe(1)
    // usage is re-read at once, so the band leaves the red zone
    expect(await bandLine($, 'terminal')).toContain('Context: 5k (3%)')
    const after = await mountBand($, 'terminal')
    expect(await after.find({ key: 'compact' })).toBeUndefined()
    await after.unmount()
  })

  test('the Compact button shows on the desktop too', async ($, on) => {
    world(on, {}, { tokens: 112_000, percent: 56 })
    await start($)
    const ui = await mountBand($, 'desktop')
    expect(await ui.find({ key: 'compact' })).toBeDefined()
    await ui.unmount()
  })

  test('no Compact button outside the red zone or mid-turn', async ($, on) => {
    const w = world(on, {}, { tokens: 112_000, percent: 56 })
    await start($)
    for (const surface of SURFACES) {
      const working = await mountBand($, surface, true)
      expect(await working.find({ key: 'compact' })).toBeUndefined()
      await working.unmount()
    }
    w.tokens = 85_000
    await callTool($, 'Read')
    for (const surface of SURFACES) {
      const ui = await mountBand($, surface)
      expect(await ui.find({ key: 'compact' })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('a refused compaction says why', async ($, on) => {
    const w = world(on, {}, { tokens: 112_000, percent: 56, isCompactBroken: true })
    await start($)
    w.toasts = []
    const ui = await mountBand($, 'terminal')
    await ui.press({ key: 'compact' })
    await ui.unmount()
    expect(w.toasts).toHaveLength(1)
    expect(w.toasts[0]).toStartWith("Couldn't compact: ")
    expect(await bandLine($, 'terminal')).toContain('112k')
  })

  test('a vetoed compaction leaves usage alone', async ($, on) => {
    const w = world(on, {}, { tokens: 112_000, percent: 56, compactSkip: 'blocked by a hook' })
    await start($)
    const ui = await mountBand($, 'terminal')
    await ui.press({ key: 'compact' })
    await ui.unmount()
    expect(w.compacts).toBe(0)
    expect(await bandLine($, 'terminal')).toContain('112k')
  })

  test('entering the red zone toasts once, and leaving it re-arms the toast', async ($, on) => {
    const w = world(on, {}, { tokens: 85_000, percent: 42 })
    await start($)
    expect(w.toasts).toEqual([])
    await measure($, 112_000, 56)
    await measure($, 120_000, 60)
    expect(w.toasts).toEqual(['Context is at 112k (56%): consider /compact or /clear'])
    await measure($, 40_000, 20)
    await measure($, 101_000, 50)
    expect(w.toasts).toHaveLength(2)
  })

  test('a reload in the red zone does not toast again', async ($, on) => {
    const w = world(on, {}, { tokens: 112_000, percent: 56 })
    await start($)
    expect(w.toasts).toHaveLength(1)
    await start($)
    expect(w.toasts).toHaveLength(1)
  })
})

describe('refresh', () => {
  test('session.measure pushes usage without running git', async ($, on) => {
    const w = world(on)
    await start($)
    w.runs = []
    await measure($, 50_000, 25)
    expect(await bandLine($, 'terminal')).toBe('Sonnet 4.6 · Context: 50k (25%) · [GitHub/my-project/main]')
    expect(w.runs).toEqual([])
  })

  test('a measure that moved no context leaves usage alone', async ($, on) => {
    world(on)
    await start($)
    await $.session.measure({ context: { tokens: 1, window: 200_000, percent: 0 }, rateLimits: [], changed: ['cost'] })
    expect(await bandLine($, 'terminal')).toContain('24k (18%)')
  })

  test('any tool call re-reads usage mid-turn; only mutating tools run git', async ($, on) => {
    const w = world(on)
    await start($)
    w.runs = []
    w.tokens = 60_000
    w.percent = 30
    await callTool($, 'Read')
    expect(await bandLine($, 'terminal')).toContain('60k (30%)')
    expect(w.runs).toEqual([])

    w.branch = 'x\n'
    await callTool($, 'Bash')
    expect(await bandLine($, 'terminal')).toEndWith('[GitHub/my-project/x]')
  })

  test('turn.complete picks up VCS changes', async ($, on) => {
    const w = world(on)
    await start($)
    w.branch = 'feature/x\n'
    await completeTurn($)
    expect(await bandLine($, 'terminal')).toEndWith('[GitHub/my-project/feature/x]')
  })

  test('a model switch shows the new model at once', async ($, on) => {
    world(on)
    await start($)
    await switchModel($, 'claude-opus-5-5')
    expect(await bandLine($, 'terminal')).toStartWith('Opus 5.5 · Context:')
  })

  test('a main-loop step shows its effort between model and context', async ($, on) => {
    world(on)
    await start($)
    await step($, 'xhigh')
    for (const surface of SURFACES) {
      expect(await bandLine($, surface)).toStartWith('Sonnet 4.6 · Effort: xhigh · Context:')
    }
    await step($, 'low')
    expect(await bandLine($, 'terminal')).toContain('Effort: low')
  })

  test("a subagent's step leaves the effort alone", async ($, on) => {
    world(on)
    await start($)
    await step($, 'high')
    await step($, 'low', 'agent-1')
    expect(await bandLine($, 'terminal')).toContain('Effort: high')
  })

  test('a model without effort hides the effort segment', async ($, on) => {
    world(on)
    await start($)
    await step($, 'high')
    await step($, undefined)
    expect(await bandLine($, 'terminal')).toStartWith('Sonnet 4.6 · Context:')
  })

  test('a reload keeps the effort already learned', async ($, on) => {
    world(on)
    await start($)
    await step($, 'max')
    await start($)
    expect(await bandLine($, 'terminal')).toContain('Effort: max')
  })

  test('session start asks the engine to watch git HEAD and index', async ($, on) => {
    world(on)
    const result = await $.classic.SessionStart({ source: 'startup' })
    expect(result.watchPaths).toEqual(['/repo/.git/HEAD', '/repo/.git/index'])
  })

  test('outside a repo no watch is asked for', async ($, on) => {
    world(on, {}, { gitDir: new Error('not a git repository') })
    const result = await $.classic.SessionStart({ source: 'startup' })
    expect(result.watchPaths ?? []).toEqual([])
  })

  test('a change to a watched git file refreshes VCS', async ($, on) => {
    const w = world(on)
    await start($)
    await $.classic.SessionStart({ source: 'startup' })
    w.branch = 'elsewhere\n'
    await $.classic.FileChanged({ file_path: '/repo/.git/HEAD', event: 'change' })
    expect(await bandLine($, 'terminal')).toEndWith('[GitHub/my-project/elsewhere]')
  })

  test('a change to an unwatched file runs no git', async ($, on) => {
    const w = world(on)
    await start($)
    await $.classic.SessionStart({ source: 'startup' })
    w.runs = []
    await $.classic.FileChanged({ file_path: '/repo/README.md', event: 'change' })
    expect(w.runs).toEqual([])
  })

  test('a cwd change refreshes VCS', async ($, on) => {
    const w = world(on)
    await start($)
    w.branch = 'worktree-branch\n'
    await $.classic.CwdChanged({ old_cwd: '/repo', new_cwd: '/repo' })
    expect(await bandLine($, 'terminal')).toEndWith('[GitHub/my-project/worktree-branch]')
  })

  test('runs git by argv with a timeout', async ($, on) => {
    const w = world(on)
    await start($)
    expect(w.runs).toContain('git branch --show-current')
    expect(w.runInits[0]).toMatchObject({ cwd: '/repo', timeoutMs: 3000 })
  })

  test('a failed usage read keeps the previous usage', async ($, on) => {
    const w = world(on)
    await start($)
    w.isUsageBroken = true
    await callTool($, 'Read')
    expect(await bandLine($, 'terminal')).toContain('24k (18%)')
  })

  test('/clear resets usage to zero', async ($, on) => {
    world(on)
    await start($)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    expect(await bandLine($, 'terminal')).toContain('Context: 0 (0%)')
  })

  test('hooks hand next(e)’s result back unchanged', async ($, on) => {
    world(on)
    expect(await start($)).toEqual({ cwd: '/repo' })
    expect(await completeTurn($)).toEqual({ text: 'done' })
    expect(await measure($, 1, 0)).toEqual({ changed: ['context'] })
    expect(await $.session.end({ reason: 'other', sessionId: 's1', resume: { id: 's1' } })).toEqual({ sessionId: 's1' })
  })
})

describe('config', () => {
  test('thresholds from options move the zones', { options: { yellowAt: 10_000, redAbove: 20_000 } }, async ($, on) => {
    world(on)
    await start($)
    const texts = await bandText($, 'terminal')
    expect(texts.find(t => t.text === '24k (18%)')?.props.color).toBe('error')
  })

  test('invalid thresholds fall back to defaults and log a warning', { options: { yellowAt: 5, redAbove: 5 } }, async ($, on) => {
    const w = world(on)
    await start($)
    const texts = await bandText($, 'terminal')
    expect(texts.find(t => t.text === '24k (18%)')?.props.color).toBe('success')
    expect(w.logs.join('\n')).toContain('yellowAt')
  })

  test('showVcs false leaves out the VCS segment and runs no git', { options: { showVcs: false } }, async ($, on) => {
    const w = world(on)
    await start($)
    expect(await bandLine($, 'terminal')).toBe('Sonnet 4.6 · Context: 24k (18%)')
    expect(w.runs).toEqual([])
  })
})

describe('/context-watch', () => {
  test('toggles the band and persists the choice', async ($, on) => {
    const w = world(on)
    await start($)
    expect(await runCommand($)).toMatchObject({ text: 'ContextWatch hidden.' })
    expect(w.store.isHidden).toBe(true)
    for (const surface of SURFACES) expect(await bandLine($, surface)).toBeUndefined()
    expect(await runCommand($)).toMatchObject({ text: 'ContextWatch shown.' })
    expect(w.store.isHidden).toBe(false)
    expect(await bandLine($, 'terminal')).toContain('Context:')
  })

  test('a stored hidden choice survives into a new session', async ($, on) => {
    world(on, { isHidden: true })
    await start($)
    expect(await bandLine($, 'terminal')).toBeUndefined()
  })
})
