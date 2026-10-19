export type Zone = 'green' | 'yellow' | 'red'

/** Lines added and removed in the working tree and index against HEAD (`git diff --numstat HEAD`). */
export type LineChanges = { added: number; removed: number }

export type VcsState =
  | { type: 'none' }
  | { type: 'branch'; platform: string | null; repo: string | null; branch: string; dirty: boolean; changes?: LineChanges }
  | { type: 'detached'; platform: string | null; repo: string | null; hash: string; dirty: boolean; changes?: LineChanges }
  | { type: 'tfvc'; platform: string; repo: string | null; branch: string | null; dirty: boolean }

export type Snapshot = {
  model: string | null
  /** The main loop's reasoning effort as its last model request sent it; null for a model without effort. */
  effort: string | number | null
  tokens: number
  percent: number
  vcs: VcsState
}

declare module 'claude-code' {
  interface PluginState {
    'context-watch': { snapshot: Snapshot | null; isHidden: boolean; isRedNotified: boolean }
  }
}
