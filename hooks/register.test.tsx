import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Limit } from './format'

const usage = {
  startedAt: 0,
  context: { window: 200000, tokens: 14000, percent: 7 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 4 },
    { kind: 'seven_day', percentUsed: 13 },
  ] as Limit[],
}

const props = { isDraft: false, isWorking: false, hint: '? for shortcuts' }

function world(on: On, now = Date.parse('2026-01-01T00:00:00Z')) {
  const clock = mock.clock(on, { now })
  const state = {
    model: 'claude-sonnet-5-5',
    settings: {} as { effortLevel?: string; modelSettings?: Record<string, { effortLevel?: string }> },
    usage: { ...usage, cost: { usd: 1.5 } as { usd: number } | undefined },
    commands: 0,
    failModel: false,
    // null: detached HEAD; undefined: not a repository; 'missing': no git on PATH.
    branch: undefined as string | null | undefined | 'missing',
    gitCalls: 0,
    // Branches of directories other than the session's, by cwd.
    dirs: {} as Record<string, string>,
    // What a step answers as usage.
    stepUsage: null as null | Record<string, number | string>,
    sessionId: 's1',
    // The file system the daily records go to, by absolute path.
    files: {} as Record<string, string>,
    // When each file was last written; one never written counts as written now.
    mtimes: {} as Record<string, number>,
    rm: 'ok' as 'ok' | 'missing' | 'fails',
    del: false,
    delCalls: [] as string[],
  }
  on('session.id', () => ({ value: state.sessionId }))
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.write', ($, e) => {
    state.files[e.path] = e.text
    state.mtimes[e.path] = clock.now()
    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    const text = state.files[e.path]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.exists', ($, e) => ({ value: e.path in state.files }))
  on('fs.list', ($, e) => {
    const now = clock.now()
    const value = Object.keys(state.files)
      .filter(f => f.startsWith(`${e.path}/`))
      .map(f => ({ name: f.slice(e.path.length + 1), kind: 'file' as const, size: 0, mtimeMs: state.mtimes[f] ?? now, isLink: false }))
    return { value }
  })
  on('process.run', ($, e) => {
    // rm: there (macOS, Linux), missing (Windows without Git's tools), or failing quietly.
    if (e.argv[0] === 'rm') {
      if (state.rm === 'missing') throw new Error('spawn rm ENOENT')
      if (state.rm === 'ok') delete state.files[e.argv[3]!]
      return { value: { exitCode: state.rm === 'ok' ? 0 : 1, stdout: '', stderr: '' } as never }
    }
    // PowerShell on Windows: the path, with backslashes, comes in the environment.
    if (e.argv[0] === 'powershell') {
      const path = e.init?.env?.CC_STATUS_BAR_FILE ?? ''
      state.delCalls.push(path)
      if (!state.del) throw new Error('spawn powershell ENOENT')
      delete state.files[path.replace(/\\/g, '/')]
      return { value: { exitCode: 0, stdout: '', stderr: '' } as never }
    }
    state.gitCalls++
    if (state.branch === 'missing') throw new Error('spawn git ENOENT')
    const dir = e.init?.cwd
    if (dir !== undefined) {
      const name = state.dirs[dir]
      if (e.argv[1] === 'symbolic-ref' && name) return { value: { exitCode: 0, stdout: `${name}\n`, stderr: '' } as never }
      return { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' } as never }
    }
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } as never })
    const fail = { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' } as never }
    if (e.argv[1] === 'symbolic-ref') return typeof state.branch === 'string' ? ok(`${state.branch}\r\n`) : fail
    return state.branch === null ? ok('a1b2c3d\n') : fail
  })
  on('session.model', () => {
    if (state.failModel) throw new Error('model unavailable')
    return { value: state.model }
  })
  on('session.usage', () => ({ value: state.usage }))
  on('settings.read', () => ({ value: state.settings as never }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('classic.SessionStart', () => ({}))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], usage: state.stepUsage } as never
  })
  on('command.run', () => {
    state.commands++
    return { text: 'done' }
  })
  on('prompt.submit', ($, e) => e)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{'original footer'}</Text>
  })
  return { state, clock }
}

const start = ($: Engine) => $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
const drawn = async ($: Engine) => JSON.stringify(await (await $.ui.mount({
  plugin: 'cc-status-bar', surface: 'terminal', component: 'PromptHint', props,
})).drawn())
const step = async ($: Engine, effort: 'low' | 'high', agentId?: string, model = 'claude-sonnet-5-5') => {
  for await (const _ of $.turn.step({
    turnId: 't1', index: 0, model, messageCount: 1, effort, agentId,
  })) void _
}
// Puts an agent's transcript (or, with none, the main one) on screen, as the tasks list does.
const view = async ($: Engine, agentId?: string) => {
  await $.ui.mount({
    plugin: 'cc-status-bar', surface: 'terminal', component: 'AbovePrompt',
    props: {
      hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80,
      scroll: { offset: 0, bodyRows: 10 }, view: agentId === undefined ? {} : { agentId },
    },
  } as never)
}
const tokens = (model: string, input: number, output: number) => ({
  model, input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
})

describe('prompt footer', () => {
  test('shows the git branch of the working copy', async ($, on) => {
    const { state } = world(on)
    state.branch = 'feature/status'
    await start($)
    expect(await drawn($)).toContain('│ 13% │ feature/status')
  })

  test('shows a short commit for a detached HEAD', async ($, on) => {
    const { state } = world(on)
    state.branch = null
    await start($)
    expect(await drawn($)).toContain('│ 13% │ (a1b2c3d)')
  })

  test('shows no branch outside a repository or without git', async ($, on) => {
    const { state } = world(on)
    await start($)
    expect(await drawn($)).toContain('│ 13%"')
    state.branch = 'missing'
    await start($)
    expect(await drawn($)).toContain('│ 13%"')
  })

  test('picks up a branch switch within a few seconds without running git every tick', async ($, on) => {
    const { state, clock } = world(on)
    state.branch = 'main'
    await start($)
    const calls = state.gitCalls
    state.branch = 'dev'
    await clock.advance(1000)
    expect(state.gitCalls).toBe(calls)
    await clock.advance(5000)
    expect(await drawn($)).toContain('│ dev')
  })

  test('keeps ticking when the first reading at session start fails', async ($, on) => {
    const { state, clock } = world(on)
    state.failModel = true
    await start($).catch(() => {})
    state.failModel = false
    await clock.advance(1000)
    expect(await drawn($)).toContain('Sonnet 5.5')
  })

  test('uses the current main turn baseline without letting a subagent replace it', async ($, on) => {
    const { state } = world(on)
    await $.turn.start({ turnId: 'main' } as never)
    state.usage.cost = { usd: 2 }
    await $.turn.start({ turnId: 'child', agentId: 'agent-1' } as never)
    await $.prompt.submit({ text: 'hi' } as never)
    expect(await drawn($)).toContain('$0.50 / $2.00')
  })

  test('does not reuse a previous baseline when a new turn has no cost reading', async ($, on) => {
    const { state } = world(on)
    await $.turn.start({ turnId: 'first' } as never)
    state.usage.cost = undefined
    await $.turn.start({ turnId: 'second' } as never)
    state.usage.cost = { usd: 2 }
    await $.prompt.submit({ text: 'hi' } as never)
    const text = await drawn($)
    expect(text).toContain('$2.00')
    expect(text).not.toContain('$0.50 /')
  })

  test('shows saved effort immediately at session start', async ($, on) => {
    const { state } = world(on)
    state.settings = { effortLevel: 'high' }
    await start($)
    expect(await drawn($)).toContain('Sonnet 5.5 │ high')
  })

  test('refreshes the reset countdown while idle', async ($, on) => {
    const { state, clock } = world(on)
    state.usage.rateLimits = [{ kind: 'five_hour', percentUsed: 4, resetsAt: '2026-01-01T01:00:00Z' }]
    await start($)
    await clock.advance(60_000)
    expect(await drawn($)).toContain('↻59m')
  })

  test('does not replace main effort with a subagent effort', async ($, on) => {
    world(on)
    await step($, 'high')
    await step($, 'low', 'agent-1')
    expect(await drawn($)).toContain('Sonnet 5.5 │ high')
  })

  test('clears previous effort when switching to an unconfigured model', async ($, on) => {
    const { state, clock } = world(on)
    await start($)
    await step($, 'high')
    state.model = 'claude-haiku-5-5'
    await clock.advance(1000)
    expect(await drawn($)).toContain('Haiku 5.5 │ ctx')
  })

  test('redraws a direct effort command even when settings have not changed', async ($, on) => {
    world(on)
    await start($)
    await $.command.run({ command: 'effort', args: 'low', origin: { kind: 'composer' } } as never)
    expect(await drawn($)).toContain('Sonnet 5.5 │ low')
  })

  test('keeps the hint and the status in one truncating row', async ($, on) => {
    world(on)
    await $.prompt.submit({ text: 'hi' } as never)
    const text = await drawn($)
    expect(text).toContain('? for shortcuts')
    expect(text).toContain('Sonnet 5.5')
    expect(text).toContain('truncate-end')
  })

  test('does not execute a command twice if its subsequent redraw fails', async ($, on) => {
    const { state } = world(on)
    state.failModel = true
    await $.command.run({ command: 'model', args: '', origin: { kind: 'composer' } } as never)
    expect(state.commands).toBe(1)
  })

  test('clears previous effort on a new session', async ($, on) => {
    world(on)
    await start($)
    await step($, 'high')
    await start($)
    expect(await drawn($)).toContain('Sonnet 5.5 │ ctx')
  })

  // /clear and /resume end the chat with session.end and start the next one with the classic SessionStart alone.
  const restart = async ($: Engine, source: 'clear' | 'resume') => {
    await $.session.end({ reason: source, sessionId: 's1', resume: {} } as never)
    await $.classic.SessionStart({ source })
  }

  test('redraws the footer right after /clear with the new chat clean', async ($, on) => {
    const { state } = world(on)
    state.settings = { effortLevel: 'medium' }
    await start($)
    await $.turn.start({ turnId: 't1' } as never)
    await step($, 'high')
    state.usage.cost = { usd: 0 }
    await restart($, 'clear')
    const text = await drawn($)
    expect(text).toContain('Sonnet 5.5 │ medium │ ctx')
    expect(text).toContain('│ $0.00 │')
  })

  test('keeps ticking after /clear and /resume', async ($, on) => {
    const { state, clock } = world(on)
    await start($)
    for (const source of ['clear', 'resume'] as const) {
      await restart($, source)
      state.model = source === 'clear' ? 'claude-opus-5-5' : 'claude-haiku-5-5'
      await clock.advance(1000)
      expect(await drawn($)).toContain(source === 'clear' ? 'Opus 5.5' : 'Haiku 5.5')
    }
  })

  test('stops ticking when the session really ends', async ($, on) => {
    const { state, clock } = world(on)
    await start($)
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: {} } as never)
    state.model = 'claude-opus-5-5'
    await clock.advance(5000)
    expect(await drawn($)).toContain('Sonnet 5.5')
  })

  test('adds a yellow status line after the hint once a prompt was sent', async ($, on) => {
    on('clock.now', () => ({ value: Date.parse('2026-01-01T00:00:00Z') }))
    on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
    on('session.usage', () => ({ value: usage }))
    on('prompt.submit', ($$, e) => e)
    on('ui.render', ($$, e) => {
      const { Text } = $$.ui.resolve(e)
      return <Text>{(e.props as { hint: string }).hint}</Text>
    })

    await $.prompt.submit({ text: 'hi' } as never)
    const ui = await $.ui.mount({ plugin: 'cc-status-bar', surface: 'terminal', component: 'PromptHint', props })

    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('? for shortcuts')
    expect(drawn).toContain('Sonnet 5.5')
    expect(drawn).toContain('│ 4% │ 13%')
    expect(drawn).toContain('warning')
  })

  test('shows the session cost and the effort saved for the model', async ($, on) => {
    on('clock.now', () => ({ value: Date.parse('2026-01-01T00:00:00Z') }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('session.usage', () => ({ value: { ...usage, cost: { usd: 1.5 } } }))
    on('settings.read', () => ({ value: { modelSettings: { 'claude-opus-5-5': { effortLevel: 'max' } } } as never }))
    on('command.run', () => ({ text: '' }))
    on('ui.render', ($$, e) => {
      const { Text } = $$.ui.resolve(e)
      return <Text>{(e.props as { hint: string }).hint}</Text>
    })

    await $.command.run({ command: 'effort', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'cc-status-bar', surface: 'terminal', component: 'PromptHint', props })

    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('Opus 5.5 │ max')
    expect(drawn).toContain('$1.50')
  })

  test('shows the viewed agent its own model, effort, context and cost', async ($, on) => {
    const { state, clock } = world(on)
    await start($)
    await step($, 'high')
    // 30k in, 10k out on Opus 5.5: 30000 * 4 / 1e6 + 10000 * 20 / 1e6 = $0.32
    state.stepUsage = tokens('claude-opus-5-5', 30_000, 10_000)
    await $.turn.start({ turnId: 'a', agentId: 'agent-1' } as never)
    await step($, 'low', 'agent-1', 'claude-opus-5-5')
    await view($, 'agent-1')
    await clock.advance(1000)
    const text = await drawn($)
    // The account's limits stay on the main line only.
    expect(text).toContain('Opus 5.5 │ low │ ctx 30k │ ≈$0.32 / $0.32"')
    expect(text).not.toContain('4%')
    expect(text).not.toContain('Sonnet')
  })

  test('goes back to the session line when the main conversation is viewed', async ($, on) => {
    const { state, clock } = world(on)
    await start($)
    await step($, 'high')
    state.stepUsage = tokens('claude-opus-5-5', 30_000, 10_000)
    await step($, 'low', 'agent-1', 'claude-opus-5-5')
    await view($, 'agent-1')
    await clock.advance(1000)
    await view($)
    await clock.advance(1000)
    expect(await drawn($)).toContain('Sonnet 5.5 │ high │ ctx 14k/200k 7% │ $1.50')
  })

  test('keeps two agents apart', async ($, on) => {
    const { state, clock } = world(on)
    await start($)
    state.stepUsage = tokens('claude-sonnet-5-5', 50_000, 0)
    await step($, 'high', 'a1')
    state.stepUsage = tokens('claude-haiku-5-5', 2_000, 0)
    await step($, 'low', 'a2', 'claude-haiku-5-5')
    await view($, 'a1')
    await clock.advance(1000)
    // Same model as the session: its window is known.
    expect(await drawn($)).toContain('Sonnet 5.5 │ high │ ctx 50k/200k 25% │ ≈$0.10')
    await view($, 'a2')
    await clock.advance(1000)
    expect(await drawn($)).toContain('Haiku 5.5 │ low │ ctx 2k │ ≈<$0.01')
  })

  test('counts an agent turn apart from its earlier ones', async ($, on) => {
    const { state, clock } = world(on)
    await start($)
    state.stepUsage = tokens('claude-sonnet-5-5', 0, 100_000) // $1.00
    await $.turn.start({ turnId: 'a', agentId: 'a1' } as never)
    await step($, 'high', 'a1')
    state.stepUsage = tokens('claude-sonnet-5-5', 0, 50_000) // $0.50
    await $.turn.start({ turnId: 'b', agentId: 'a1' } as never)
    await step($, 'high', 'a1')
    await view($, 'a1')
    await clock.advance(1000)
    expect(await drawn($)).toContain('≈$0.50 / $1.50')
  })

  test('names the agent and shows the branch of its own directory', async ($, on) => {
    const { state, clock } = world(on)
    state.branch = 'main'
    state.dirs['/wt/scout'] = 'feat/scout'
    on('agent.spawn', () => ({ agentId: 'a1', model: 'claude-sonnet-5-5' }))
    await start($)
    await $.agent.spawn({ prompt: 'look', description: 'Scan repo', name: 'scout', cwd: '/wt/scout' } as never)
    await step($, 'high', 'a1')
    await view($, 'a1')
    await clock.advance(1000)
    await clock.advance(1000)
    const text = await drawn($)
    expect(text).toContain('scout │ Sonnet 5.5 │ high')
    expect(text).toContain('│ feat/scout')
    await view($)
    await clock.advance(1000)
    expect(await drawn($)).toContain('│ main')
  })

  test('leaves the hint alone before any reading', async ($, on) => {
    on('ui.render', ($$, e) => {
      const { Text } = $$.ui.resolve(e)
      return <Text>{(e.props as { hint: string }).hint}</Text>
    })

    const ui = await $.ui.mount({ plugin: 'cc-status-bar', surface: 'terminal', component: 'PromptHint', props })

    expect(JSON.stringify(await ui.drawn())).not.toContain('Sonnet')
  })
})

describe('usage stats', () => {
  const dir = '/home/me/.claude/cc-status-bar/usage'
  // Midday UTC: the same local date in nearly every time zone.
  const noon = Date.parse('2026-01-01T12:00:00Z')
  const stats = async ($: Engine, args = '') => (await $.command.run({ command: 'usage-stats', args } as never)).text ?? ''

  test('counts the session and its agents per model for the day', async ($, on) => {
    const { state } = world(on, noon)
    await start($)
    state.stepUsage = tokens('claude-sonnet-5-5', 1000, 500)
    await step($, 'high')
    await step($, 'high')
    state.stepUsage = tokens('claude-opus-5-5', 30_000, 10_000)
    await step($, 'low', 'agent-1', 'claude-opus-5-5')
    const text = await stats($, 'today')
    expect(text).toContain('Thu 1 Jan 2026')
    expect(text).toMatch(/model +req +input +output +cache +cost\n/)
    expect(text).toMatch(/Opus 5\.5 +1 +30k +10k +0 +\$0\.32\n/)
    expect(text).toMatch(/Sonnet 5\.5 +2 +2k +1k +0 +\$0\.01\n/)
    expect(text).toMatch(/total +3 +32k +11k +0 +\$0\.33\n/)
    expect(text).not.toContain('share')
    const overview = await stats($)
    expect(overview.split('\n')[0]).toBe('Usage by day')
    expect(overview).toMatch(/Thu 1 Jan +3 +32k +11k +0 +\$0\.33/)
    expect(Object.keys(state.files).filter(f => f.endsWith('.json'))).toEqual([`${dir}/s1-${noon}.json`])
  })

  test('adds up the limit a day used across readings and a new window', async ($, on) => {
    const { state, clock } = world(on, noon)
    const r5 = '2026-01-01T15:00:00Z'
    const set = (five: number, week: number, reset = r5) => {
      state.usage = { ...state.usage, rateLimits: [
        { kind: 'five_hour', percentUsed: five, resetsAt: reset },
        { kind: 'seven_day', percentUsed: week, resetsAt: '2026-01-05T00:00:00Z' },
      ] }
    }
    set(10, 20)
    await start($)
    set(25, 22)
    await clock.advance(1000)
    // A new 5-hour window counts from 0.
    set(5, 23, '2026-01-01T20:00:00Z')
    await clock.advance(1000)
    expect(await stats($)).toMatch(/Thu 1 Jan .* \+20% +\+3%/)
    const day = await stats($, '2026-01-01')
    // The first window rose from 10 to 25, the next one from 0 to 5.
    expect(day).toMatch(/5h limit +used +max/)
    expect(day).toMatch(/\d\d:00 – \d\d:00 +\+15% +25%\n.*\+5% +5%/)
    expect(day).toMatch(/week \(resets Mon 5 Jan\) +\+3% +23%/)
  })

  test('merges the files of several sessions and keeps a resumed one', async ($, on) => {
    const { state } = world(on, noon)
    state.files[`${dir}/old.json`] = JSON.stringify({ v: 1, limits: [], days: {
      '2025-12-31': { 'Haiku 5.5': { requests: 4, input: 100, output: 50, cacheRead: 0, cacheWrite: 0, usd: 0.01 } },
    } })
    state.files[`${dir}/s1.json`] = JSON.stringify({ v: 1, limits: [], days: {
      '2026-01-01': { 'Sonnet 5.5': { requests: 1, input: 10, output: 10, cacheRead: 0, cacheWrite: 0, usd: 0.0001 } },
    } })
    state.files[`${dir}/broken.json`] = '{'
    await start($)
    state.stepUsage = tokens('claude-sonnet-5-5', 10, 10)
    await step($, 'high')
    const text = await stats($)
    expect(text).toMatch(/Thu 1 Jan +2 [^]*Wed 31 Dec 2025 +4 /)
    expect(text).toMatch(/avg \/ day +3 /)
    expect(text).toMatch(/total \(2 days\) +6 /)
    expect(await stats($, '1')).not.toContain('Dec')
  })

  test('says so when nothing is recorded', async ($, on) => {
    const { state } = world(on, noon)
    state.usage = { ...state.usage, rateLimits: [] }
    await start($)
    expect(await stats($)).toContain('No usage recorded yet')
  })

  test('counts nothing for a stale reading of an older window from another session', async ($, on) => {
    const { state } = world(on, noon)
    const sample = (h: number, percent: number, resets: string) =>
      [noon + h * 3_600_000, 'five_hour', percent, resets]
    // A: 80% of the window ending 13:00. B: the next window. A again, after /clear: its stale 80%.
    state.files[`${dir}/a.json`] = JSON.stringify({ v: 1, days: {}, limits: [
      sample(-3, 70, '2026-01-01T13:00:00Z'), sample(-2, 80, '2026-01-01T13:00:00Z'),
      sample(1.5, 80, '2026-01-01T13:00:00Z'),
    ] })
    state.files[`${dir}/b.json`] = JSON.stringify({ v: 1, days: {}, limits: [
      sample(1, 5, '2026-01-01T18:00:00Z'), sample(2, 10, '2026-01-01T18:00:00Z'),
    ] })
    state.usage = { ...state.usage, rateLimits: [] }
    await start($)
    // +10 to 80, then a new window from 0 to 10.
    expect(await stats($)).toMatch(/Thu 1 Jan .* \+20% +—/)
    expect(await stats($, 'today')).toMatch(/\+10% +80%\n.*\+10% +10%/)
  })

  test('takes a reset time a few seconds off as the same window', async ($, on) => {
    const { state } = world(on, noon)
    state.files[`${dir}/a.json`] = JSON.stringify({ v: 1, days: {}, limits: [
      [noon, 'seven_day', 40, '2026-01-05T00:04:59Z'],
      [noon + 1, 'seven_day', 41, '2026-01-05T00:05:01Z'],
      [noon + 2, 'seven_day', 42, '2026-01-05T00:04:59Z'],
    ] })
    state.usage = { ...state.usage, rateLimits: [] }
    await start($)
    expect(await stats($)).toMatch(/Thu 1 Jan .* — +\+2%/)
    expect(await stats($, 'today')).toMatch(/week \(resets Mon 5 Jan\) +\+2% +42%/)
  })

  test('does not record a reading of a window that has already reset', async ($, on) => {
    const { state } = world(on, noon)
    state.usage = { ...state.usage, rateLimits: [{ kind: 'five_hour', percentUsed: 80, resetsAt: '2026-01-01T11:00:00Z' }] }
    await start($)
    expect(await stats($)).toContain('No usage recorded yet')
  })

  test('keeps the good parts of a damaged file', async ($, on) => {
    const { state } = world(on, noon)
    state.files[`${dir}/bad.json`] = JSON.stringify({ v: 1,
      days: {
        '2026-01-01': { 'Opus 5.5': { requests: 2, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, __proto__x: 5, Junk: {} },
        'not a day': {}, '2025-12-30': null,
      },
      limits: [null, 5, ['x'], [noon, 'five_hour', 'ten', '']],
    })
    state.files[`${dir}/null.json`] = 'null'
    state.usage = { ...state.usage, rateLimits: [] }
    await start($)
    const text = await stats($, 'today')
    expect(text).toMatch(/Opus 5\.5 +2 /)
    expect(text).not.toContain('NaN')
    expect(text).not.toContain('Junk')
    expect(({} as Record<string, unknown>).requests).toBeUndefined()
  })

  test('lines the columns up for any size of number', async ($, on) => {
    const { state } = world(on, noon)
    state.files[`${dir}/a.json`] = JSON.stringify({ v: 1, limits: [], days: { '2026-01-01': {
      'Opus 5.5': { requests: 123456, input: 123_456_789, output: 5, cacheRead: 0, cacheWrite: 0, usd: 1 },
      'Sonnet 5.5': { requests: 1, input: 1, output: 123_456_789, cacheRead: 0, cacheWrite: 0, usd: 0.5 },
    } } })
    state.usage = { ...state.usage, rateLimits: [] }
    await start($)
    const lines = (await stats($, 'today')).split('\n')
    const head = lines.find(l => l.includes('output'))!
    const rows = lines.filter(l => /^  (Opus|Sonnet|total)/.test(l))
    expect(rows).toHaveLength(3)
    // Every figure ends where its heading ends.
    for (const word of ['req', 'input', 'output', 'cache', 'cost']) {
      const end = head.indexOf(word) + word.length
      for (const r of rows) expect([r[end - 1] !== ' ', r[end] ?? ' ']).toEqual([true, ' '])
    }
  })

  test('gives every run of a chat a file of its own and counts them all', async ($, on) => {
    const { state, clock } = world(on, noon)
    state.files[`${dir}/s2.json`] = JSON.stringify({ v: 1, limits: [], days: {
      '2026-01-01': { 'Sonnet 5.5': { requests: 5, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    } })
    await start($)
    state.stepUsage = tokens('claude-sonnet-5-5', 10, 10)
    await step($, 'high')
    await $.session.end({ reason: 'resume', sessionId: 's1', resume: {} } as never)
    await clock.advance(1000)
    state.sessionId = 's2'
    await $.classic.SessionStart({ source: 'resume' } as never)
    await step($, 'high')
    const text = await stats($)
    const requests = (f: string) => JSON.parse(state.files[`${dir}/${f}`]!).days['2026-01-01']['Sonnet 5.5'].requests
    expect(requests(`s1-${noon}.json`)).toBe(1)
    expect(requests(`s2-${noon + 1000}.json`)).toBe(1)
    expect(requests('s2.json')).toBe(5)
    expect(text).toMatch(/Thu 1 Jan +7 /)
  })

  test('goes on in a new file when a tidy-up took its file away', async ($, on) => {
    const { state, clock } = world(on, noon)
    await start($)
    state.stepUsage = tokens('claude-sonnet-5-5', 10, 10)
    await step($, 'high')
    await stats($)
    // What it held is in a month file now.
    delete state.files[`${dir}/s1-${noon}.json`]
    await clock.advance(1000)
    await step($, 'high')
    await stats($)
    expect(state.files[`${dir}/s1-${noon}.json`]).toBeUndefined()
    const file = JSON.parse(state.files[`${dir}/s1-${noon + 1000}.json`]!)
    expect(file.days['2026-01-01']['Sonnet 5.5'].requests).toBe(1)
  })

  const day = (date: string, requests: number) =>
    ({ [date]: { 'Haiku 5.5': { requests, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } })
  const twoDaysAgo = noon - 2 * 86_400_000

  test('merges files older than a day into their months and drops months past half a year', async ($, on) => {
    const { state, clock } = world(on, noon)
    state.files[`${dir}/a.json`] = JSON.stringify({ v: 1, limits: [[twoDaysAgo, 'seven_day', 10, '']], days: day('2025-12-30', 2) })
    state.files[`${dir}/b.json`] = JSON.stringify({ v: 1, limits: [], days: { ...day('2025-12-31', 3), ...day('2026-01-01', 4) } })
    state.files[`${dir}/2025-12.json`] = JSON.stringify({ v: 1, limits: [], days: day('2025-12-01', 1) })
    state.files[`${dir}/2025-01.json`] = JSON.stringify({ v: 1, limits: [], days: day('2025-01-15', 9) })
    state.files[`${dir}/recent.json`] = JSON.stringify({ v: 1, limits: [], days: day('2026-01-01', 5) })
    for (const f of ['a', 'b', '2025-12', '2025-01']) state.mtimes[`${dir}/${f}.json`] = twoDaysAgo
    state.usage = { ...state.usage, rateLimits: [] }
    await start($)
    await clock.advance(1000)
    const names = Object.keys(state.files).map(f => f.slice(dir.length + 1)).sort()
    expect(names).toEqual(['2025-12.json', '2026-01.json', 'recent.json', 'tidy.lock'])
    const dec = JSON.parse(state.files[`${dir}/2025-12.json`]!)
    expect(Object.keys(dec.days).sort()).toEqual(['2025-12-01', '2025-12-30', '2025-12-31'])
    expect(dec.limits).toHaveLength(1)
    expect(dec.merged).toBeUndefined()
    const text = await stats($)
    expect(text).toMatch(/Thu 1 Jan +9 [^]*Wed 31 Dec 2025 +3 [^]*Tue 30 Dec 2025 +2 [^]*Mon 1 Dec 2025 +1 /)
    expect(text).not.toContain('Jan 2025')
  })

  test('counts a merged file once when it could not be deleted', async ($, on) => {
    const { state, clock } = world(on, noon)
    state.rm = 'missing'
    state.files[`${dir}/a.json`] = JSON.stringify({ v: 1, limits: [], days: day('2025-12-30', 2) })
    state.mtimes[`${dir}/a.json`] = twoDaysAgo
    state.usage = { ...state.usage, rateLimits: [] }
    await start($)
    await clock.advance(1000)
    expect(state.files[`${dir}/a.json`]).toBeDefined()
    expect(JSON.parse(state.files[`${dir}/2025-12.json`]!).merged).toEqual(['a.json'])
    const text = await stats($)
    expect(text).toMatch(/Tue 30 Dec 2025 +2 /)
    expect(text).toContain(`Could not delete old usage records (1). Delete them by hand from:\n    ${dir}\n    a.json`)
  })

  test('deletes with PowerShell on Windows, where there is no rm', async ($, on) => {
    const { state, clock } = world(on, noon)
    state.rm = 'missing'
    state.del = true
    state.files[`${dir}/a.json`] = JSON.stringify({ v: 1, limits: [], days: day('2025-12-30', 2) })
    state.mtimes[`${dir}/a.json`] = twoDaysAgo
    state.usage = { ...state.usage, rateLimits: [] }
    await start($)
    await clock.advance(1000)
    expect(state.delCalls).toEqual(['\\home\\me\\.claude\\cc-status-bar\\usage\\a.json'])
    expect(state.files[`${dir}/a.json`]).toBeUndefined()
    expect(await stats($)).not.toContain('Could not delete')
  })

  test('tries PowerShell when rm leaves the file there', async ($, on) => {
    const { state, clock } = world(on, noon)
    state.rm = 'fails'
    state.del = true
    state.files[`${dir}/a.json`] = JSON.stringify({ v: 1, limits: [], days: day('2025-12-30', 2) })
    state.mtimes[`${dir}/a.json`] = twoDaysAgo
    state.usage = { ...state.usage, rateLimits: [] }
    await start($)
    await clock.advance(1000)
    expect(state.delCalls).toEqual(['\\home\\me\\.claude\\cc-status-bar\\usage\\a.json'])
    expect(state.files[`${dir}/a.json`]).toBeUndefined()
    expect(await stats($)).not.toContain('Could not delete')
  })

  // Two runs of the tidy-up: the lock is set back, as six hours later.
  const tidyAgain = async ($: Engine, state: ReturnType<typeof world>['state'], clock: ReturnType<typeof world>['clock']) => {
    delete state.files[`${dir}/tidy.lock`]
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as never)
    await $.classic.SessionStart({ source: 'clear' } as never)
    await clock.advance(1000)
  }

  test('does not merge a file again when deleting it failed', async ($, on) => {
    const { state, clock } = world(on, noon)
    state.rm = 'fails'
    state.files[`${dir}/a.json`] = JSON.stringify({ v: 1, limits: [], days: day('2025-12-30', 2) })
    state.mtimes[`${dir}/a.json`] = twoDaysAgo
    state.usage = { ...state.usage, rateLimits: [] }
    await start($)
    await clock.advance(1000)
    await tidyAgain($, state, clock)
    const dec = JSON.parse(state.files[`${dir}/2025-12.json`]!)
    expect(dec.days['2025-12-30']['Haiku 5.5'].requests).toBe(2)
    expect(dec.merged).toEqual(['a.json'])
    expect(await stats($, '2025-12-30')).toMatch(/Haiku 5\.5 +2 /)
  })

  test('counts a file in two months once each when only one month could be written', async ($, on) => {
    const { state, clock } = world(on, noon)
    state.files[`${dir}/b.json`] = JSON.stringify({ v: 1, limits: [], days: { ...day('2025-12-31', 3), ...day('2026-01-01', 4) } })
    state.mtimes[`${dir}/b.json`] = twoDaysAgo
    // The January file cannot be read, so January cannot take its part.
    state.files[`${dir}/2026-01.json`] = '{cut off'
    state.usage = { ...state.usage, rateLimits: [] }
    await start($)
    await clock.advance(1000)
    expect(state.files[`${dir}/b.json`]).toBeDefined()
    expect(JSON.parse(state.files[`${dir}/2025-12.json`]!).merged).toEqual(['b.json'])
    const text = await stats($)
    expect(text).toMatch(/Thu 1 Jan +4 [^]*Wed 31 Dec 2025 +3 /)
    expect(text).not.toContain('Could not delete')
    // January readable again: the next tidy-up adds only January's part.
    state.files[`${dir}/2026-01.json`] = JSON.stringify({ v: 1, limits: [], days: {} })
    await tidyAgain($, state, clock)
    expect(state.files[`${dir}/b.json`]).toBeUndefined()
    expect(await stats($)).toMatch(/Thu 1 Jan +4 [^]*Wed 31 Dec 2025 +3 /)
  })

  test('goes on in a new file after 20 idle hours, before a tidy-up may take the old one', async ($, on) => {
    const { state, clock } = world(on, noon)
    await start($)
    state.stepUsage = tokens('claude-sonnet-5-5', 10, 10)
    await step($, 'high')
    await stats($)
    // The ticker stopped, so the clock can jump 21 hours without 75,000 ticks.
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: {} } as never)
    await clock.advance(21 * 3_600_000)
    await step($, 'high')
    await stats($)
    const file = (t: number) => JSON.parse(state.files[`${dir}/s1-${t}.json`]!).days
    expect(Object.keys(state.files).filter(f => /s1-\d+\.json$/.test(f))).toHaveLength(2)
    expect(file(noon)['2026-01-01']['Sonnet 5.5'].requests).toBe(1)
  })

  test('leaves alone files it did not write', async ($, on) => {
    const { state, clock } = world(on, noon)
    state.files[`${dir}/notes&x.json`] = JSON.stringify({ v: 1, limits: [], days: day('2025-12-30', 2) })
    state.mtimes[`${dir}/notes&x.json`] = twoDaysAgo
    await start($)
    await clock.advance(1000)
    expect(state.files[`${dir}/notes&x.json`]).toBeDefined()
    expect(state.files[`${dir}/2025-12.json`]).toBeUndefined()
    expect(await stats($)).not.toContain('Dec')
  })

  test('keeps the last 6 months', async ($, on) => {
    const { state, clock } = world(on, noon)
    state.files[`${dir}/2025-07.json`] = JSON.stringify({ v: 1, limits: [], days: day('2025-07-31', 1) })
    state.files[`${dir}/2025-08.json`] = JSON.stringify({ v: 1, limits: [], days: day('2025-08-01', 1) })
    await start($)
    await clock.advance(1000)
    expect(state.files[`${dir}/2025-07.json`]).toBeUndefined()
    expect(await stats($)).toContain('Fri 1 Aug 2025')
  })

  test('names the expired months it could not delete, five at most', async ($, on) => {
    const { state, clock } = world(on, noon)
    state.rm = 'fails'
    for (let m = 1; m <= 7; m++) {
      state.files[`${dir}/2025-0${m}.json`] = JSON.stringify({ v: 1, limits: [], days: day(`2025-0${m}-10`, 1) })
    }
    await start($)
    await clock.advance(1000)
    const text = await stats($)
    expect(text).toContain('Could not delete old usage records (7)')
    expect(text).toContain('    2025-05.json\n    … and 2 more')
    expect(text).not.toContain('2025-06.json')
  })

  test('tidies up at most every 6 hours', async ($, on) => {
    const { state, clock } = world(on, noon)
    state.files[`${dir}/tidy.lock`] = JSON.stringify({ at: noon - 3_600_000, token: 'other' })
    state.files[`${dir}/a.json`] = JSON.stringify({ v: 1, limits: [], days: day('2025-12-30', 2) })
    state.mtimes[`${dir}/a.json`] = twoDaysAgo
    await start($)
    await clock.advance(1000)
    expect(state.files[`${dir}/a.json`]).toBeDefined()
    expect(state.files[`${dir}/2025-12.json`]).toBeUndefined()
  })

  test('leaves a month alone, and what would go in it, when the month cannot be read', async ($, on) => {
    const { state, clock } = world(on, noon)
    state.files[`${dir}/2025-12.json`] = '{cut off'
    state.files[`${dir}/a.json`] = JSON.stringify({ v: 1, limits: [], days: day('2025-12-30', 2) })
    for (const f of ['a', '2025-12']) state.mtimes[`${dir}/${f}.json`] = twoDaysAgo
    await start($)
    await clock.advance(1000)
    expect(state.files[`${dir}/2025-12.json`]).toBe('{cut off')
    expect(state.files[`${dir}/a.json`]).toBeDefined()
  })

  test('reads a bad day count as all days', async ($, on) => {
    const { state } = world(on, noon)
    state.files[`${dir}/a.json`] = JSON.stringify({ v: 1, limits: [], days: {
      '2025-12-30': { 'Haiku 5.5': { requests: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      '2025-12-31': { 'Haiku 5.5': { requests: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    } })
    state.usage = { ...state.usage, rateLimits: [] }
    await start($)
    for (const arg of ['abc', '0', '-3']) expect(await stats($, arg)).toContain('Tue 30 Dec 2025')
    expect(await stats($, '1')).not.toContain('Tue 30 Dec')
    expect(await stats($, '2025-12-30')).toContain('Tue 30 Dec 2025')
    expect(await stats($, '12-29')).toContain('Nothing recorded on 2026-12-29')
    expect(await stats($, 'yesterday')).toContain('Wed 31 Dec 2025')
    expect(await stats($)).not.toContain('cache   ')
    const help = await stats($, ' HELP ')
    expect(help).toMatch(/cache +the earlier conversation/)
    expect(help).not.toContain('Dec')
  })
})
