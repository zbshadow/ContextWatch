import type { LineChanges, VcsState } from '../types'

/** Runs a command by argv and resolves its trimmed stdout; rejects on failure (non-zero exit, timeout, not found). */
export type Run = (argv: readonly string[]) => Promise<string>

/** Resolves whether a path exists. */
export type Exists = (path: string) => Promise<boolean>

type Provider = {
  key: string
  marker: string
  detect: (run: Run) => Promise<VcsState | null>
}

const KNOWN_PLATFORMS: Record<string, string> = {
  'github.com': 'GitHub',
  'bitbucket.org': 'Bitbucket',
  'gitlab.com': 'GitLab',
}

export function parseRemoteUrl(url: string): { platform: string | null; repo: string | null } {
  let host: string | null = null
  let repo: string | null = null

  const sshMatch = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/)
  if (sshMatch?.[1] && sshMatch[2]) {
    host = sshMatch[1]
    repo = sshMatch[2].split('/').pop() || null
  } else {
    try {
      const u = new URL(url)
      host = u.hostname || null
      const segments = u.pathname.replace(/^\//, '').replace(/\.git$/, '').split('/')
      repo = segments.pop() || null
    } catch {
      // unparseable remote URL
    }
  }

  const platform = host ? (KNOWN_PLATFORMS[host] ?? host) : null
  return { platform, repo }
}

export function parseTfvcPlatform(url: string | null): string {
  if (!url) return 'TFS'
  try {
    const u = new URL(url.trim())
    const host = u.hostname.toLowerCase()
    if (host === 'dev.azure.com') {
      return u.pathname.split('/').filter(Boolean)[0] || 'Azure DevOps'
    }
    if (host.endsWith('.visualstudio.com')) {
      return host.split('.')[0] || host
    }
    return host
  } catch {
    return 'TFS'
  }
}

async function attempt(run: Run, argv: readonly string[]): Promise<string | null> {
  try {
    return await run(argv)
  } catch {
    return null
  }
}

/**
 * Sums `git diff --numstat` output; binary files (`-\t-`) count no lines.
 * Null when nothing was added or removed, so the band shows no counts.
 */
export function parseNumstat(numstat: string): LineChanges | null {
  let added = 0
  let removed = 0
  for (const row of numstat.split('\n')) {
    const [plus, minus] = row.split('\t')
    const a = Number(plus)
    const r = Number(minus)
    if (Number.isInteger(a)) added += a
    if (Number.isInteger(r)) removed += r
  }
  return added || removed ? { added, removed } : null
}

export async function detectGit(run: Run): Promise<VcsState | null> {
  const branch = await attempt(run, ['git', 'branch', '--show-current'])
  if (branch === null) return null

  const remote = await attempt(run, ['git', 'remote', 'get-url', 'origin'])
  const { platform, repo } = remote === null ? { platform: null, repo: null } : parseRemoteUrl(remote)

  const status = await attempt(run, ['git', 'status', '--porcelain'])
  const dirty = status !== null && status.length > 0

  // Staged and unstaged lines against HEAD; untracked files count none, as in `git diff`.
  // A clean tree has none to count, and a repo with no commit yet has no HEAD to diff.
  const numstat = dirty ? await attempt(run, ['git', 'diff', '--numstat', 'HEAD']) : null
  const lines = numstat === null ? null : parseNumstat(numstat)
  const changes = lines ? { changes: lines } : {}

  if (!branch) {
    const hash = (await attempt(run, ['git', 'rev-parse', '--short', 'HEAD'])) || 'HEAD'
    return { type: 'detached', platform, repo, hash, dirty, ...changes }
  }
  return { type: 'branch', platform, repo, branch, dirty, ...changes }
}

export async function detectTfvc(run: Run): Promise<VcsState | null> {
  const workfold = await attempt(run, ['tf', 'workfold', '/noprompt'])
  if (workfold === null) return null

  const workspaceName = workfold.match(/Workspace\s*:\s*(\S+)/i)?.[1] ?? null
  const collectionUrl = workfold.match(/Collection\s*:\s*(\S+)/i)?.[1] ?? null
  const serverPath = workfold.match(/\$\/\S+/)?.[0] ?? null

  if (!workspaceName && !serverPath) return null

  const platform = parseTfvcPlatform(collectionUrl)

  let repo: string | null = null
  let branch: string | null = null
  if (serverPath) {
    const parts = serverPath.replace(/^\$\//, '').split('/')
    repo = parts[0] || null
    branch = parts.slice(1).join('/') || null
  }

  const status = await attempt(run, ['tf', 'status', '/noprompt', '/recursive'])
  const dirty = status !== null && status.length > 0 && !/no pending changes/i.test(status)

  return { type: 'tfvc', platform, repo: repo || workspaceName, branch, dirty }
}

const VCS_PROVIDERS: readonly Provider[] = [
  { key: 'git', marker: '.git', detect: detectGit },
  { key: 'tfvc', marker: '$tf', detect: detectTfvc },
]

function separatorOf(path: string): string {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/'
}

function join(dir: string, name: string): string {
  const sep = separatorOf(dir)
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`
}

function dirname(path: string): string {
  const sep = separatorOf(path)
  const trimmed = path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path
  const cut = trimmed.lastIndexOf(sep)
  if (cut < 0) return trimmed
  if (cut === 0) return sep
  const parent = trimmed.slice(0, cut)
  // keep a drive root (`C:`) as `C:\`
  return /^[A-Za-z]:$/.test(parent) ? `${parent}${sep}` : parent
}

async function walkUp(cwd: string, name: string, exists: Exists): Promise<boolean> {
  let dir = cwd
  while (true) {
    if (await exists(join(dir, name)).catch(() => false)) return true
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

/**
 * Providers whose marker is found walking up from `cwd` are tried first, then
 * the rest; the first non-null state wins, else `{ type: 'none' }`.
 */
export async function detectVcs(run: Run, cwd: string, exists: Exists): Promise<VcsState> {
  const marked = await Promise.all(VCS_PROVIDERS.map(p => walkUp(cwd, p.marker, exists)))
  const hasMarker = new Set(VCS_PROVIDERS.filter((_, i) => marked[i]).map(p => p.key))
  const ordered = [
    ...VCS_PROVIDERS.filter(p => hasMarker.has(p.key)),
    ...VCS_PROVIDERS.filter(p => !hasMarker.has(p.key)),
  ]

  for (const provider of ordered) {
    const state = await provider.detect(run)
    if (state) return state
  }

  return { type: 'none' }
}
