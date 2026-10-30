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

function world(on: On) {
  const clock = mock.clock(on, { now: Date.parse('2026-01-01T00:00:00Z') })
  const state = {
    model: 'claude-sonnet-5-5',
    settings: {} as { effortLevel?: string; modelSettings?: Record<string, { effortLevel?: string }> },
    usage: { ...usage, cost: { usd: 1.5 } as { usd: number } | undefined },
    commands: 0,
    failModel: false,
    // null: detached HEAD; undefined: not a repository; 'missing': no git on PATH.
    branch: undefined as string | null | undefined | 'missing',
    gitCalls: 0,
  }
  on('process.run', ($, e) => {
    state.gitCalls++
    if (state.branch === 'missing') throw new Error('spawn git ENOENT')
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
  on('session.end', () => ({} as never))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [] } as never
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
  plugin: 'status-bar', surface: 'terminal', component: 'PromptHint', props,
})).drawn())
const step = async ($: Engine, effort: 'low' | 'high', agentId?: string) => {
  for await (const _ of $.turn.step({
    turnId: 't1', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, effort, agentId,
  })) void _
}

describe('prompt footer', () => {
  test('shows the git branch of the working copy', async ($, on) => {
    const { state } = world(on)
    state.branch = 'feature/status'
    await start($)
    expect(await drawn($)).toContain('7d 13% │ git feature/status')
  })

  test('shows a short commit for a detached HEAD', async ($, on) => {
    const { state } = world(on)
    state.branch = null
    await start($)
    expect(await drawn($)).toContain('git (a1b2c3d)')
  })

  test('shows no branch outside a repository or without git', async ($, on) => {
    const { state } = world(on)
    await start($)
    expect(await drawn($)).not.toContain('git ')
    state.branch = 'missing'
    await start($)
    const text = await drawn($)
    expect(text).toContain('Sonnet 5.5')
    expect(text).not.toContain('git ')
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
    expect(await drawn($)).toContain('git dev')
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

  test('preserves the footer drawn beneath the plugin', async ($, on) => {
    world(on)
    await $.prompt.submit({ text: 'hi' } as never)
    const text = await drawn($)
    expect(text).toContain('original footer')
    expect(text).toContain('Sonnet 5.5')
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
    const ui = await $.ui.mount({ plugin: 'status-bar', surface: 'terminal', component: 'PromptHint', props })

    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('? for shortcuts')
    expect(drawn).toContain('Sonnet 5.5')
    expect(drawn).toContain('5h 4%')
    expect(drawn).toContain('7d 13%')
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
    const ui = await $.ui.mount({ plugin: 'status-bar', surface: 'terminal', component: 'PromptHint', props })

    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain('Opus 5.5 │ max')
    expect(drawn).toContain('$1.50')
  })

  test('leaves the hint alone before any reading', async ($, on) => {
    on('ui.render', ($$, e) => {
      const { Text } = $$.ui.resolve(e)
      return <Text>{(e.props as { hint: string }).hint}</Text>
    })

    const ui = await $.ui.mount({ plugin: 'status-bar', surface: 'terminal', component: 'PromptHint', props })

    expect(JSON.stringify(await ui.drawn())).not.toContain('Sonnet')
  })
})
