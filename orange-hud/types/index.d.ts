export type GitState = {
  branch: string
  changed: number
  ahead: number | null
  behind: number | null
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
  kubeContext: string | null
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
    }
  }
}
