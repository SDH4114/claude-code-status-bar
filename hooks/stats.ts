import { compact, modelName, money, tokenCost } from './format'
import type { Limit, Tokens } from './format'

// What one model did in one day: its responses and their tokens.
export type Counts = {
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  // Estimated at API list price; absent for a model the price table does not know.
  usd?: number
}

// One reading of a limit: when, which window, percent used, when that window resets.
export type Sample = [at: number, kind: string, percent: number, resetsAt: string]

// One session's record, saved as its own file so parallel sessions never write the same one.
export type Log = {
  v: 1
  // Local day (YYYY-MM-DD) → model name → counts.
  days: Record<string, Record<string, Counts>>
  limits: Sample[]
}

// Maps keyed by names read from files: a "__proto__" key must stay a plain key.
const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>

export const emptyLog = (): Log => ({ v: 1, days: dict(), limits: [] })

const pad2 = (n: number) => String(n).padStart(2, '0')

// The local calendar day of a moment.
export const dayOf = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

const countsOf = (v: unknown): Counts | undefined => {
  if (!isObject(v)) return undefined
  const { requests, input, output, cacheRead, cacheWrite, usd } = v
  if (![requests, input, output, cacheRead, cacheWrite].every(isCount)) return undefined
  const c = { requests, input, output, cacheRead, cacheWrite } as Counts
  if (isCount(usd)) c.usd = usd
  return c
}

const isSample = (v: unknown): v is Sample =>
  Array.isArray(v) &&
  v.length === 4 &&
  isCount(v[0]) &&
  typeof v[1] === 'string' &&
  isCount(v[2]) &&
  typeof v[3] === 'string'

// Reads a saved record, keeping only well-formed entries: a hand-edited or cut-off file loses
// its bad parts, not the whole report. Throws only when the text is not JSON.
export const parseLog = (text: string): Log => {
  const raw: unknown = JSON.parse(text)
  const log = emptyLog()
  if (!isObject(raw)) return log
  if (isObject(raw.days)) {
    for (const [day, models] of Object.entries(raw.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !isObject(models)) continue
      for (const [name, value] of Object.entries(models)) {
        const c = countsOf(value)
        if (c) (log.days[day] ??= dict())[name] = c
      }
    }
  }
  if (Array.isArray(raw.limits)) log.limits = raw.limits.filter(isSample)
  return log
}

const zero = (): Counts => ({ requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

const addInto = (to: Counts, from: Counts): void => {
  to.requests += from.requests
  to.input += from.input
  to.output += from.output
  to.cacheRead += from.cacheRead
  to.cacheWrite += from.cacheWrite
  if (from.usd !== undefined) to.usd = (to.usd ?? 0) + from.usd
}

// Counts one model response into the day it arrived on.
export const recordTokens = (log: Log, now: number, model: string, t: Tokens): void => {
  const day = (log.days[dayOf(now)] ??= dict())
  const name = modelName(model)
  const c = (day[name] ??= zero())
  addInto(c, {
    requests: 1,
    input: t.input_tokens,
    output: t.output_tokens,
    cacheRead: t.cache_read_input_tokens,
    cacheWrite: t.cache_creation_input_tokens,
    usd: tokenCost(model, t),
  })
}

const tracked = ['five_hour', 'seven_day']

// Notes a limit reading when it differs from the last one of its kind; true when one was added.
// A reading of a window that has already reset is an old response's, not news.
export const recordLimits = (log: Log, now: number, limits: readonly Limit[], last: Map<string, string>): boolean => {
  let added = false
  for (const l of limits) {
    if (!tracked.includes(l.kind)) continue
    const resets = l.resetsAt ? Date.parse(l.resetsAt) : NaN
    if (resets <= now) continue
    const key = `${l.percentUsed}|${l.resetsAt ?? ''}`
    if (last.get(l.kind) === key) continue
    last.set(l.kind, key)
    log.limits.push([now, l.kind, l.percentUsed, l.resetsAt ?? ''])
    added = true
  }
  return added
}

// How much of a limit a day used up, and the highest reading that day.
export type DayLimit = { used: number; peak: number }

export type DayStats = {
  day: string
  models: Record<string, Counts>
  limits: Record<string, DayLimit>
}

// Reset times of one window can differ by seconds between responses; windows are hours apart.
const sameWindowMs = 600_000

// Merges every session's record into days, newest first.
// A limit's use for a day is what its percent rose by over the readings that day, across
// windows: a newer window counts from 0. The very first reading only sets where it stands, and
// a reading behind the newest seen (an older window, or a lower percent of an unknown one) is a
// stale one from another session and counts for nothing.
export const aggregate = (logs: readonly Log[]): DayStats[] => {
  const days = new Map<string, DayStats>()
  const dayStats = (day: string): DayStats => {
    let d = days.get(day)
    if (!d) {
      d = { day, models: dict(), limits: dict() }
      days.set(day, d)
    }
    return d
  }
  for (const log of logs) {
    for (const [day, models] of Object.entries(log.days)) {
      const d = dayStats(day)
      for (const [name, c] of Object.entries(models)) addInto((d.models[name] ??= zero()), c)
    }
  }
  const samples = logs.flatMap(l => l.limits).sort((a, b) => a[0] - b[0])
  const state = new Map<string, { resets: number; max: number }>()
  for (const [at, kind, percent, resetsAt] of samples) {
    const resets = Date.parse(resetsAt)
    const prev = state.get(kind)
    let used = 0
    if (prev) {
      const known = !Number.isNaN(resets) && !Number.isNaN(prev.resets)
      const shift = known ? resets - prev.resets : 0
      if (shift < -sameWindowMs || (!known && percent < prev.max)) continue
      if (shift > sameWindowMs) {
        used = percent
        state.set(kind, { resets, max: percent })
      } else {
        used = Math.max(0, percent - prev.max)
        state.set(kind, { resets: Number.isNaN(resets) ? prev.resets : resets, max: Math.max(prev.max, percent) })
      }
    } else {
      state.set(kind, { resets, max: percent })
    }
    const l = (dayStats(dayOf(at)).limits[kind] ??= { used: 0, peak: 0 })
    l.used += used
    l.peak = Math.max(l.peak, percent)
  }
  return [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1))
}

const pct = (n: number) => `${Math.round(n * 10) / 10}%`

const limitText = (d: DayStats): string => {
  const parts: string[] = []
  const five = d.limits.five_hour
  const week = d.limits.seven_day
  if (five) parts.push(`5h +${pct(five.used)} (peak ${pct(five.peak)})`)
  if (week) parts.push(`week +${pct(week.used)} (peak ${pct(week.peak)})`)
  return parts.join(' · ')
}

// One table row's cells: the name, then the figures, each right-aligned in its column.
const cells = (name: string, c: Counts): string[] => [
  name,
  `${c.requests} req`,
  `in ${compact(c.input)}`,
  `out ${compact(c.output)}`,
  `cache r ${compact(c.cacheRead)}`,
  `w ${compact(c.cacheWrite)}`,
  c.usd === undefined ? '' : `≈${money(c.usd)}`,
]

const total = (models: Record<string, Counts>): Counts => {
  const t = zero()
  for (const c of Object.values(models)) addInto(t, c)
  return t
}

const byCost = (models: Record<string, Counts>) =>
  Object.entries(models).sort((a, b) => (b[1].usd ?? 0) - (a[1].usd ?? 0))

// The /usage-stats text: every recorded day newest first (or the last `limit` of them), then the total.
export const formatStats = (all: readonly DayStats[], limit?: number): string => {
  const days = limit ? all.slice(0, limit) : all
  if (days.length === 0) return 'No usage recorded yet: cc-status-bar counts responses from the moment it is installed.'
  // Lines are headings (strings) or table rows (cells), so every row can share column widths.
  const out: (string | string[])[] = []
  const sum = dict<Counts>()
  for (const d of days) {
    const head = limitText(d)
    out.push(head ? `${d.day} · ${head}` : d.day)
    const models = byCost(d.models)
    for (const [name, c] of models) {
      out.push(cells(name, c))
      addInto((sum[name] ??= zero()), c)
    }
    if (models.length > 1) out.push(cells('all', total(d.models)))
    out.push('')
  }
  const totals = byCost(sum)
  if (totals.length > 0) {
    const span = days.length === 1 ? days[0]!.day : `${days[days.length - 1]!.day} … ${days[0]!.day}`
    out.push(`Total ${span}`)
    for (const [name, c] of totals) out.push(cells(name, c))
    if (totals.length > 1) out.push(cells('all', total(sum)))
    out.push('')
  }
  out.push('≈$ at API list price (cache writes at the 5-minute rate). Limits: what the percent rose by that day.')
  const rows = out.filter((l): l is string[] => Array.isArray(l))
  const widths = (rows[0] ?? []).map((_, i) => Math.max(...rows.map(r => r[i]!.length)))
  return out
    .map(l =>
      typeof l === 'string' ? l : `  ${l.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!))).join('  ')}`.trimEnd(),
    )
    .join('\n')
}
