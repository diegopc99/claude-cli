import { atom, memberOf, read, update } from 'claude-code'
import type {
  AgentStatus,
  Color,
  EngineInterface,
  Register,
  RenderElement,
  RenderInput,
  Timer,
} from 'claude-code'

import type { AgentRow, AgentStatusLabel, GitState, HudInfo, RateLimitGauge, TurnGroupView } from '../types'

type SiteInput = RenderInput<'Pane'> | RenderInput<'AbovePrompt'>
type ModeStyle = { label: string; color: Color }
type ClassicSessionFields = { permission_mode?: string; effort?: { level: string }; agent_id?: string }
type TranscriptInput =
  | RenderInput<'AssistantMessage'>
  | RenderInput<'ToolUse'>
  | RenderInput<'ToolResult'>
  | RenderInput<'ToolGroup'>
  | RenderInput<'ToolProgress'>

const ORANGE = '#D97757'
const EYE_BACKGROUND = '#000000'
const KUBE_BLUE = '#326CE5'
// The dark theme's own prompt background (userMessageBackground).
const PROMPT_CARD = '#373737'
// The dark theme's side-panel background (composerSidebarBackground).
const CODE_CARD = '#262626'
const SECTION_INDENT = 2
const PANE = 'hud'
const PANE_COLUMNS = 46
// Widest engine mode indicator, "⏵⏵ bypass permissions on · ", with room to spare.
const MODE_COVER_COLUMNS = 30
const MAX_AGENTS = 50
const INFO_MS = 5_000
const POLL_MS = 1_000
// A finished subagent leaves $.agent.list() a little after it ends; one that is
// gone before a poll ever saw it is taken as done once this has passed.
const GRACE_MS = 5_000
const CAVEMAN_MODES = new Set([
  'off', 'lite', 'full', 'ultra', 'wenyan-lite', 'wenyan', 'wenyan-full', 'wenyan-ultra',
  'commit', 'review', 'compress',
])
const SPINNER = ['◐', '◓', '◑', '◒']
const LIMIT_LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d' }

// Clawd as the session header draws it (default pose): body glyphs, with the
// eye spans painted over a dark background so the quadrant gaps read as eyes.
const MASCOT: ReadonlyArray<ReadonlyArray<{ glyphs: string; isEye?: true }>> = [
  [{ glyphs: ' ▐' }, { glyphs: '▛███▛█', isEye: true }, { glyphs: ' ' }],
  [{ glyphs: '▝▜' }, { glyphs: '█████', isEye: true }, { glyphs: '█▀' }],
  [{ glyphs: ' ▝▝   ▝▝ ' }],
]

const MODE_STYLES: Record<string, ModeStyle> = {
  auto: { label: '⏵⏵ AUTO MODE', color: ORANGE },
  acceptEdits: { label: '⏵⏵ ACCEPT EDITS', color: 'autoAccept' },
  plan: { label: '⏸ PLAN MODE', color: 'planMode' },
  bypassPermissions: { label: '⚠ BYPASS PERMISSIONS', color: 'error' },
  dontAsk: { label: "⏵ DON'T ASK", color: 'warning' },
  default: { label: '● DEFAULT MODE', color: 'inactive' },
}

const info = atom({ plugin: 'orange-hud', key: 'info' } as const, null)
const hint = atom({ plugin: 'orange-hud', key: 'hint' } as const, '')
const agents = atom({ plugin: 'orange-hud', key: 'agents' } as const, [])
const now = atom({ plugin: 'orange-hud', key: 'now' } as const, 0)
const permissionMode = atom({ plugin: 'orange-hud', key: 'permissionMode' } as const, null)
const effort = atom({ plugin: 'orange-hud', key: 'effort' } as const, null)
const groupOf = atom({ plugin: 'orange-hud', key: 'groupOf' } as const, null)
const turnGroup = atom({ plugin: 'orange-hud', key: 'turnGroup' } as const, null)
const groupOpen = atom({ plugin: 'orange-hud', key: 'groupOpen' } as const, false)
const showThoughts = atom({ plugin: 'orange-hud', key: 'showThoughts' } as const, false)

let poller: Timer | undefined
let paneHinted = false
let isAutoOpened = false
let isRefreshQueued = false
let isFullscreen: boolean | undefined
const ASKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])
// The main conversation's open turn: prose not yet known to be intermediate,
// and the group its work folds into.
const tracker: GroupTracker = { pending: [], group: null }
let lastHint: string | undefined

const isLiveLabel = (status: AgentStatusLabel) => status === 'running' || status === 'idle'
const isLive = (row: AgentRow) => isLiveLabel(row.status)

function statusLabel(status: AgentStatus): AgentStatusLabel {
  switch (status) {
    case 'idle':
    case 'completed':
    case 'failed':
    case 'killed':
      return status
    default:
      return 'running'
  }
}

export function modelLabel(model: string): string {
  const match = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?(\[1m\])?$/i.exec(model)
  if (match === null) return model
  const family = match[1] ?? ''
  const size = match[4] === undefined ? '' : ' · 1M'
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${match[2]}.${match[3]}${size}`
}

export function tokens(count: number): string {
  if (count >= 1_000_000) return `${Number((count / 1_000_000).toFixed(1))}M`
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`
  return String(count)
}

export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function span(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

export function parseGitHead(line: string): Omit<GitState, 'changed'> {
  const body = line.replace(/^## /, '')
  const hasUpstream = body.includes('...')
  const name = (body.replace(/ \[[^\]]*\]$/, '').split('...')[0] ?? body).replace(/^No commits yet on /, '')
  const ahead = /ahead (\d+)/.exec(body)?.[1]
  const behind = /behind (\d+)/.exec(body)?.[1]
  return {
    branch: name === 'HEAD (no branch)' ? 'detached' : name,
    ahead: hasUpstream ? Number(ahead ?? 0) : null,
    behind: hasUpstream ? Number(behind ?? 0) : null,
  }
}

function bar(percent: number, width: number): string {
  const filled = Math.min(width, Math.max(0, Math.round((percent / 100) * width)))
  return '▰'.repeat(filled) + '▱'.repeat(width - filled)
}

function levelColor(percent: number): Color {
  if (percent >= 85) return 'error'
  if (percent >= 60) return 'warning'
  return ORANGE
}

function statusColor(status: AgentStatusLabel): Color {
  switch (status) {
    case 'completed':
      return 'success'
    case 'failed':
      return 'error'
    case 'killed':
      return 'inactive'
    case 'idle':
      return 'warning'
    default:
      return ORANGE
  }
}

function statusIcon(row: AgentRow, at: number): string {
  switch (row.status) {
    case 'completed':
      return '✓'
    case 'failed':
      return '✗'
    case 'killed':
      return '■'
    case 'idle':
      return '◌'
    default:
      return SPINNER[Math.floor(at / 1_000) % SPINNER.length] ?? '●'
  }
}

export type ListItem = { marker: string; text: string; depth: number }

export type ReplyBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; isOrdered: boolean; items: ListItem[] }
  | { kind: 'code'; language: string; source: string }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'rule' }
  | { kind: 'markdown'; text: string }

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/

// Splits a reply into the blocks the HUD styles itself; paragraphs and tables
// stay markdown so the engine's renderer keeps inline formatting and tables.
export function parseReply(text: string): ReplyBlock[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReplyBlock[] = []
  let prose: string[] = []
  const flush = () => {
    if (prose.some(line => line.trim() !== '')) blocks.push({ kind: 'markdown', text: prose.join('\n').trim() })
    prose = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const fence = FENCE.exec(line)
    if (fence !== null) {
      flush()
      const mark = fence[1] ?? '```'
      const body: string[] = []
      i++
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith(mark)) body.push(lines[i++] ?? '')
      blocks.push({ kind: 'code', language: fence[2] ?? '', source: body.join('\n') })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading !== null) {
      flush()
      blocks.push({ kind: 'heading', level: (heading[1] ?? '#').length, text: heading[2] ?? '' })
      continue
    }
    if (RULE.test(line)) {
      flush()
      blocks.push({ kind: 'rule' })
      continue
    }
    const item = LIST_ITEM.exec(line)
    if (item !== null) {
      flush()
      const isOrdered = /\d/.test(item[2] ?? '')
      const items: ListItem[] = []
      while (i < lines.length) {
        const current = lines[i] ?? ''
        const match = LIST_ITEM.exec(current)
        if (match !== null && /\d/.test(match[2] ?? '') === isOrdered) {
          items.push({ marker: match[2] ?? '-', text: match[3] ?? '', depth: Math.floor((match[1] ?? '').length / 2) })
        } else if (current.trim() !== '' && /^\s+/.test(current) && items.length > 0) {
          const last = items[items.length - 1]
          if (last !== undefined) last.text = `${last.text}\n${current.trim()}`
        } else if (current.trim() === '' && LIST_ITEM.test(lines[i + 1] ?? '')) {
          // a blank line between items keeps the list going
        } else {
          break
        }
        i++
      }
      i--
      blocks.push({ kind: 'list', isOrdered, items })
      continue
    }
    const quote = QUOTE.exec(line)
    if (quote !== null) {
      flush()
      const quoted: string[] = []
      while (i < lines.length && QUOTE.test(lines[i] ?? '')) quoted.push(QUOTE.exec(lines[i++] ?? '')?.[1] ?? '')
      i--
      blocks.push({ kind: 'quote', lines: quoted })
      continue
    }
    if (line.trim() === '') {
      flush()
      continue
    }
    prose.push(line)
  }
  flush()

  return blocks
}

export type GroupRow = {
  uuid: string
  isPrompt: boolean
  isAssistant: boolean
  blocks: ReadonlyArray<{ type: string; id?: unknown; name?: unknown }>
}

export type GroupTracker = {
  pending: Array<{ key: string; isText: boolean }>
  group: TurnGroupView | null
}

export type GroupChange = { members: string[]; view: TurnGroupView }

// Folds a turn's work into one group: prose a tool call follows, and the calls.
// Prose no call follows (the final answer) stays out, and so does everything up
// to a call that asks the person something, which also closes the group.
export function noteGroupRow(tracker: GroupTracker, row: GroupRow): GroupChange | null {
  if (row.isPrompt) {
    tracker.pending = []
    tracker.group = null
    return null
  }
  if (!row.isAssistant) return null

  const calls = row.blocks.filter(block => block.type === 'tool_use' && typeof block.id === 'string')
  const isText = row.blocks.some(block => block.type === 'text')
  const isProse = isText || row.blocks.some(block => block.type === 'thinking' || block.type === 'redacted_thinking')
  if (calls.length === 0) {
    if (isProse) tracker.pending.push({ key: row.uuid, isText })
    return null
  }
  if (calls.some(call => ASKING_TOOLS.has(String(call.name)))) {
    tracker.pending = []
    tracker.group = null
    return null
  }

  const prose = isProse ? [...tracker.pending, { key: row.uuid, isText }] : tracker.pending
  const members = [...prose.map(part => part.key), ...calls.map(call => String(call.id))]
  // The head draws the group's summary line, so it must be a row the transcript
  // draws: thinking rows are hidden there, so a text row or the first call.
  const head = prose.find(part => part.isText)?.key ?? String(calls[0]?.id ?? row.uuid)
  const current = tracker.group ?? { head, texts: 0, tools: {}, last: null, isActive: true }
  const tools = { ...current.tools }
  for (const call of calls) {
    const name = printable(String(call.name)).replace(/^mcp__[^_]+__/, '')
    tools[name] = (tools[name] ?? 0) + 1
  }
  const view: TurnGroupView = {
    head: current.head,
    texts: current.texts + prose.filter(part => part.isText).length,
    tools,
    last: printable(String(calls.at(-1)?.name ?? '')).replace(/^mcp__[^_]+__/, '') || null,
    isActive: true,
  }
  tracker.pending = []
  tracker.group = view

  return { members, view }
}

export function groupSummary(view: TurnGroupView): string {
  const tools = Object.entries(view.tools).sort((a, b) => b[1] - a[1])
  const calls = tools.reduce((total, [, count]) => total + count, 0)
  const counts = [
    view.texts > 0 ? `${view.texts} texto${view.texts === 1 ? '' : 's'}` : null,
    `${calls} herramienta${calls === 1 ? '' : 's'}`,
  ].filter(part => part !== null)
  const detail = tools.slice(0, 4).map(([name, count]) => `${name} ${count}`).join(' · ')
  const lead = view.isActive ? `trabajando${view.last !== null ? ` (${view.last})` : ''} · ` : ''

  return `${lead}${counts.join(' · ')}${detail === '' ? '' : ` — ${detail}`}`
}

export type GroupDrawing = 'engine' | 'hidden' | 'summary' | 'expanded-head'

export function groupDrawing(head: string | null, keys: readonly string[], isOpen: boolean, isShowingAll: boolean): GroupDrawing {
  if (isShowingAll || head === null) return 'engine'
  const isHead = keys.includes(head)
  if (isOpen) return isHead ? 'expanded-head' : 'engine'
  return isHead ? 'summary' : 'hidden'
}

// Text from outside the session (a kubeconfig, git, the model) is drawn as is,
// so control characters that could carry terminal escape sequences are dropped.
export function printable(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
}

function cwdLabel(hud: HudInfo): string {
  if (hud.home !== null && hud.cwd === hud.home) return '~'
  return hud.cwd.split('/').filter(part => part !== '').at(-1) ?? hud.cwd
}

async function attempt<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work()
  } catch {
    return fallback
  }
}

async function storePermissionMode($: EngineInterface, value: string): Promise<void> {
  if ((await read($, permissionMode)) === value) return
  await update($, permissionMode, () => value)
}

async function storeEffort($: EngineInterface, value: string): Promise<void> {
  if ((await read($, effort)) === value) return
  await update($, effort, () => value)
}

async function gitState($: EngineInterface): Promise<GitState | null> {
  // No optional locks: a background poll must not take the index lock from the
  // person's own git commands. No fsmonitor: a repo's config cannot name a command.
  const run = await $.process.run(
    ['git', '--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '--branch'],
    { timeoutMs: 2_000 },
  )
  if (run.exitCode !== 0) return null
  const [head = '', ...files] = run.stdout.split('\n').filter(line => line !== '')
  return { ...parseGitHead(printable(head)), changed: files.length }
}

async function kubeContext($: EngineInterface): Promise<string | null> {
  const run = await $.process.run(['kubectl', 'config', 'current-context'], { timeoutMs: 2_000 })
  return run.exitCode === 0 ? printable(run.stdout.trim()) || null : null
}

// Mirrors ~/.claude/hooks/caveman-statusline.sh, which the HUD replaces; the
// flag text is reduced to [a-z0-9-] so nothing from the file reaches the terminal raw.
async function cavemanBadge($: EngineInterface, configDir: string): Promise<string | null> {
  const raw = await $.fs.read(`${configDir}/.caveman-active`)
  const mode = raw.slice(0, 64).toLowerCase().replace(/[^a-z0-9-]/g, '')
  if (!CAVEMAN_MODES.has(mode)) return null
  const badge = mode === 'full' ? '[CAVEMAN]' : `[CAVEMAN:${mode.toUpperCase()}]`
  const savings = await attempt(
    async () => (await $.fs.read(`${configDir}/.caveman-statusline-suffix`)).slice(0, 64).replace(/[\u0000-\u001f\u007f]/g, '').trim(),
    '',
  )
  return savings === '' ? badge : `${badge} ${savings}`
}

async function collectInfo($: EngineInterface): Promise<HudInfo> {
  const home = await attempt(() => $.env.get('HOME'), undefined)
  const configDir = (await attempt(() => $.env.get('CLAUDE_CONFIG_DIR'), undefined)) ?? (home === undefined ? undefined : `${home}/.claude`)
  const [version, model, cwd, usage, git, kube, prompts, settings, caveman, fetchedAt] = await Promise.all([
    attempt(async () => (await $.session.version()).version, ''),
    attempt(() => $.session.model(), ''),
    attempt(() => $.session.cwd(), ''),
    attempt(() => $.session.usage(), undefined),
    attempt(() => gitState($), null),
    attempt(() => kubeContext($), null),
    attempt(() => $.session.turns(), null),
    attempt(() => $.settings.read(), {}),
    configDir === undefined ? Promise.resolve(null) : attempt(() => cavemanBadge($, configDir), null),
    $.clock.now(),
  ])
  const rateLimits: RateLimitGauge[] = (usage?.rateLimits ?? []).map(limit => {
    const resetsAt = limit.resetsAt === undefined ? NaN : Date.parse(limit.resetsAt)
    return {
      label: LIMIT_LABELS[limit.kind] ?? limit.kind,
      percent: limit.percentUsed,
      resetsAt: Number.isNaN(resetsAt) ? null : resetsAt,
    }
  })

  return {
    version,
    model,
    cwd,
    home: home ?? null,
    git,
    kubeContext: kube,
    contextPercent: usage?.context.percent ?? null,
    contextTokens: usage?.context.tokens ?? null,
    contextWindow: usage?.context.window ?? 0,
    rateLimits,
    costUsd: usage?.cost?.usd ?? null,
    prompts,
    sessionStartedAt: usage?.startedAt ?? null,
    fetchedAt,
    effortSetting: typeof settings['effortLevel'] === 'string' ? settings['effortLevel'] : null,
    caveman,
  }
}

async function refreshInfo($: EngineInterface): Promise<void> {
  const fresh = await collectInfo($)
  const current = await read($, info)
  if (current !== null && JSON.stringify({ ...current, fetchedAt: 0 }) === JSON.stringify({ ...fresh, fetchedAt: 0 })) {
    if (fresh.fetchedAt - current.fetchedAt < 60_000) return
  }
  await update($, info, () => fresh)
}

// A drawing that finds no figures yet asks for them from outside the draw.
function queueRefresh($: EngineInterface): void {
  if (isRefreshQueued) return
  isRefreshQueued = true
  $.clock.after(1, () => void refreshInfo($))
}

function noteSession($: EngineInterface, e: ClassicSessionFields): void {
  if (e.agent_id !== undefined) return
  if (e.permission_mode) void storePermissionMode($, e.permission_mode)
  if (e.effort?.level) void storeEffort($, e.effort.level)
}

async function openPane($: EngineInterface, isAsked: boolean): Promise<void> {
  const opened = await $.ui.open({ id: PANE, title: 'HUD', columns: PANE_COLUMNS })
  $.ui.invalidate('ui.render')
  if (!opened.isPlaced && !isAsked && !paneHinted) {
    paneHinted = true
    $.ui.toast('HUD: widen the terminal or run /hud to dock it on the right')
  }
}

async function isHudInPane($: EngineInterface): Promise<boolean> {
  const panes = await attempt(() => $.ui.panes(), [])
  return panes.some(pane => pane.id === PANE && pane.isPlaced && pane.isShown)
}

async function finish(
  $: EngineInterface,
  matches: (row: AgentRow) => boolean,
  status: AgentStatusLabel,
  totals?: { tools?: number; tokens?: number },
): Promise<void> {
  const at = await $.clock.now()
  await update($, agents, list =>
    list.map(row =>
      matches(row) && isLive(row)
        ? { ...row, status, endedAt: at, tools: totals?.tools ?? row.tools, tokens: totals?.tokens ?? row.tokens }
        : row,
    ),
  )
}

async function countTool($: EngineInterface, agentId: string, tool: string): Promise<void> {
  const list = await read($, agents)
  if (!list.some(row => row.id === agentId && isLive(row))) return
  await update($, agents, rows =>
    rows.map(row => (row.id === agentId ? { ...row, tools: row.tools + 1, lastTool: printable(tool) } : row)),
  )
}

async function pollAgents($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  const rows = await read($, agents)
  if (!rows.some(isLive)) {
    poller?.cancel()
    poller = undefined
    return
  }
  await update($, now, () => at)
  const listed = new Map((await $.agent.list()).map(agent => [agent.id, agent.status]))
  await update($, agents, list =>
    list.map((row): AgentRow => {
      if (!isLive(row)) return row
      const status = listed.get(row.id)
      if (status === undefined) {
        return at - row.startedAt > GRACE_MS ? { ...row, status: 'completed', endedAt: at } : row
      }
      const label = statusLabel(status)
      if (label === row.status) return row
      return isLiveLabel(label) ? { ...row, status: label } : { ...row, status: label, endedAt: at }
    }),
  )
}

function ensurePoller($: EngineInterface): void {
  if (poller !== undefined) return
  poller = $.clock.every(POLL_MS, () => void pollAgents($))
}

async function drawGrouped(
  $: EngineInterface,
  e: TranscriptInput,
  keys: readonly string[],
  draw: () => Promise<RenderElement>,
): Promise<RenderElement> {
  let found: string | null = null
  for (const key of keys) {
    found = await read($, memberOf(groupOf, { requestId: key }))
    if (found !== null) break
  }
  const head = found
  const [view, isOpen, isShowingAll] = await Promise.all([
    head === null ? Promise.resolve(null) : read($, memberOf(turnGroup, { requestId: head })),
    head === null ? Promise.resolve(false) : read($, memberOf(groupOpen, { requestId: head })),
    read($, showThoughts),
  ])
  const drawing = groupDrawing(view === null ? null : head, keys, isOpen, isShowingAll)
  if (drawing === 'engine' || head === null || view === null) return draw()

  const { Box, Button } = $.ui.resolve(e)
  if (drawing === 'hidden') return <Box />
  if (drawing === 'expanded-head') {
    const drawn = await draw()
    return (
      <Box flexDirection="column">
        <Button key="group" label={`▾ ocultar · ${groupSummary(view)}`} plain dimColor onPress={() => update($, memberOf(groupOpen, { requestId: head }), () => false)} />
        {drawn}
      </Box>
    )
  }

  return (
    <Box paddingLeft={2}>
      <Button key="group" label={`▸ ${groupSummary(view)}`} plain dimColor onPress={() => update($, memberOf(groupOpen, { requestId: head }), () => true)} />
    </Box>
  )
}

function replyBlock($: EngineInterface, e: RenderInput<'AssistantMessage'>, block: ReplyBlock): RenderElement {
  const { Box, Code, Markdown, Text } = $.ui.resolve(e)
  const plain = (text: string) => text.replace(/\*\*|__|`/g, '')

  switch (block.kind) {
    case 'heading':
      return block.level <= 2 ? (
        <Box flexDirection="column">
          <Text color={ORANGE} bold>{`◆ ${plain(block.text)}`}</Text>
          <Text color={ORANGE} dimColor wrap="truncate-end">{'─'.repeat(400)}</Text>
        </Box>
      ) : (
        <Text color={block.level === 3 ? ORANGE : 'text'} bold>{plain(block.text)}</Text>
      )
    case 'list': {
      let ordinal = 0
      return (
        <Box flexDirection="column">
          {block.items.map(item => {
            ordinal = item.depth === 0 ? ordinal + 1 : ordinal
            const marker = block.isOrdered && item.depth === 0 ? String(ordinal) : item.depth === 0 ? '•' : '◦'
            return (
              <Box paddingLeft={item.depth * 2}>
                <Box flexShrink={0} width={block.isOrdered ? 4 : 3}>
                  <Text color={ORANGE} bold>{marker}</Text>
                </Box>
                <Box flexShrink={1} flexGrow={1}>
                  <Markdown text={item.text} />
                </Box>
              </Box>
            )
          })}
        </Box>
      )
    }
    case 'code':
      return (
        <Box flexDirection="column" backgroundColor={CODE_CARD} paddingX={1}>
          {block.language !== '' ? <Text color={ORANGE} dimColor>{block.language}</Text> : null}
          {block.language !== '' ? (
            <Code source={block.source} language={block.language} wrap="wrap" />
          ) : (
            <Code source={block.source} wrap="wrap" />
          )}
        </Box>
      )
    case 'quote':
      return (
        <Box flexDirection="column">
          {block.lines.map(line => (
            <Box>
              <Box flexShrink={0}>
                <Text dimColor>{'│ '}</Text>
              </Box>
              <Box flexShrink={1}>
                <Markdown text={line === '' ? ' ' : line} dimColor />
              </Box>
            </Box>
          ))}
        </Box>
      )
    case 'rule':
      return <Text dimColor wrap="truncate-end">{'─'.repeat(400)}</Text>
    default:
      return <Markdown text={block.text} />
  }
}

function replyTree($: EngineInterface, e: RenderInput<'AssistantMessage'>): RenderElement {
  const { Box, Text } = $.ui.resolve(e)

  return (
    <Box marginTop={1}>
      <Box flexShrink={0} width={3}>
        <Text color={ORANGE}>{e.props.isFirstOfReply ? '●' : ' '}</Text>
      </Box>
      <Box flexDirection="column" flexShrink={1} flexGrow={1} gap={1}>
        {parseReply(e.props.text).map(block => replyBlock($, e, block))}
      </Box>
    </Box>
  )
}

function sectionTitle($: EngineInterface, e: SiteInput, title: string, right?: RenderElement): RenderElement {
  const { Box, Text } = $.ui.resolve(e)

  // Fixed-width parts sit in non-shrinking boxes: Yoga shrinks every flex item
  // in proportion to its width, so an unguarded title loses its last letter to
  // the rule beside it and wraps.
  return (
    <Box gap={1}>
      <Box flexShrink={0}>
        <Text color={ORANGE} dimColor>──</Text>
      </Box>
      <Box flexShrink={0}>
        <Text color={ORANGE} bold>{title}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text color={ORANGE} dimColor wrap="truncate-end">{'─'.repeat(e.props.bodyColumns)}</Text>
      </Box>
      {right !== undefined ? <Box flexShrink={0}>{right}</Box> : null}
    </Box>
  )
}

function gauge($: EngineInterface, e: SiteInput, label: string, percent: number, detail: string): RenderElement {
  const { Box, Text } = $.ui.resolve(e)
  const width = Math.min(24, Math.max(6, e.props.bodyColumns - 26 - SECTION_INDENT))

  return (
    <Box gap={1}>
      <Box flexShrink={0} gap={1}>
        <Text dimColor>{label.padEnd(7)}</Text>
        <Text color={levelColor(percent)}>{bar(percent, width)}</Text>
        <Text color={levelColor(percent)} bold>{`${Math.round(percent)}%`.padStart(4)}</Text>
      </Box>
      <Box flexShrink={1}>
        <Text dimColor wrap="truncate-end">{detail}</Text>
      </Box>
    </Box>
  )
}

function modePill($: EngineInterface, e: SiteInput, mode: string | null): RenderElement | null {
  if (mode === null) return null
  const { Text } = $.ui.resolve(e)
  const style = MODE_STYLES[mode] ?? { label: mode.toUpperCase(), color: 'inactive' }

  return <Text backgroundColor={style.color} color="inverseText" bold>{` ${style.label} `}</Text>
}

function headerCard(
  $: EngineInterface,
  e: SiteInput,
  hud: HudInfo | null,
  mode: string | null,
  effortLevel: string | null,
): RenderElement {
  const { Box, Text } = $.ui.resolve(e)
  const model = hud === null || hud.model === '' ? 'Claude' : modelLabel(hud.model)
  const level = effortLevel ?? hud?.effortSetting ?? null

  return (
    <Box flexDirection="column" width={e.props.bodyColumns} borderStyle="bold" borderColor={ORANGE} paddingX={1}>
      <Box gap={2}>
        <Box flexDirection="column" flexShrink={0}>
          {MASCOT.map(row => (
            <Box>
              {row.map(part =>
                part.isEye ? (
                  <Text color={ORANGE} backgroundColor={EYE_BACKGROUND}>{part.glyphs}</Text>
                ) : (
                  <Text color={ORANGE}>{part.glyphs}</Text>
                ),
              )}
            </Box>
          ))}
        </Box>
        <Box flexDirection="column" flexShrink={1}>
          <Box gap={1}>
            <Box flexShrink={0}>
              <Text bold>Claude Code</Text>
            </Box>
            {hud !== null && hud.version !== '' ? (
              <Box flexShrink={1}>
                <Text dimColor wrap="truncate-end">v{hud.version}</Text>
              </Box>
            ) : null}
          </Box>
          <Text color={ORANGE} bold wrap="truncate-end">{model}</Text>
          {level !== null ? <Text dimColor wrap="truncate-end">effort {level}</Text> : null}
          <Text dimColor wrap="truncate-end">{hud === null ? '' : cwdLabel(hud)}</Text>
        </Box>
      </Box>
      <Box justifyContent="space-between" marginTop={1} gap={1}>
        <Box flexShrink={0}>{modePill($, e, mode) ?? <Text dimColor>◌ mode on next prompt</Text>}</Box>
        {hud?.caveman ? (
          <Box flexShrink={1}>
            <Text color={ORANGE} wrap="truncate-start">{hud.caveman}</Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  )
}

function sessionSection($: EngineInterface, e: SiteInput, hud: HudInfo | null): RenderElement {
  const { Box, Text } = $.ui.resolve(e)
  const context = hud?.contextPercent ?? null
  const summary = [
    hud?.costUsd != null ? `$${hud.costUsd.toFixed(2)}` : null,
    hud?.prompts != null ? `${hud.prompts} prompt${hud.prompts === 1 ? '' : 's'}` : null,
    hud?.sessionStartedAt != null ? span(hud.fetchedAt - hud.sessionStartedAt) : null,
  ].filter(part => part !== null)

  return (
    <Box flexDirection="column" marginTop={1} gap={1}>
      {sectionTitle($, e, 'SESSION')}
      <Box flexDirection="column" gap={1} paddingLeft={SECTION_INDENT}>
        {context !== null && hud !== null
          ? gauge($, e, 'context', context, hud.contextTokens !== null && hud.contextWindow > 0 ? `${tokens(hud.contextTokens)}/${tokens(hud.contextWindow)}` : '')
          : <Text dimColor>context —</Text>}
        {(hud?.rateLimits ?? []).map(limit =>
          gauge($, e, limit.label, limit.percent, limit.resetsAt === null || hud === null ? '' : `↻ ${span(limit.resetsAt - hud.fetchedAt)}`),
        )}
        {summary.length > 0 ? <Text color={ORANGE} wrap="truncate-end">{summary.join(' · ')}</Text> : null}
      </Box>
    </Box>
  )
}

function workspaceSection($: EngineInterface, e: SiteInput, hud: HudInfo | null): RenderElement {
  const { Box, Text } = $.ui.resolve(e)
  const git = hud?.git ?? null
  const kube = hud?.kubeContext ?? null
  const kubeColor: Color = kube !== null && kube.startsWith('kind-') ? 'success' : 'error'

  return (
    <Box flexDirection="column" marginTop={1} gap={1}>
      {sectionTitle($, e, 'WORKSPACE')}
      <Box flexDirection="column" gap={1} paddingLeft={SECTION_INDENT}>
        <Box gap={1}>
          <Box flexShrink={0}>
            <Text color={ORANGE}>⌂</Text>
          </Box>
          <Box flexShrink={1}>
            <Text dimColor wrap="truncate-end">{hud === null ? '—' : cwdLabel(hud)}</Text>
          </Box>
        </Box>
        {git !== null ? (
          <Box gap={1}>
            <Box flexShrink={0}>
              <Text color={ORANGE}>⎇</Text>
            </Box>
            <Box flexShrink={1}>
              <Text bold wrap="truncate-end">{git.branch}</Text>
            </Box>
            <Box flexShrink={0} gap={1}>
              {git.changed > 0 ? <Text color="warning">●{git.changed} changed</Text> : <Text color="success">✓ clean</Text>}
              {git.ahead !== null ? <Text dimColor>↑{git.ahead} ↓{git.behind ?? 0}</Text> : null}
            </Box>
          </Box>
        ) : null}
        {kube !== null ? (
          <Box gap={1}>
            <Box flexShrink={0}>
              <Text color={KUBE_BLUE} bold>⎈</Text>
            </Box>
            <Box flexShrink={1}>
              <Text color={kubeColor} wrap="truncate-end">{kube}</Text>
            </Box>
          </Box>
        ) : null}
      </Box>
    </Box>
  )
}

function agentsSection($: EngineInterface, e: SiteInput, rows: readonly AgentRow[], at: number): RenderElement {
  const { Box, Button, Text } = $.ui.resolve(e)
  const live = rows.filter(isLive).reverse()
  const done = rows.filter(row => !isLive(row)).reverse()
  const counts = [live.length > 0 ? `${live.length} running` : null, done.length > 0 ? `${done.length} done` : null]
    .filter(part => part !== null)
  const title = counts.length > 0 ? `AGENTS · ${counts.join(' · ')}` : 'AGENTS'
  const clear =
    done.length > 0 ? (
      <Button key="clear" label="clear" hotkey="c" plain onPress={() => update($, agents, list => list.filter(isLive))} />
    ) : undefined

  return (
    <Box flexDirection="column" marginTop={1} gap={1}>
      {sectionTitle($, e, title, clear)}
      <Box flexDirection="column" gap={1} paddingLeft={SECTION_INDENT}>
        {rows.length === 0 ? <Text dimColor>no agents yet</Text> : null}
        {[...live, ...done].map(row => {
          const isRowLive = isLive(row)
          const took = elapsed((row.endedAt ?? Math.max(at, row.startedAt)) - row.startedAt)
          const details = [
            modelLabel(row.model),
            `${row.tools} tool${row.tools === 1 ? '' : 's'}`,
            isRowLive ? row.lastTool : row.tokens !== null ? `${tokens(row.tokens)} tok` : null,
            row.isBackground ? 'bg' : null,
          ].filter(part => part !== null)

          return (
            <Box flexDirection="column">
              <Box justifyContent="space-between" gap={1}>
                <Box gap={1} flexShrink={1}>
                  <Box flexShrink={0}>
                    <Text color={statusColor(row.status)}>{statusIcon(row, at)}</Text>
                  </Box>
                  <Box flexShrink={1}>
                    <Text bold={isRowLive} dimColor={!isRowLive} wrap="truncate-end">{row.description}</Text>
                  </Box>
                </Box>
                <Box gap={1} flexShrink={0}>
                  <Text dimColor>{row.type}</Text>
                  <Text color={isRowLive ? ORANGE : 'inactive'}>{took.padStart(6)}</Text>
                </Box>
              </Box>
              <Text dimColor wrap="truncate-end">{`  ${details.join(' · ')}`}</Text>
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}

function compactCard(
  $: EngineInterface,
  e: SiteInput,
  hud: HudInfo | null,
  mode: string | null,
  hintText: string,
): RenderElement {
  const { Box, Text } = $.ui.resolve(e)
  const context = hud?.contextPercent ?? null

  return (
    <Box flexDirection="column" width={e.props.bodyColumns} borderStyle="bold" borderColor={ORANGE} paddingX={1}>
      <Box justifyContent="space-between" gap={1}>
        <Box gap={1} flexShrink={1}>
          <Box flexShrink={1}>
            <Text color={ORANGE} bold wrap="truncate-end">
              ◆ {hud === null || hud.model === '' ? 'Claude' : modelLabel(hud.model)}
            </Text>
          </Box>
          {hud?.caveman ? (
            <Box flexShrink={1}>
              <Text color={ORANGE} wrap="truncate-start">{hud.caveman}</Text>
            </Box>
          ) : null}
        </Box>
        <Box flexShrink={0}>{modePill($, e, mode)}</Box>
      </Box>
      {hud !== null && hud.cwd !== '' ? (
        <Box justifyContent="space-between" gap={1}>
          <Box flexShrink={1}>
            <Text dimColor wrap="truncate-end">{cwdLabel(hud)}</Text>
          </Box>
          {hud.git !== null ? (
            <Box flexShrink={0}>
              <Text color={ORANGE}>⎇ {hud.git.branch}</Text>
            </Box>
          ) : null}
        </Box>
      ) : null}
      <Box justifyContent="space-between" gap={1}>
        {context !== null ? gauge($, e, 'context', context, '') : <Text dimColor>context —</Text>}
        {hud?.costUsd != null ? (
          <Box flexShrink={0}>
            <Text color={ORANGE}>${hud.costUsd.toFixed(2)}</Text>
          </Box>
        ) : null}
      </Box>
      <Text dimColor wrap="truncate-end">{hintText}</Text>
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'hud',
      description: 'Open the orange-hud side pane: session status and running agents',
    })
    await $.command.register({
      name: 'thoughts',
      description: "Expand or fold every turn's grouped work (intermediate text and tool calls)",
    })
    void refreshInfo($)
    $.clock.every(INFO_MS, () => void refreshInfo($))
    if ((await read($, agents)).some(isLive)) ensurePoller($)

    return next(e)
  })

  on('command.run', { command: 'hud' }, async $ => {
    await openPane($, true)

    return { text: 'HUD pane opened.' }
  })

  on('command.run', { command: 'thoughts' }, async $ => {
    const isShown = !(await read($, showThoughts))
    await update($, showThoughts, () => isShown)

    return { text: isShown ? 'Turn work expanded.' : 'Turn work folded.' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    $.ui.invalidate('ui.render')

    return closed
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    void refreshInfo($)
    const group = tracker.group
    if (e.agentId === undefined && group !== null && group.isActive) {
      const settled: TurnGroupView = { ...group, isActive: false }
      tracker.group = settled
      void update($, memberOf(turnGroup, { requestId: settled.head }), () => settled)
    }

    return done
  })

  on('classic.UserPromptSubmit', ($, e, next) => {
    noteSession($, e)

    return next(e)
  })

  on('classic.PostToolUse', ($, e, next) => {
    noteSession($, e)

    return next(e)
  })

  on('classic.Stop', ($, e, next) => {
    noteSession($, e)

    return next(e)
  })

  on('classic.SessionStart', ($, e, next) => {
    noteSession($, e)

    return next(e)
  })

  on('classic.PostToolUseFailure', ($, e, next) => {
    noteSession($, e)

    return next(e)
  })

  on('classic.Notification', ($, e, next) => {
    noteSession($, e)

    return next(e)
  })

  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (stored.deny !== undefined || e.agentId !== undefined) return stored

    const change = noteGroupRow(tracker, {
      uuid: stored.uuid,
      isPrompt: e.message.type === 'user' && e.door === 'prompt',
      isAssistant: e.message.type === 'assistant',
      blocks: e.message.content,
    })
    if (change !== null) {
      await update($, memberOf(turnGroup, { requestId: change.view.head }), () => change.view)
      for (const key of change.members) void update($, memberOf(groupOf, { requestId: key }), () => change.view.head)
    }

    return stored
  })

  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) =>
    drawGrouped($, e, [e.requestId], async () =>
      e.props.isSummary === true || e.props.text.trim() === '' || /^API Error/.test(e.props.text) ? next(e) : replyTree($, e),
    ),
  )

  on('ui.render', { component: 'ToolUse' }, ($, e, next) => drawGrouped($, e, [e.props.tool_use_id], () => next(e)))

  on('ui.render', { component: 'ToolResult' }, ($, e, next) => drawGrouped($, e, [e.props.tool_use_id], () => next(e)))

  on('ui.render', { component: 'ToolProgress' }, ($, e, next) => drawGrouped($, e, [e.props.tool_use_id], () => next(e)))

  on('ui.render', { component: 'ToolGroup' }, ($, e, next) =>
    drawGrouped(
      $,
      e,
      e.props.calls.flatMap(call => (call.tool_use_id === undefined ? [] : [call.tool_use_id])),
      () => next(e),
    ),
  )

  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'composer' } } }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box backgroundColor={PROMPT_CARD} paddingX={2} paddingY={1} marginTop={1} marginBottom={1} gap={2}>
        <Box flexShrink={0}>
          <Text color={ORANGE} bold>❯</Text>
        </Box>
        <Box flexShrink={1}>
          <Text color="text" wrap="wrap">{e.props.text}</Text>
        </Box>
      </Box>
    )
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (spawned.deny !== undefined || spawned.agentId === undefined || e.workflow !== undefined) {
      return spawned
    }

    const startedAt = await $.clock.now()
    const row: AgentRow = {
      id: spawned.agentId,
      toolUseId: e.tool_use_id,
      description: printable(e.description),
      type: printable(e.subagentType),
      model: spawned.model,
      isBackground: e.background === true,
      status: 'running',
      startedAt,
      endedAt: null,
      tools: 0,
      lastTool: null,
      tokens: null,
    }
    await update($, agents, list => [...list.filter(one => one.id !== row.id), row].slice(-MAX_AGENTS))
    await update($, now, () => startedAt)
    ensurePoller($)
    if (isFullscreen !== false) void openPane($, false)

    return spawned
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const ran = await next(e)
    const toolUseId = e.tool_use_id
    if (toolUseId === undefined) return ran

    const result = ran.result as { status?: string; totalToolUseCount?: number; totalTokens?: number } | undefined
    if (ran.deny !== undefined || ran.isError === true) {
      await finish($, row => row.toolUseId === toolUseId, 'failed')
    } else if (result?.status === 'completed') {
      await finish($, row => row.toolUseId === toolUseId, 'completed', {
        tools: result.totalToolUseCount,
        tokens: result.totalTokens,
      })
    }

    return ran
  })

  on('tool.call', ($, e, next) => {
    if (e.agentId !== undefined) void countTool($, e.agentId, e.tool)

    return next(e)
  })

  // The hint is drawn in the HUD instead. A render hook may
  // not write state, so the captured text is handed over from a timer. The
  // engine strips the permission mode out of this hint, so it never says one.
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const text = e.props.hint
    if (text !== lastHint) {
      lastHint = text
      $.clock.after(1, () => void update($, hint, () => text))
    }
    const { Box, Text } = $.ui.resolve(e)

    // Once a hook draws this site the engine still prints "⏵⏵ <mode> on · "
    // just left of it, and nothing in the API turns that off. Blanks painted
    // there cover it; only the fullscreen layout lets them reach past the site.
    return (
      <Box>
        <Box position="absolute" left={-MODE_COVER_COLUMNS} top={0}>
          <Text>{' '.repeat(MODE_COVER_COLUMNS)}</Text>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    // Docking unasked only makes sense where the pane becomes a sidebar, which
    // only a render input reveals; the open itself must happen outside the draw.
    if (e.viewport?.isFullscreen !== undefined) isFullscreen = e.viewport.isFullscreen
    if (isFullscreen === true && !isAutoOpened) {
      isAutoOpened = true
      $.clock.after(1, () => void openPane($, false))
    }

    const [hud, hintText, mode, isInPane] = await Promise.all([
      read($, info),
      read($, hint),
      read($, permissionMode),
      isHudInPane($),
    ])
    if (hud === null) queueRefresh($)
    if (!isInPane) return compactCard($, e, hud, mode, hintText)
    if (hintText === '') return next(e)

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box width={e.props.bodyColumns} paddingX={1}>
        <Text dimColor wrap="truncate-end">{hintText}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box } = $.ui.resolve(e)
    const [hud, rows, at, mode, effortLevel] = await Promise.all([
      read($, info),
      read($, agents),
      read($, now),
      read($, permissionMode),
      read($, effort),
    ])
    if (hud === null) queueRefresh($)

    return (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        {headerCard($, e, hud, mode, effortLevel)}
        {sessionSection($, e, hud)}
        {workspaceSection($, e, hud)}
        {agentsSection($, e, rows, at)}
      </Box>
    )
  })
}
