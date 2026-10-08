export type GitOperation = 'rebase' | 'merge' | 'cherry-pick' | 'revert' | 'bisect'

export type GitCommit = {
  hash: string
  subject: string
  at: number
}

export type GitState = {
  branch: string
  isDetached: boolean
  oid: string | null
  upstream: string | null
  ahead: number | null
  behind: number | null
  staged: number
  modified: number
  untracked: number
  conflicts: number
  stashes: number
  operation: GitOperation | null
  step: string | null
  lastCommit: GitCommit | null
  repo: string
  subdir: string | null
  isWorktree: boolean
}

export type KubeState = {
  context: string
  namespace: string | null
}

export type RateLimitGauge = {
  label: string
  percent: number
  resetsAt: number | null
}

export type HudInfo = {
  version: string
  model: string
  cwd: string
  home: string | null
  git: GitState | null
  kube: KubeState | null
  contextPercent: number | null
  contextTokens: number | null
  contextWindow: number
  rateLimits: RateLimitGauge[]
  costUsd: number | null
  prompts: number | null
  sessionStartedAt: number | null
  fetchedAt: number
  effortSetting: string | null
  caveman: string | null
  sessionTitle: string | null
}

export type AgentStatusLabel = 'running' | 'idle' | 'completed' | 'failed' | 'killed'

export type AgentRow = {
  id: string
  toolUseId: string
  description: string
  type: string
  model: string
  isBackground: boolean
  status: AgentStatusLabel
  startedAt: number
  endedAt: number | null
  tools: number
  lastTool: string | null
  tokens: number | null
}

export type AgentToolOutcome = 'pending' | 'ok' | 'error'

export type AgentLogEntry =
  | { kind: 'prompt'; text: string }
  | { kind: 'reply'; text: string }
  | { kind: 'tool'; name: string; summary: string; outcome: AgentToolOutcome }

export type AgentLogView = {
  agentId: string
  entries: AgentLogEntry[]
  isDenied: boolean
}

export type TurnGroupView = {
  head: string
  texts: number
  tools: Record<string, number>
  last: string | null
  isActive: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'orange-hud': {
      info: HudInfo | null
      hint: string
      agents: AgentRow[]
      now: number
      effort: string | null
      groupOf: StateFamily<string | null>
      turnGroup: StateFamily<TurnGroupView | null>
      groupOpen: StateFamily<boolean>
      showThoughts: boolean
      viewing: string | null
      agentLog: AgentLogView | null
    }
  }
}
