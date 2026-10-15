import type { Snapshot, VcsState, Zone } from '../types'

export type Thresholds = { yellowAt: number; redAbove: number }

export const DEFAULT_THRESHOLDS: Thresholds = { yellowAt: 70_000, redAbove: 100_000 }

export type SegmentColor = 'success' | 'warning' | 'error' | 'cyan'

export type Segment = {
  text: string
  color?: SegmentColor
  dim?: boolean
  bold?: boolean
  /** Swaps foreground and background: a colored badge. */
  inverse?: boolean
  /** What the segment is, so the band can drop the hint first when short of room. */
  part: 'model' | 'effort' | 'label' | 'usage' | 'hint' | 'vcs' | 'added' | 'removed' | 'separator'
}

export type BuildOptions = {
  thresholds?: Thresholds
  showVcs?: boolean
  showHint?: boolean
}

const ZONE_COLOR: Record<Zone, SegmentColor> = {
  green: 'success',
  yellow: 'warning',
  red: 'error',
}

const SEPARATOR: Segment = { text: ' · ', dim: true, part: 'separator' }
/** The red-zone hint as a red badge, so it reads as a warning rather than a footnote. */
export const HINT: Segment = { text: ' Consider /compact or /clear ', color: 'error', bold: true, inverse: true, part: 'hint' }

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${Math.round(count / 1_000_000)}M`
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`
  return String(count)
}

export function classify(count: number, thresholds: Thresholds = DEFAULT_THRESHOLDS): Zone {
  if (count < thresholds.yellowAt) return 'green'
  if (count <= thresholds.redAbove) return 'yellow'
  return 'red'
}

/**
 * Reads the thresholds from the mod's options; falls back to the defaults
 * (with a warning to log) when they are missing, not numbers, or out of order.
 */
export function resolveThresholds(options: { readonly [key: string]: unknown }): {
  thresholds: Thresholds
  warning: string | null
} {
  const yellowAt = options.yellowAt ?? DEFAULT_THRESHOLDS.yellowAt
  const redAbove = options.redAbove ?? DEFAULT_THRESHOLDS.redAbove
  const isValid =
    typeof yellowAt === 'number' &&
    typeof redAbove === 'number' &&
    Number.isFinite(yellowAt) &&
    Number.isFinite(redAbove) &&
    yellowAt >= 0 &&
    yellowAt < redAbove
  if (isValid) return { thresholds: { yellowAt, redAbove }, warning: null }
  return {
    thresholds: DEFAULT_THRESHOLDS,
    warning: `context-watch: yellowAt (${String(yellowAt)}) must be a number below redAbove (${String(redAbove)}); using ${DEFAULT_THRESHOLDS.yellowAt} and ${DEFAULT_THRESHOLDS.redAbove}`,
  }
}

const FAMILY_NAMES: Record<string, string> = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  fable: 'Fable',
}

/**
 * Turns a model ID (`claude-sonnet-4-6`, `claude-opus-4-1-20250805`,
 * `claude-opus-4-6[1m]`) into the status line's display style (`Sonnet 4.6`).
 * Anything else, a display name included, comes back as given; empty is null.
 */
export function displayModel(model: string | null | undefined): string | null {
  const raw = model?.trim()
  if (!raw) return null
  const match = raw.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i)
  const family = match?.[1] ? FAMILY_NAMES[match[1].toLowerCase()] : undefined
  if (!match || !family) return raw
  const version = match[3] ? `${match[2]}.${match[3]}` : match[2]
  return `${family} ${version}${match[4] ? ' (1M context)' : ''}`
}

/** A level (`high`) as given; a thinking budget in tokens as `32k`. */
export function formatEffort(effort: string | number): string {
  return typeof effort === 'number' ? formatTokens(effort) : effort
}

export function formatVcs(vcs: VcsState): Segment {
  if (vcs.type === 'none') return { text: '[No version control]', dim: true, part: 'vcs' }

  const star = vcs.dirty ? '*' : ''
  const style = vcs.dirty ? { color: 'cyan' as const } : { dim: true }

  if (vcs.type === 'detached') {
    const bracketParts = [vcs.platform, vcs.repo].filter(Boolean)
    const bracket = bracketParts.length ? `[${bracketParts.join('/')}] ` : ''
    return { text: `${bracket}(HEAD detached at ${vcs.hash})${star}`, ...style, part: 'vcs' }
  }

  if (vcs.type === 'branch' || vcs.type === 'tfvc') {
    const parts = [vcs.platform, vcs.repo, vcs.branch].filter(Boolean)
    return { text: `[${parts.join('/')}${star}]`, ...style, part: 'vcs' }
  }

  return { text: '[Unknown VCS]', dim: true, part: 'vcs' }
}

/** The diff counts after the branch, git's colors: `+N` green, `-N` red. None without changes. */
export function formatChanges(vcs: VcsState): Segment[] {
  if ((vcs.type !== 'branch' && vcs.type !== 'detached') || !vcs.changes) return []
  const { added, removed } = vcs.changes
  return [
    { text: ' ', part: 'separator' },
    { text: `+${added}`, color: 'success', part: 'added' },
    { text: ' ', part: 'separator' },
    { text: `-${removed}`, color: 'error', part: 'removed' },
  ]
}

export function buildSegments(snapshot: Snapshot, options: BuildOptions = {}): Segment[] {
  const { thresholds = DEFAULT_THRESHOLDS, showVcs = true, showHint = true } = options
  const zone = classify(snapshot.tokens, thresholds)
  const segments: Segment[] = []

  if (snapshot.model) segments.push({ text: snapshot.model, dim: true, part: 'model' }, SEPARATOR)
  if (snapshot.effort !== null) {
    segments.push({ text: `Effort: ${formatEffort(snapshot.effort)}`, dim: true, part: 'effort' }, SEPARATOR)
  }
  segments.push(
    { text: 'Context: ', dim: true, part: 'label' },
    {
      text: `${formatTokens(snapshot.tokens)} (${Math.round(snapshot.percent)}%)`,
      color: ZONE_COLOR[zone],
      part: 'usage',
    },
  )
  if (zone === 'red' && showHint) {
    segments.push(SEPARATOR, HINT)
  }
  if (showVcs) segments.push(SEPARATOR, formatVcs(snapshot.vcs), ...formatChanges(snapshot.vcs))

  return segments
}

export function segmentsWidth(segments: readonly Segment[]): number {
  return segments.reduce((sum, segment) => sum + segment.text.length, 0)
}

/**
 * The segments for a band `columns` wide: the whole line when it fits, else
 * without the /compact hint; whatever still overflows is truncated by the band.
 */
export function fitSegments(snapshot: Snapshot, columns: number, options: BuildOptions = {}): Segment[] {
  const full = buildSegments(snapshot, options)
  if (segmentsWidth(full) <= columns) return full
  return buildSegments(snapshot, { ...options, showHint: false })
}
