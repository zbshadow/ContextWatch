import { describe, expect, test } from 'claude-code/testing'

import { buildSegments, classify, displayModel, fitSegments, formatTokens, formatVcs, resolveThresholds, segmentsWidth } from '../hooks/meter'
import type { Segment } from '../hooks/meter'
import type { Snapshot, VcsState } from '../types'

const NO_VCS: VcsState = { type: 'none' }
const CLEAN_BRANCH: VcsState = { type: 'branch', platform: 'GitHub', repo: 'Raven', branch: 'main', dirty: false }
const DIRTY_BRANCH: VcsState = { type: 'branch', platform: 'GitHub', repo: 'Raven', branch: 'main', dirty: true }
const CHANGED_BRANCH: VcsState = { ...DIRTY_BRANCH, changes: { added: 12, removed: 7 } }

const snap = (
  tokens: number,
  percent: number,
  vcs: VcsState = NO_VCS,
  model: string | null = null,
  effort: string | number | null = null,
): Snapshot => ({
  model,
  effort,
  tokens,
  percent,
  vcs,
})
const line = (segments: readonly Segment[]) => segments.map(s => s.text).join('')
const part = (segments: readonly Segment[], name: Segment['part']) => segments.find(s => s.part === name)

describe('formatTokens', () => {
  test('0', () => expect(formatTokens(0)).toBe('0'))
  test('sub-thousand', () => expect(formatTokens(999)).toBe('999'))
  test('exactly 1000', () => expect(formatTokens(1000)).toBe('1k'))
  test('rounds down at 1499', () => expect(formatTokens(1499)).toBe('1k'))
  test('rounds up at 1500', () => expect(formatTokens(1500)).toBe('2k'))
  test('mid-thousands', () => expect(formatTokens(24300)).toBe('24k'))
  test('exactly 1M', () => expect(formatTokens(1_000_000)).toBe('1M'))
  test('mid-millions rounds down', () => expect(formatTokens(1_200_000)).toBe('1M'))
})

describe('classify', () => {
  test('0 is green', () => expect(classify(0)).toBe('green'))
  test('69999 is green', () => expect(classify(69_999)).toBe('green'))
  test('70000 is yellow', () => expect(classify(70_000)).toBe('yellow'))
  test('100000 is yellow', () => expect(classify(100_000)).toBe('yellow'))
  test('100001 is red', () => expect(classify(100_001)).toBe('red'))
  test('custom thresholds', () => {
    const t = { yellowAt: 500_000, redAbove: 800_000 }
    expect(classify(499_999, t)).toBe('green')
    expect(classify(500_000, t)).toBe('yellow')
    expect(classify(800_000, t)).toBe('yellow')
    expect(classify(800_001, t)).toBe('red')
  })
})

describe('resolveThresholds', () => {
  test('defaults when unset', () => {
    expect(resolveThresholds({})).toEqual({ thresholds: { yellowAt: 70_000, redAbove: 100_000 }, warning: null })
  })
  test('uses valid config', () => {
    expect(resolveThresholds({ yellowAt: 1000, redAbove: 2000 }).thresholds).toEqual({ yellowAt: 1000, redAbove: 2000 })
  })
  test('yellowAt >= redAbove falls back with a warning', () => {
    const resolved = resolveThresholds({ yellowAt: 2000, redAbove: 2000 })
    expect(resolved.thresholds).toEqual({ yellowAt: 70_000, redAbove: 100_000 })
    expect(resolved.warning).toContain('yellowAt')
  })
  test('non-number falls back with a warning', () => {
    const resolved = resolveThresholds({ yellowAt: 'lots', redAbove: 2000 })
    expect(resolved.thresholds.yellowAt).toBe(70_000)
    expect(resolved.warning).toBeTruthy()
  })
})

describe('displayModel', () => {
  test('model ID becomes display name', () => expect(displayModel('claude-sonnet-4-6')).toBe('Sonnet 4.6'))
  test('dated ID drops the date', () => expect(displayModel('claude-opus-4-1-20250805')).toBe('Opus 4.1'))
  test('single-number version', () => expect(displayModel('claude-opus-5')).toBe('Opus 5'))
  test('1M context suffix', () => expect(displayModel('claude-opus-4-6[1m]')).toBe('Opus 4.6 (1M context)'))
  test('display name passes through', () => expect(displayModel('Sonnet 4.6')).toBe('Sonnet 4.6'))
  test('unknown ID passes through', () => expect(displayModel('gpt-like-model')).toBe('gpt-like-model'))
  test('empty is null', () => {
    expect(displayModel('')).toBeNull()
    expect(displayModel(null)).toBeNull()
  })
})

describe('formatVcs', () => {
  test('clean branch is dim, no asterisk', () => {
    expect(formatVcs(CLEAN_BRANCH)).toEqual({ text: '[GitHub/Raven/main]', dim: true, part: 'vcs' })
  })
  test('dirty branch is cyan with asterisk inside brackets', () => {
    const segment = formatVcs(DIRTY_BRANCH)
    expect(segment.text).toBe('[GitHub/Raven/main*]')
    expect(segment.color).toBe('cyan')
    expect(segment.dim).toBeUndefined()
  })
  test('clean branch with no platform', () => {
    expect(formatVcs({ ...CLEAN_BRANCH, platform: null }).text).toBe('[Raven/main]')
  })
  test('clean branch with no remote shows branch only', () => {
    expect(formatVcs({ ...CLEAN_BRANCH, platform: null, repo: null }).text).toBe('[main]')
  })
  test('clean detached HEAD is dim, Git Bash format', () => {
    const segment = formatVcs({ type: 'detached', platform: 'GitHub', repo: 'Raven', hash: 'a3f9c12', dirty: false })
    expect(segment).toEqual({ text: '[GitHub/Raven] (HEAD detached at a3f9c12)', dim: true, part: 'vcs' })
  })
  test('dirty detached HEAD is cyan with asterisk after paren', () => {
    const segment = formatVcs({ type: 'detached', platform: 'GitHub', repo: 'Raven', hash: 'a3f9c12', dirty: true })
    expect(segment.text).toBe('[GitHub/Raven] (HEAD detached at a3f9c12)*')
    expect(segment.color).toBe('cyan')
  })
  test('detached HEAD with no remote omits bracket prefix', () => {
    const segment = formatVcs({ type: 'detached', platform: null, repo: null, hash: 'a3f9c12', dirty: false })
    expect(segment.text).toBe('(HEAD detached at a3f9c12)')
  })
  test('no VCS is dim with correct text', () => {
    expect(formatVcs(NO_VCS)).toEqual({ text: '[No version control]', dim: true, part: 'vcs' })
  })
  test('unknown type', () => {
    expect(formatVcs({ type: 'svn' } as unknown as VcsState).text).toBe('[Unknown VCS]')
  })
  test('clean TFVC is dim, no asterisk', () => {
    const segment = formatVcs({ type: 'tfvc', platform: 'Azure DevOps', repo: 'MyProject', branch: 'Main', dirty: false })
    expect(segment).toEqual({ text: '[Azure DevOps/MyProject/Main]', dim: true, part: 'vcs' })
  })
  test('dirty TFVC is cyan with asterisk', () => {
    const segment = formatVcs({ type: 'tfvc', platform: 'TFS', repo: 'CorpProject', branch: 'Dev', dirty: true })
    expect(segment.text).toBe('[TFS/CorpProject/Dev*]')
    expect(segment.color).toBe('cyan')
  })
  test('TFVC with no branch shows platform and repo only', () => {
    const segment = formatVcs({ type: 'tfvc', platform: 'TFS', repo: 'MyWorkspace', branch: null, dirty: false })
    expect(segment.text).toBe('[TFS/MyWorkspace]')
  })
})

describe('buildSegments', () => {
  test('separator dot is present before the VCS segment for every state', () => {
    for (const vcs of [NO_VCS, CLEAN_BRANCH, DIRTY_BRANCH]) {
      const segments = buildSegments(snap(0, 0, vcs))
      const index = segments.findIndex(s => s.part === 'vcs')
      expect(segments[index - 1]).toEqual({ text: ' · ', dim: true, part: 'separator' })
    }
  })
  test('line changes follow the branch: + green, - red', () => {
    const segments = buildSegments(snap(24300, 18, CHANGED_BRANCH))
    expect(line(segments)).toEndWith('[GitHub/Raven/main*] +12 -7')
    expect(part(segments, 'added')).toEqual({ text: '+12', color: 'success', part: 'added' })
    expect(part(segments, 'removed')).toEqual({ text: '-7', color: 'error', part: 'removed' })
  })
  test('no line changes, no counts', () => {
    for (const vcs of [CLEAN_BRANCH, DIRTY_BRANCH, NO_VCS]) {
      expect(part(buildSegments(snap(0, 0, vcs)), 'added')).toBeUndefined()
    }
  })
  test('showVcs off hides the counts too', () => {
    expect(part(buildSegments(snap(0, 0, CHANGED_BRANCH), { showVcs: false }), 'added')).toBeUndefined()
  })
  test('Context label is dim in all zones', () => {
    for (const tokens of [0, 85_000, 112_000]) {
      expect(part(buildSegments(snap(tokens, 10)), 'label')).toEqual({ text: 'Context: ', dim: true, part: 'label' })
    }
  })
  test('model name appears first, dim, followed by a separator', () => {
    const segments = buildSegments(snap(24300, 18, NO_VCS, 'Sonnet 4.6'))
    expect(segments[0]).toEqual({ text: 'Sonnet 4.6', dim: true, part: 'model' })
    expect(line(segments)).toStartWith('Sonnet 4.6 · Context: ')
  })
  test('effort sits between model and context, dim', () => {
    const segments = buildSegments(snap(24300, 18, NO_VCS, 'Opus 5.5', 'high'))
    expect(part(segments, 'effort')).toEqual({ text: 'Effort: high', dim: true, part: 'effort' })
    expect(line(segments)).toStartWith('Opus 5.5 · Effort: high · Context: ')
  })

  test('a numeric effort is a thinking budget in tokens', () => {
    expect(part(buildSegments(snap(0, 0, NO_VCS, null, 32_000)), 'effort')?.text).toBe('Effort: 32k')
  })

  test('no effort omits the effort segment and dot', () => {
    expect(line(buildSegments(snap(24300, 18, NO_VCS, 'Opus 5.5')))).toStartWith('Opus 5.5 · Context: ')
  })

  test('no model omits model segment and dot', () => {
    const text = line(buildSegments(snap(24300, 18)))
    expect(text).toStartWith('Context: ')
    expect(text).not.toContain('null')
  })
  test('green zone numbers are success', () => {
    expect(part(buildSegments(snap(24300, 18)), 'usage')).toEqual({ text: '24k (18%)', color: 'success', part: 'usage' })
  })
  test('yellow zone numbers are warning', () => {
    expect(part(buildSegments(snap(85_000, 43)), 'usage')).toEqual({ text: '85k (43%)', color: 'warning', part: 'usage' })
  })
  test('red zone numbers are error', () => {
    expect(part(buildSegments(snap(112_000, 56)), 'usage')).toEqual({ text: '112k (56%)', color: 'error', part: 'usage' })
  })
  test('red zone suggestion is a bold red badge', () => {
    expect(part(buildSegments(snap(112_000, 56)), 'hint')).toEqual({
      text: ' Consider /compact or /clear ',
      color: 'error',
      bold: true,
      inverse: true,
      part: 'hint',
    })
  })
  test('no suggestion in green', () => expect(line(buildSegments(snap(24300, 18)))).not.toContain('Consider'))
  test('no suggestion in yellow', () => expect(line(buildSegments(snap(85_000, 43)))).not.toContain('Consider'))
  test('percentage rounds', () => expect(line(buildSegments(snap(24300, 18.3)))).toContain('(18%)'))
  test('no ANSI escapes anywhere', () => {
    for (const tokens of [0, 85_000, 112_000]) expect(line(buildSegments(snap(tokens, 10, DIRTY_BRANCH, 'Opus 4.6')))).not.toContain('\x1b')
  })
  test('clean branch segment is dim', () => {
    const vcs = part(buildSegments(snap(24300, 18, CLEAN_BRANCH)), 'vcs')
    expect(vcs?.text).toBe('[GitHub/Raven/main]')
    expect(vcs?.color).toBeUndefined()
  })
  test('dirty branch segment is cyan with asterisk', () => {
    expect(part(buildSegments(snap(24300, 18, DIRTY_BRANCH)), 'vcs')).toMatchObject({ text: '[GitHub/Raven/main*]', color: 'cyan' })
  })
  test('VCS segment after numbers in green zone', () => {
    const text = line(buildSegments(snap(24300, 18, DIRTY_BRANCH)))
    expect(text.indexOf('24k')).toBeLessThan(text.indexOf('[GitHub/Raven/main*]'))
  })
  test('VCS segment after suggestion in red zone', () => {
    const text = line(buildSegments(snap(112_000, 56, DIRTY_BRANCH)))
    expect(text.indexOf('Consider')).toBeLessThan(text.indexOf('[GitHub/Raven/main*]'))
  })
  test('no VCS state shows no version control', () => {
    expect(line(buildSegments(snap(24300, 18)))).toContain('[No version control]')
  })
  test('full line', () => {
    expect(line(buildSegments(snap(24300, 18.3, { ...CLEAN_BRANCH, repo: 'my-project' }, 'Sonnet 4.6')))).toBe(
      'Sonnet 4.6 · Context: 24k (18%) · [GitHub/my-project/main]',
    )
  })
  test('showVcs false leaves out the VCS segment and its dot', () => {
    expect(line(buildSegments(snap(24300, 18, CLEAN_BRANCH), { showVcs: false }))).toBe('Context: 24k (18%)')
  })
  test('custom thresholds move the zone', () => {
    const segments = buildSegments(snap(85_000, 43), { thresholds: { yellowAt: 200_000, redAbove: 400_000 } })
    expect(part(segments, 'usage')?.color).toBe('success')
  })
})

describe('fitSegments', () => {
  const red = snap(112_000, 56, DIRTY_BRANCH, 'Opus 4.6')
  test('keeps everything when it fits', () => {
    expect(fitSegments(red, 200)).toEqual(buildSegments(red))
  })
  test('drops the compact hint before the VCS segment', () => {
    const width = segmentsWidth(buildSegments(red)) - 1
    const fitted = fitSegments(red, width)
    expect(part(fitted, 'hint')).toBeUndefined()
    expect(part(fitted, 'vcs')?.text).toBe('[GitHub/Raven/main*]')
  })
})
