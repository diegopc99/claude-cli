import { describe, expect, mock, test } from 'claude-code/testing'
import type { AgentStatus } from 'claude-code'

import {
  agentLogEntries,
  groupDrawing,
  groupSummary,
  isTitleFresh,
  noteGroupRow,
  parseReply,
  pickSessionTitle,
} from '../hooks/register.tsx'
import type { GroupTracker } from '../hooks/register.tsx'

const PANE = {
  plugin: 'orange-hud',
  surface: 'terminal' as const,
  component: 'Pane' as const,
  requestId: 'hud',
  props: {
    title: 'HUD',
    isFocused: false,
    bodyColumns: 44,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
}

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

const SHOWN_PANE = { id: 'hud', title: 'HUD', isShown: true, isFocused: false, isPlaced: true }

const ran = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

describe('side pane header', () => {
  test('shows Clawd, the version, the model and its effort', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    on('session.version', () => ({ value: { version: '2.1.292' } }))
    on('session.model', () => ({ value: 'claude-opus-5-5[1m]' }))
    on('settings.read', () => ({ value: { effortLevel: 'xhigh' } }))
    on('session.cwd', () => ({ value: '/home/u/projects/example-service' }))

    const pane = await $.ui.mount(PANE)
    await clock.advance(5)
    expect(await pane.find({ text: /▛███▛█/ })).toBeDefined()
    expect(await pane.find({ text: /Claude Code/ })).toBeDefined()
    expect(await pane.find({ text: /v2\.1\.292/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^Opus 5\.5 · 1M$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^effort xhigh$/ })).toBeDefined()
    expect(await pane.findAll({ type: 'Text', text: /^example-service$/ })).toHaveLength(2)
    expect(await pane.find({ text: /projects/ })).toBeUndefined()
  })

  test('takes the effort from the session events and shows no permission mode', async ($, on) => {
    const clock = mock.clock(on)
    on('classic.UserPromptSubmit', () => ({}))
    const pane = await $.ui.mount(PANE)
    await $.classic.UserPromptSubmit({ prompt: 'hi', permission_mode: 'plan', effort: { level: 'max' } })
    await clock.advance(5)
    expect(await pane.find({ text: /effort max/ })).toBeDefined()
    expect(await pane.find({ text: /MODE|mode on next prompt/ })).toBeUndefined()
  })
})

describe('session title', () => {
  test('prefers the /rename title, decodes escapes and drops control characters', () => {
    expect(pickSessionTitle(['"aiTitle":"Fix the HUD"'])).toBe('Fix the HUD')
    expect(pickSessionTitle(['"aiTitle":"Generated"', '"customTitle":"Mine"', '"aiTitle":"Later generated"'])).toBe('Mine')
    expect(pickSessionTitle(['"aiTitle":"Sesi\\u00f3n \\"rara\\""'])).toBe('Sesión "rara"')
    expect(pickSessionTitle(['"aiTitle":"bad\\u001b]0;x\\u0007title"'])).toBe('bad]0;xtitle')
    expect(pickSessionTitle(['"aiTitle":"cut\\', '"aiTitle":"whole"'])).toBe('whole')
    expect(pickSessionTitle([])).toBeNull()
  })

  test('shows the session title to the left of the caveman badge', async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, { HOME: '/home/u' })
    const titles = '"aiTitle":"RFC1123 restriction for cluster names"\n'
    const mtimeMs = 1
    on('session.id', () => ({ value: '01234567-89ab-cdef-0123-456789abcdef' }))
    on('fs.read', ($, e) => (String(e.path).endsWith('.caveman-active') ? { value: 'full' } : { value: '' }))
    on('fs.stat', () => ({ value: { kind: 'file' as const, size: titles.length, mtimeMs, isLink: false } }))
    on('process.run', ($, e) => {
      if (e.argv[0] === 'find') return ran('/home/u/.claude/projects/-p/01234567-89ab-cdef-0123-456789abcdef.jsonl\n')
      if (e.argv[0] === 'grep') return ran(titles)
      return ran('')
    })

    const pane = await $.ui.mount(PANE)
    await clock.advance(5)
    expect(await pane.find({ type: 'Text', text: /^RFC1123 restriction for cluster names$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^\[CAVEMAN\]$/ })).toBeDefined()

  })

  test('shows a /rename right away, without waiting for the next refresh', async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, { HOME: '/home/u' })
    let titles = '"aiTitle":"Generated"\n'
    let mtimeMs = 1
    on('session.id', () => ({ value: '01234567-89ab-cdef-0123-456789abcdef' }))
    on('fs.stat', () => ({ value: { kind: 'file' as const, size: titles.length, mtimeMs, isLink: false } }))
    on('process.run', ($, e) => {
      if (e.argv[0] === 'find') return ran('/home/u/.claude/projects/-p/01234567-89ab-cdef-0123-456789abcdef.jsonl\n')
      if (e.argv[0] === 'grep') return ran(titles)
      return ran('')
    })
    on('command.run', ($, e) => {
      titles += `"customTitle":"${e.args}"\n`
      mtimeMs = 2
      return { text: `Session renamed to: ${e.args}` }
    })

    const pane = await $.ui.mount(PANE)
    await clock.advance(5)
    expect(await pane.find({ type: 'Text', text: /^Generated$/ })).toBeDefined()

    await $.command.run({
      command: 'rename',
      args: 'renamed',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 120 },
    })
    expect(await pane.find({ type: 'Text', text: /^renamed$/ })).toBeDefined()
  })

  test('re-reads the title as soon as the transcript changes, as a /rename does', () => {
    const cache = { id: 'a', stamp: '100:1' }
    expect(isTitleFresh(cache, 'a', '100:1')).toBe(true)
    expect(isTitleFresh(cache, 'a', '160:2')).toBe(false)
    expect(isTitleFresh(cache, 'b', '100:1')).toBe(false)
    expect(isTitleFresh(undefined, 'a', '100:1')).toBe(false)
  })
})

describe('side pane sections', () => {
  test('gauges the context and rate limits, and sums up the session', async ($, on) => {
    const at = 10 * 3_600_000
    const clock = mock.clock(on, { now: at })
    on('session.usage', () => ({
      value: {
        startedAt: at - 3_900_000,
        context: { tokens: 300_000, window: 1_000_000, percent: 30 },
        rateLimits: [
          { kind: 'five_hour', percentUsed: 44, resetsAt: new Date(at + (2 * 60 + 13) * 60_000 + 30_000).toISOString() },
        ],
        cost: { usd: 3.42 },
      },
    }))
    on('session.turns', () => ({ value: 12 }))

    const pane = await $.ui.mount(PANE)
    await clock.advance(5)
    expect(await pane.find({ text: /SESSION/ })).toBeDefined()
    expect(await pane.find({ text: /30%/ })).toBeDefined()
    expect(await pane.find({ text: /300k\/1M/ })).toBeDefined()
    expect(await pane.find({ text: /44%/ })).toBeDefined()
    expect(await pane.find({ text: /↻ 2h 13m/ })).toBeDefined()
    expect(await pane.find({ text: /\$3\.42 · 12 prompts · 1h 05m/ })).toBeDefined()
  })

  test('shows the branch, its changes and upstream drift, and the kube context', async ($, on) => {
    const clock = mock.clock(on)
    const gitArgs: string[][] = []
    on('process.run', ($, e) => {
      if (e.argv[0] !== 'git') return ran('kind-tilt\n')
      gitArgs.push([...e.argv])
      return ran('## main...origin/main [ahead 2]\n M hooks/register.tsx\n?? notes.md\n')
    })

    const pane = await $.ui.mount(PANE)
    await clock.advance(5)
    expect(await pane.find({ text: /WORKSPACE/ })).toBeDefined()
    expect(await pane.find({ text: 'main' })).toBeDefined()
    expect(await pane.find({ text: /●2 changed/ })).toBeDefined()
    expect(await pane.find({ text: /↑2 ↓0/ })).toBeDefined()
    const context = await pane.find({ type: 'Text', text: /^kind-tilt$/ })
    expect(context?.props['color']).toBe('success')
    expect((await pane.find({ type: 'Text', text: /^⎈$/ }))?.props['color']).toBe('#326CE5')
    expect(await pane.findAll({ type: 'Text', text: /^──$/ })).toHaveLength(3)
    expect(gitArgs[0]).toEqual(['git', '--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '--branch'])
  })

  test('drops terminal control sequences a kubeconfig context name could carry', async ($, on) => {
    const clock = mock.clock(on)
    on('process.run', ($, e) => (e.argv[0] === 'git' ? ran('') : ran('kind-\u001b]0;pwned\u0007dev\n')))

    const pane = await $.ui.mount(PANE)
    await clock.advance(5)
    const drawn = JSON.stringify(await pane.drawn())
    expect(drawn).not.toContain('\\u001b')
    expect(drawn).not.toContain('\\u0007')
    expect(await pane.find({ type: 'Text', text: 'kind-]0;pwneddev' })).toBeDefined()
  })

  test('lists a spawned agent as running, then as done once the engine reports it', async ($, on) => {
    const clock = mock.clock(on, { now: 10_000 })
    let status: AgentStatus = 'running'
    on('agent.spawn', () => ({ model: 'claude-haiku-4-5-20251001', agentId: 'agent-1' }))
    on('agent.list', () => ({
      value: [{ id: 'agent-1', description: 'Find callers', type: 'Explore', status }],
    }))
    on('ui.open', () => ({ value: { isPlaced: true as const } }))

    await $.agent.spawn({
      tool_use_id: 'toolu_1',
      prompt: 'find callers',
      description: 'Find callers',
      subagentType: 'Explore',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-opus-5-5',
      background: false,
      fork: false,
    })
    const pane = await $.ui.mount(PANE)
    expect(await pane.find({ text: /Find callers/ })).toBeDefined()
    expect(await pane.find({ text: /AGENTS · 1 running/ })).toBeDefined()
    expect(await pane.find({ text: /Haiku 4\.5/ })).toBeDefined()

    status = 'completed'
    await clock.advance(1_000)
    expect(await pane.find({ text: /✓/ })).toBeDefined()
    expect(await pane.find({ text: /AGENTS · 1 done/ })).toBeDefined()
    expect(JSON.stringify(await pane.drawn())).toContain('"backgroundColor":"#373737"')

    await pane.press({ key: 'clear' })
    expect(await pane.find({ text: /no agents yet/ })).toBeDefined()
  })
})

describe('agent viewer', () => {
  const SPAWN = {
    tool_use_id: 'toolu_1',
    prompt: 'find callers',
    description: 'Find callers',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' as const },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  }

  const MESSAGES = [
    { role: 'user' as const, text: '<system-reminder>ctx</system-reminder>\nFind every caller of openPane', toolUses: [] },
    {
      role: 'assistant' as const,
      text: 'Buscando.',
      toolUses: [
        { tool_use_id: 't1', tool: 'Grep', input: { pattern: 'openPane\\(' }, text: '3 matches' },
        { tool_use_id: 't2', tool: 'mcp__srv__lookup', input: { query: 'x' }, text: 'boom', isError: true as const },
        { tool_use_id: 't3', tool: 'Read', input: { file_path: '/repo/hooks/register.tsx' } },
      ],
    },
    {
      role: 'user' as const,
      text: '',
      toolUses: [],
      toolResults: [{ tool_use_id: 't1', text: '3 matches', isError: false, result: undefined }],
    },
    { role: 'assistant' as const, text: '## Callers\n- register.tsx', toolUses: [] },
  ]

  test('turns an agent conversation into prompt, reply and one line per tool', () => {
    expect(agentLogEntries(MESSAGES)).toEqual([
      { kind: 'prompt', text: 'Find every caller of openPane' },
      { kind: 'reply', text: 'Buscando.' },
      { kind: 'tool', name: 'Grep', summary: 'openPane\\(', outcome: 'ok' },
      { kind: 'tool', name: 'lookup', summary: 'x', outcome: 'error' },
      { kind: 'tool', name: 'Read', summary: '/repo/hooks/register.tsx', outcome: 'pending' },
      { kind: 'reply', text: '## Callers\n- register.tsx' },
    ])
  })

  test('a click on an agent shows its conversation in the pane, and ← HUD returns', async ($, on) => {
    mock.clock(on, { now: 10_000 })
    const opens: Array<number | undefined> = []
    const asked: Array<string | undefined> = []
    on('agent.spawn', () => ({ model: 'claude-haiku-4-5-20251001', agentId: 'agent-1' }))
    on('agent.list', () => ({ value: [{ id: 'agent-1', description: 'Find callers', type: 'Explore', status: 'running' as AgentStatus }] }))
    on('ui.open', ($, e) => {
      opens.push(e.columns)
      return { value: { isPlaced: true as const } }
    })
    on('ui.scroll', () => ({}))
    on('session.messages', ($, e) => {
      asked.push(e.agentId)
      return { value: MESSAGES }
    })

    await $.agent.spawn(SPAWN)
    const pane = await $.ui.mount(PANE)
    await pane.press({ key: 'agent:agent-1' })

    expect(asked).toContain('agent-1')
    expect(opens.at(-1)).toBe(96)
    expect(await pane.find({ text: /AGENT · Explore/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Find every caller of openPane' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^◆ Callers$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'lookup' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '✗' })).toBeDefined()
    expect(await pane.find({ text: /SESSION/ })).toBeUndefined()

    await pane.press({ key: 'back' })
    expect(opens.at(-1)).toBe(46)
    expect(await pane.find({ text: /SESSION/ })).toBeDefined()
    expect(await pane.find({ text: /AGENTS · 1 running/ })).toBeDefined()
  })

  test('says so when the agent conversation cannot be read', async ($, on) => {
    mock.clock(on, { now: 10_000 })
    on('agent.spawn', () => ({ model: 'claude-haiku-4-5-20251001', agentId: 'agent-1' }))
    on('agent.list', () => ({ value: [] }))
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    on('session.messages', () => ({ value: { deny: 'agent-1: no transcript' } }))

    await $.agent.spawn(SPAWN)
    const pane = await $.ui.mount(PANE)
    await pane.press({ key: 'agent:agent-1' })
    expect(await pane.find({ text: /No se puede leer/ })).toBeDefined()
  })

  test('marks the agent whose transcript the person has in view', async ($, on) => {
    mock.clock(on, { now: 10_000 })
    on('agent.spawn', () => ({ model: 'claude-haiku-4-5-20251001', agentId: 'agent-1' }))
    on('agent.list', () => ({ value: [] }))
    on('ui.open', () => ({ value: { isPlaced: true as const } }))

    await $.agent.spawn(SPAWN)
    const main = await $.ui.mount(PANE)
    expect(await main.find({ type: 'Text', text: '▶' })).toBeUndefined()
    await main.unmount()

    const viewed = await $.ui.mount({ ...PANE, props: { ...PANE.props, view: { agentId: 'agent-1' } } })
    expect(await viewed.find({ type: 'Text', text: '▶' })).toBeDefined()
  })
})

describe('band above the prompt', () => {
  test('carries a compact HUD and the prompt hint while the side pane is not shown', async ($, on) => {
    const clock = mock.clock(on)
    const below = await $.ui.mount({
      plugin: 'orange-hud',
      surface: 'terminal',
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
    })
    expect(await below.find({ text: /shortcuts/ })).toBeUndefined()
    expect(JSON.stringify(await below.drawn())).not.toContain('"position":"absolute"')

    await clock.advance(5)
    const band = await $.ui.mount({
      plugin: 'orange-hud',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: BAND_PROPS,
    })
    expect(await band.find({ text: /◆ Claude/ })).toBeDefined()
    expect(await band.find({ text: /\? for shortcuts/ })).toBeDefined()
  })

  test('shrinks to the hint line while the side pane shows the HUD', async ($, on) => {
    const clock = mock.clock(on)
    on('ui.panes', () => ({ value: [SHOWN_PANE] }))
    await $.ui.mount({
      plugin: 'orange-hud',
      surface: 'terminal',
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
    })
    await clock.advance(5)

    const band = await $.ui.mount({
      plugin: 'orange-hud',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: BAND_PROPS,
    })
    expect(await band.find({ text: /\? for shortcuts/ })).toBeDefined()
    expect(await band.find({ text: /◆/ })).toBeUndefined()
  })

  test('leaves the band to a survey', async ($, on) => {
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>survey</Text>
    })
    const band = await $.ui.mount({
      plugin: 'orange-hud',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { ...BAND_PROPS, hasSurvey: true },
    })
    expect(await band.find({ text: 'survey' })).toBeDefined()
  })
})

describe('transcript', () => {
  const text = (uuid: string, body = 'texto') => ({ uuid, isPrompt: false, isAssistant: true, blocks: [{ type: 'text', text: body }] })
  const call = (uuid: string, id: string, name: string, withText = false) => ({
    uuid,
    isPrompt: false,
    isAssistant: true,
    blocks: [...(withText ? [{ type: 'text' }] : []), { type: 'tool_use', id, name }],
  })
  const prompt = (uuid: string) => ({ uuid, isPrompt: true, isAssistant: false, blocks: [{ type: 'text' }] })
  const result = (uuid: string) => ({ uuid, isPrompt: false, isAssistant: false, blocks: [{ type: 'tool_result' }] })

  test('folds a turn into one group headed by its first row, leaving the final answer out', () => {
    const tracker: GroupTracker = { pending: [], group: null }
    expect(noteGroupRow(tracker, prompt('p1'))).toBeNull()
    expect(noteGroupRow(tracker, text('t1'))).toBeNull()

    const first = noteGroupRow(tracker, call('c1', 'toolu_1', 'Read'))
    expect(first?.members).toEqual(['t1', 'toolu_1'])
    expect(first?.view).toMatchObject({ head: 't1', texts: 1, tools: { Read: 1 }, isActive: true })

    expect(noteGroupRow(tracker, result('r1'))).toBeNull()
    const second = noteGroupRow(tracker, call('c2', 'toolu_2', 'Bash', true))
    expect(second?.members).toEqual(['c2', 'toolu_2'])
    expect(second?.view).toMatchObject({ head: 't1', texts: 2, tools: { Read: 1, Bash: 1 } })

    expect(noteGroupRow(tracker, text('final'))).toBeNull()
    expect(noteGroupRow(tracker, prompt('p2'))).toBeNull()
    expect(tracker).toEqual({ pending: [], group: null })
  })

  test('never heads a group with a thinking row, which the transcript does not draw', () => {
    const thinking = (uuid: string) => ({ uuid, isPrompt: false, isAssistant: true, blocks: [{ type: 'thinking' }] })
    const tracker: GroupTracker = { pending: [], group: null }
    noteGroupRow(tracker, prompt('p1'))
    noteGroupRow(tracker, thinking('k1'))
    noteGroupRow(tracker, text('t1'))
    const withText = noteGroupRow(tracker, call('c1', 'toolu_1', 'Bash'))
    expect(withText?.members).toEqual(['k1', 't1', 'toolu_1'])
    expect(withText?.view.head).toBe('t1')

    const bare: GroupTracker = { pending: [], group: null }
    noteGroupRow(bare, prompt('p2'))
    noteGroupRow(bare, thinking('k2'))
    expect(noteGroupRow(bare, call('c2', 'toolu_2', 'Read'))?.view.head).toBe('toolu_2')
  })

  test('closes the group at a question, keeping the text that leads to it', () => {
    const tracker: GroupTracker = { pending: [], group: null }
    noteGroupRow(tracker, prompt('p1'))
    noteGroupRow(tracker, call('c1', 'toolu_1', 'Grep'))
    noteGroupRow(tracker, text('why'))
    expect(noteGroupRow(tracker, call('q1', 'toolu_q', 'AskUserQuestion'))).toBeNull()
    expect(tracker.group).toBeNull()

    const after = noteGroupRow(tracker, call('c2', 'toolu_2', 'Edit'))
    expect(after?.view.head).toBe('toolu_2')
  })

  test('summarises a group and decides how each of its rows draws', () => {
    const view = { head: 't1', texts: 2, tools: { Bash: 5, Read: 3, Edit: 3, Grep: 1, Glob: 1 }, last: 'Bash', isActive: false }
    expect(groupSummary(view)).toBe('2 textos · 13 herramientas — Bash 5 · Read 3 · Edit 3 · Grep 1')
    expect(groupSummary({ ...view, isActive: true })).toMatch(/^trabajando \(Bash\) · /)

    expect(groupDrawing('t1', ['t1'], false, false)).toBe('summary')
    expect(groupDrawing('t1', ['toolu_1'], false, false)).toBe('hidden')
    expect(groupDrawing('t1', ['t1'], true, false)).toBe('expanded-head')
    expect(groupDrawing('t1', ['toolu_1'], true, false)).toBe('engine')
    expect(groupDrawing('t1', ['toolu_1'], false, true)).toBe('engine')
    expect(groupDrawing(null, ['final'], false, false)).toBe('engine')
  })

  test("draws the person's prompt as a grey card led by an orange ❯", async $ => {
    const prompt = await $.ui.mount({
      plugin: 'orange-hud',
      surface: 'terminal',
      component: 'UserMessage',
      props: { text: 'haz la vista de la derecha más bonita', origin: { kind: 'composer' }, isExpanded: false },
    })
    expect(await prompt.find({ type: 'Text', text: /^❯$/ })).toBeDefined()
    expect(await prompt.find({ type: 'Text', text: 'haz la vista de la derecha más bonita' })).toBeDefined()
    const drawn = JSON.stringify(await prompt.drawn())
    expect(drawn).toContain('"backgroundColor":"#373737"')
    expect(drawn).not.toContain('borderStyle')
  })
})

describe('reply formatting', () => {
  const REPLY = [
    'Hecho. El panel ya agrupa el trabajo.',
    '',
    '## Qué cambia',
    '- El grupo empieza en el **primer** texto.',
    '  sigue en la línea siguiente',
    '',
    '- Los tests cubren el thinking.',
    '  - anidado',
    '',
    '1. Abre /hud',
    '2. Pulsa ▸',
    '',
    '```ts',
    'const head = 1',
    '```',
    '',
    '> una cita',
    '',
    '---',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
  ].join('\n')

  test('splits a reply into styled blocks, leaving prose and tables as markdown', () => {
    expect(parseReply(REPLY)).toEqual([
      { kind: 'markdown', text: 'Hecho. El panel ya agrupa el trabajo.' },
      { kind: 'heading', level: 2, text: 'Qué cambia' },
      {
        kind: 'list',
        isOrdered: false,
        items: [
          { marker: '-', text: 'El grupo empieza en el **primer** texto.\nsigue en la línea siguiente', depth: 0 },
          { marker: '-', text: 'Los tests cubren el thinking.', depth: 0 },
          { marker: '-', text: 'anidado', depth: 1 },
        ],
      },
      {
        kind: 'list',
        isOrdered: true,
        items: [
          { marker: '1.', text: 'Abre /hud', depth: 0 },
          { marker: '2.', text: 'Pulsa ▸', depth: 0 },
        ],
      },
      { kind: 'code', language: 'ts', source: 'const head = 1' },
      { kind: 'quote', lines: ['una cita'] },
      { kind: 'rule' },
      { kind: 'markdown', text: '| a | b |\n|---|---|\n| 1 | 2 |' },
    ])
  })

  test('keeps a code fence still being written as code', () => {
    expect(parseReply('Mira:\n```go\nfunc main() {')).toEqual([
      { kind: 'markdown', text: 'Mira:' },
      { kind: 'code', language: 'go', source: 'func main() {' },
    ])
  })

  test('draws headings, bullets and a highlighted code card; leaves thinking to the engine', async ($, on) => {
    on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    const mount = (text: string, isSummary?: true) =>
      $.ui.mount({
        plugin: 'orange-hud',
        surface: 'terminal',
        component: 'AssistantMessage',
        requestId: isSummary ? 's1' : 'a1',
        props: isSummary ? { text, isFirstOfReply: true, isSummary } : { text, isFirstOfReply: true },
      })

    const reply = await mount(REPLY)
    expect(await reply.find({ type: 'Text', text: /^●$/ })).toBeDefined()
    expect(await reply.find({ type: 'Text', text: /^◆ Qué cambia$/ })).toBeDefined()
    expect(await reply.findAll({ type: 'Text', text: /^•$/ })).toHaveLength(2)
    expect(await reply.find({ type: 'Text', text: /^◦$/ })).toBeDefined()
    expect(await reply.find({ type: 'Text', text: /^2$/ })).toBeDefined()
    const code = await reply.find({ type: 'Code' })
    expect(code?.props['language']).toBe('ts')
    expect(JSON.stringify(await reply.drawn())).toContain('"backgroundColor":"#262626"')
    expect(await reply.find({ text: 'engine' })).toBeUndefined()

    const thinking = await mount('pensando', true)
    expect(await thinking.find({ text: 'engine' })).toBeDefined()
  })
})
