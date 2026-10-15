import { describe, expect, test } from 'claude-code/testing'

import { detectTfvc, detectVcs, parseNumstat, parseRemoteUrl, parseTfvcPlatform } from '../hooks/vcs'
import type { Exists, Run } from '../hooks/vcs'

/** A Run answering by the command line; an Error (or an unlisted command) rejects, as a failed process does. */
function makeRun(responses: Record<string, string | Error>): Run {
  return async argv => {
    const cmd = argv.join(' ')
    if (!(cmd in responses)) throw new Error(`Unexpected command: ${cmd}`)
    const val = responses[cmd]
    if (val instanceof Error) throw val
    return (val ?? '').trim()
  }
}

const noMarkers: Exists = async () => false
const detect = (run: Run) => detectVcs(run, '/fake', noMarkers)

const CLEAN = { 'git status --porcelain': '' }
const DIRTY = { 'git status --porcelain': ' M context_meter.js\n' }
const GITHUB_HTTPS = { 'git remote get-url origin': 'https://github.com/zbshadow/Raven.git\n' }
const BITBUCKET_SSH = { 'git remote get-url origin': 'git@bitbucket.org:org/Raven.git\n' }
const GITLAB_SSH = { 'git remote get-url origin': 'git@gitlab.com:org/Raven.git\n' }
const NO_REMOTE = { 'git remote get-url origin': new Error('no remote') }

describe('parseRemoteUrl', () => {
  test('GitHub HTTPS', () => expect(parseRemoteUrl('https://github.com/zbshadow/Raven.git')).toEqual({ platform: 'GitHub', repo: 'Raven' }))
  test('Bitbucket SSH', () => expect(parseRemoteUrl('git@bitbucket.org:org/Raven.git')).toEqual({ platform: 'Bitbucket', repo: 'Raven' }))
  test('unparseable', () => expect(parseRemoteUrl('not a url')).toEqual({ platform: null, repo: null }))
})

describe('parseNumstat', () => {
  test('sums added and removed across files', () =>
    expect(parseNumstat('10\t2\ta.ts\n3\t0\tb.ts')).toEqual({ added: 13, removed: 2 }))
  test('binary files count no lines', () => expect(parseNumstat('-\t-\tlogo.png\n1\t1\ta.ts')).toEqual({ added: 1, removed: 1 }))
  test('no lines changed is null', () => expect(parseNumstat('')).toBeNull())
  test('only a binary change is null', () => expect(parseNumstat('-\t-\tlogo.png')).toBeNull())
})

describe('detectVcs: line changes', () => {
  const NUMSTAT = { 'git diff --numstat HEAD': '12\t3\ta.ts\n0\t4\tb.ts\n' }

  test('a dirty branch carries its line counts', async () => {
    const state = await detect(makeRun({ 'git branch --show-current': 'main\n', ...GITHUB_HTTPS, ...DIRTY, ...NUMSTAT }))
    expect(state).toEqual({ type: 'branch', platform: 'GitHub', repo: 'Raven', branch: 'main', dirty: true, changes: { added: 12, removed: 7 } })
  })

  test('a detached HEAD carries them too', async () => {
    const state = await detect(
      makeRun({ 'git branch --show-current': '\n', ...GITHUB_HTTPS, 'git rev-parse --short HEAD': 'a3f9c12\n', ...DIRTY, ...NUMSTAT }),
    )
    expect(state).toMatchObject({ type: 'detached', changes: { added: 12, removed: 7 } })
  })

  test('a clean tree runs no diff', async () => {
    // makeRun rejects unlisted commands, and none is listed for the diff
    const state = await detect(makeRun({ 'git branch --show-current': 'main\n', ...GITHUB_HTTPS, ...CLEAN, ...NUMSTAT }))
    expect(state).not.toHaveProperty('changes')
  })

  test('only untracked files: no counts', async () => {
    const state = await detect(
      makeRun({ 'git branch --show-current': 'main\n', ...GITHUB_HTTPS, 'git status --porcelain': '?? new.ts\n', 'git diff --numstat HEAD': '' }),
    )
    expect(state).toMatchObject({ dirty: true })
    expect(state).not.toHaveProperty('changes')
  })

  test('no HEAD yet (diff fails): no counts', async () => {
    const state = await detect(
      makeRun({ 'git branch --show-current': 'main\n', ...GITHUB_HTTPS, ...DIRTY, 'git diff --numstat HEAD': new Error('bad revision HEAD') }),
    )
    expect(state).not.toHaveProperty('changes')
  })
})

describe('detectVcs: git', () => {
  test('GitHub HTTPS remote, clean branch', async () => {
    const state = await detect(makeRun({ 'git branch --show-current': 'main\n', ...GITHUB_HTTPS, ...CLEAN }))
    expect(state).toEqual({ type: 'branch', platform: 'GitHub', repo: 'Raven', branch: 'main', dirty: false })
  })

  test('GitHub HTTPS remote, dirty branch', async () => {
    const state = await detect(makeRun({ 'git branch --show-current': 'main\n', ...GITHUB_HTTPS, ...DIRTY }))
    expect(state).toMatchObject({ type: 'branch', dirty: true })
  })

  test('Bitbucket SSH remote on named branch', async () => {
    const state = await detect(makeRun({ 'git branch --show-current': 'feature/x\n', ...BITBUCKET_SSH, ...CLEAN }))
    expect(state).toEqual({ type: 'branch', platform: 'Bitbucket', repo: 'Raven', branch: 'feature/x', dirty: false })
  })

  test('no remote configured, clean', async () => {
    const state = await detect(makeRun({ 'git branch --show-current': 'main\n', ...NO_REMOTE, ...CLEAN }))
    expect(state).toEqual({ type: 'branch', platform: null, repo: null, branch: 'main', dirty: false })
  })

  test('no remote configured, dirty', async () => {
    const state = await detect(makeRun({ 'git branch --show-current': 'main\n', ...NO_REMOTE, ...DIRTY }))
    expect(state).toMatchObject({ type: 'branch', dirty: true })
  })

  test('unknown host uses host as platform', async () => {
    const state = await detect(
      makeRun({
        'git branch --show-current': 'main\n',
        'git remote get-url origin': 'https://mygit.corp.com/org/Raven.git\n',
        ...CLEAN,
      }),
    )
    expect(state).toMatchObject({ platform: 'mygit.corp.com', repo: 'Raven' })
  })

  test('detached HEAD, clean', async () => {
    const state = await detect(
      makeRun({ 'git branch --show-current': '\n', ...GITHUB_HTTPS, 'git rev-parse --short HEAD': 'a3f9c12\n', ...CLEAN }),
    )
    expect(state).toEqual({ type: 'detached', platform: 'GitHub', repo: 'Raven', hash: 'a3f9c12', dirty: false })
  })

  test('detached HEAD, dirty', async () => {
    const state = await detect(
      makeRun({ 'git branch --show-current': '\n', ...GITHUB_HTTPS, 'git rev-parse --short HEAD': 'a3f9c12\n', ...DIRTY }),
    )
    expect(state).toMatchObject({ type: 'detached', dirty: true })
  })

  test('detached HEAD, rev-parse failure falls back to HEAD', async () => {
    const state = await detect(
      makeRun({ 'git branch --show-current': '\n', ...NO_REMOTE, 'git rev-parse --short HEAD': new Error('x'), ...CLEAN }),
    )
    expect(state).toMatchObject({ type: 'detached', hash: 'HEAD' })
  })

  test('no git repo returns none', async () => {
    const state = await detect(
      makeRun({ 'git branch --show-current': new Error('not a git repo'), 'tf workfold /noprompt': new Error('no tf') }),
    )
    expect(state.type).toBe('none')
  })

  test('GitLab SSH remote', async () => {
    const state = await detect(makeRun({ 'git branch --show-current': 'develop\n', ...GITLAB_SSH, ...CLEAN }))
    expect(state).toMatchObject({ platform: 'GitLab', repo: 'Raven' })
  })

  test('git status failure defaults to clean', async () => {
    const state = await detect(
      makeRun({ 'git branch --show-current': 'main\n', ...GITHUB_HTTPS, 'git status --porcelain': new Error('git status failed') }),
    )
    expect(state).toMatchObject({ type: 'branch', dirty: false })
  })
})

describe('parseTfvcPlatform', () => {
  test('dev.azure.com extracts org name from path', () => expect(parseTfvcPlatform('https://dev.azure.com/myorg/')).toBe('myorg'))
  test('dev.azure.com with no org', () => expect(parseTfvcPlatform('https://dev.azure.com/')).toBe('Azure DevOps'))
  test('legacy visualstudio.com extracts org as subdomain', () => expect(parseTfvcPlatform('https://myorg.visualstudio.com/')).toBe('myorg'))
  test('on-premise TFS server returns hostname', () =>
    expect(parseTfvcPlatform('http://tfsserver:8080/tfs/DefaultCollection')).toBe('tfsserver'))
  test('private server with no port returns hostname', () =>
    expect(parseTfvcPlatform('http://tfs.acmecorp.com/tfs/DefaultCollection')).toBe('tfs.acmecorp.com'))
  test('null URL returns TFS', () => expect(parseTfvcPlatform(null)).toBe('TFS'))
  test('unparseable URL returns TFS', () => expect(parseTfvcPlatform('not-a-url')).toBe('TFS'))
})

const TFVC_WORKFOLD_AZURE = [
  '=============================================================================',
  'Workspace : MyWorkspace (user)',
  'Collection : https://dev.azure.com/myorg/',
  ' $/MyProject/Main : /home/user/myproject',
].join('\n')

const TFVC_WORKFOLD_TFS = [
  '=============================================================================',
  'Workspace : CorpWorkspace (CORP\\jdoe)',
  'Collection : http://tfsserver:8080/tfs/DefaultCollection',
  ' $/CorpProject/Dev : /home/user/corp',
].join('\n')

const TFVC_STATUS_CLEAN = 'There are no pending changes.'
const TFVC_STATUS_DIRTY = 'edit        $/MyProject/Main/src/app.js'

describe('detectTfvc', () => {
  test('Azure DevOps workspace, clean', async () => {
    const state = await detectTfvc(
      makeRun({ 'tf workfold /noprompt': TFVC_WORKFOLD_AZURE, 'tf status /noprompt /recursive': TFVC_STATUS_CLEAN }),
    )
    expect(state).toEqual({ type: 'tfvc', platform: 'myorg', repo: 'MyProject', branch: 'Main', dirty: false })
  })

  test('Azure DevOps workspace, dirty', async () => {
    const state = await detectTfvc(
      makeRun({ 'tf workfold /noprompt': TFVC_WORKFOLD_AZURE, 'tf status /noprompt /recursive': TFVC_STATUS_DIRTY }),
    )
    expect(state).toMatchObject({ dirty: true })
  })

  test('on-premise TFS, clean', async () => {
    const state = await detectTfvc(
      makeRun({ 'tf workfold /noprompt': TFVC_WORKFOLD_TFS, 'tf status /noprompt /recursive': TFVC_STATUS_CLEAN }),
    )
    expect(state).toEqual({ type: 'tfvc', platform: 'tfsserver', repo: 'CorpProject', branch: 'Dev', dirty: false })
  })

  test('tf command not found returns null', async () => {
    expect(await detectTfvc(makeRun({ 'tf workfold /noprompt': new Error('tf: command not found') }))).toBeNull()
  })

  test('unrecognized workfold output returns null', async () => {
    expect(await detectTfvc(makeRun({ 'tf workfold /noprompt': 'tf version 16.0.0' }))).toBeNull()
  })

  test('status failure defaults to clean', async () => {
    const state = await detectTfvc(
      makeRun({ 'tf workfold /noprompt': TFVC_WORKFOLD_AZURE, 'tf status /noprompt /recursive': new Error('status failed') }),
    )
    expect(state).toMatchObject({ dirty: false })
  })
})

describe('detectVcs: provider order', () => {
  test('falls through to TFVC when not a git repo', async () => {
    const state = await detect(
      makeRun({
        'git branch --show-current': new Error('not a git repo'),
        'tf workfold /noprompt': TFVC_WORKFOLD_AZURE,
        'tf status /noprompt /recursive': TFVC_STATUS_CLEAN,
      }),
    )
    expect(state).toMatchObject({ type: 'tfvc', platform: 'myorg' })
  })

  test('returns none when neither git nor tfvc', async () => {
    const state = await detect(
      makeRun({
        'git branch --show-current': new Error('not a git repo'),
        'tf workfold /noprompt': new Error('tf: command not found'),
      }),
    )
    expect(state.type).toBe('none')
  })

  test('a provider whose marker is found goes first', async () => {
    // only $tf exists, so git is never asked (an unlisted git command would reject and fall through anyway)
    const asked: string[] = []
    const run: Run = async argv => {
      asked.push(argv.join(' '))
      return makeRun({ 'tf workfold /noprompt': TFVC_WORKFOLD_AZURE, 'tf status /noprompt /recursive': TFVC_STATUS_CLEAN })(argv)
    }
    const state = await detectVcs(run, '/fake/marker-test', async p => p.endsWith('$tf'))
    expect(state.type).toBe('tfvc')
    expect(asked[0]).toBe('tf workfold /noprompt')
  })

  test('marker search walks up to the root', async () => {
    const looked: string[] = []
    await detectVcs(makeRun({ 'git branch --show-current': new Error('x'), 'tf workfold /noprompt': new Error('x') }), '/a/b', async p => {
      looked.push(p)
      return false
    })
    expect(looked).toContain('/a/b/.git')
    expect(looked).toContain('/a/.git')
    expect(looked).toContain('/.git')
  })
})
