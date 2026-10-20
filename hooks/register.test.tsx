import { describe, expect, test } from 'claude-code/testing'

const usage = {
  startedAt: 0,
  context: { window: 200000, tokens: 14000, percent: 7 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 4 },
    { kind: 'seven_day', percentUsed: 13 },
  ],
}

const props = { isDraft: false, isWorking: false, hint: '? for shortcuts' }

describe('prompt footer', () => {
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
