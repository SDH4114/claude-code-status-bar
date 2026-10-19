import { describe, expect, test } from 'claude-code/testing'

import { compact, formatLine, modelName, until } from './format'

describe('modelName', () => {
  test('prettifies ids', () => {
    expect(modelName('claude-sonnet-5-5')).toBe('Sonnet 5.5')
    expect(modelName('claude-opus-4')).toBe('Opus 4')
    expect(modelName('claude-fable-5-1')).toBe('Fable 5.1')
  })
  test('ignores a date suffix', () => {
    expect(modelName('claude-opus-4-20250514')).toBe('Opus 4')
  })
  test('falls back to the raw id', () => {
    expect(modelName('claude-weird')).toBe('weird')
  })
})

describe('until', () => {
  const now = Date.parse('2026-01-01T00:00:00Z')
  test('formats minutes, hours and days', () => {
    expect(until('2026-01-01T00:30:00Z', now)).toBe(' ↻30m')
    expect(until('2026-01-01T02:10:00Z', now)).toBe(' ↻2h10m')
    expect(until('2026-01-04T04:00:00Z', now)).toBe(' ↻3d4h')
  })
  test('is empty for a past, missing or bad time', () => {
    expect(until('2025-12-31T00:00:00Z', now)).toBe('')
    expect(until(undefined, now)).toBe('')
    expect(until('nope', now)).toBe('')
  })
})

describe('compact', () => {
  test('shortens token counts', () => {
    expect(compact(950)).toBe('950')
    expect(compact(14000)).toBe('14k')
    expect(compact(200000)).toBe('200k')
    expect(compact(1000000)).toBe('1M')
    expect(compact(1500000)).toBe('1.5M')
  })
})

describe('formatLine', () => {
  const now = Date.parse('2026-01-01T00:00:00Z')
  test('shows model, effort, context tokens and both limits', () => {
    const text = formatLine(
      'claude-sonnet-5-5',
      'high',
      { tokens: 14000, window: 200000, percent: 7 },
      [
        { kind: 'five_hour', percentUsed: 4, resetsAt: '2026-01-01T01:00:00Z' },
        { kind: 'seven_day', percentUsed: 13.4 },
        { kind: 'spend_limit', percentUsed: 90 },
      ],
      now,
    )
    expect(text).toBe('Sonnet 5.5 │ high │ ctx 14k/200k 7% │ 5h 4% ↻1h0m │ 7d 13%')
  })
  test('skips effort when unknown and shows a dash before the first response', () => {
    expect(formatLine('claude-opus-4', '', { window: 200000 }, [], now)).toBe('Opus 4 │ ctx –/200k')
  })
})
