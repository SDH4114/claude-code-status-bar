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

// One session's record, saved as its own file so parallel sessions never write the same one,
// or one month's (YYYY-MM.json), where session files older than a day are merged.
export type Log = {
  v: 1
  // Local day (YYYY-MM-DD) → model name → counts.
  days: Record<string, Record<string, Counts>>
  limits: Sample[]
  // A month's: the session files merged into it. Such a file still on disk (its delete failed)
  // is already counted here and is skipped.
  merged?: string[]
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
  if (Array.isArray(raw.merged)) {
    const names = raw.merged.filter((n): n is string => typeof n === 'string')
    if (names.length > 0) log.merged = names
  }
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

// Adds one record's days and limit readings to another's.
export const mergeLog = (into: Log, from: Log): void => {
  for (const [day, models] of Object.entries(from.days)) {
    const d = (into.days[day] ??= dict())
    for (const [name, c] of Object.entries(models)) addInto((d[name] ??= zero()), c)
  }
  into.limits.push(...from.limits)
}

export const isEmptyLog = (log: Log): boolean => Object.keys(log.days).length === 0 && log.limits.length === 0

// A record cut by month (YYYY-MM): days by their date, limit readings by when they were taken.
export const byMonth = (log: Log): Map<string, Log> => {
  const months = new Map<string, Log>()
  const month = (m: string) => {
    let l = months.get(m)
    if (!l) {
      l = emptyLog()
      months.set(m, l)
    }
    return l
  }
  for (const [day, models] of Object.entries(log.days)) month(day.slice(0, 7)).days[day] = models
  for (const s of log.limits) month(dayOf(s[0]).slice(0, 7)).limits.push(s)
  return months
}

export const monthFile = /^(\d{4}-\d{2})\.json$/

// The month `back` months before the one `now` falls in, as YYYY-MM.
export const monthBefore = (now: number, back: number): string => {
  const d = new Date(now)
  const total = d.getFullYear() * 12 + d.getMonth() - back
  return `${Math.floor(total / 12)}-${pad2((total % 12) + 1)}`
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

// One limit window's share of a day: what it rose by that day and its highest reading.
// resets is NaN for a window the API gave no reset time for.
export type Window = { resets: number; used: number; peak: number }

// How much of a limit a day used up, its highest reading, and the windows it fell in.
export type DayLimit = { used: number; peak: number; windows: Window[] }

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
  // resets is the window's first-seen reset time, so a few seconds of drift keep one window.
  const state = new Map<string, { resets: number; max: number }>()
  for (const [at, kind, percent, resetsAt] of samples) {
    const resets = Date.parse(resetsAt)
    const prev = state.get(kind)
    let used = 0
    let current = { resets, max: percent }
    if (prev) {
      const known = !Number.isNaN(resets) && !Number.isNaN(prev.resets)
      const shift = known ? resets - prev.resets : 0
      if (shift < -sameWindowMs || (!known && percent < prev.max)) continue
      if (shift > sameWindowMs) {
        used = percent
      } else {
        used = Math.max(0, percent - prev.max)
        current = { resets: Number.isNaN(prev.resets) ? resets : prev.resets, max: Math.max(prev.max, percent) }
      }
    }
    state.set(kind, current)
    const l = (dayStats(dayOf(at)).limits[kind] ??= { used: 0, peak: 0, windows: [] })
    l.used += used
    l.peak = Math.max(l.peak, percent)
    let w = l.windows.find(x => Object.is(x.resets, current.resets))
    if (!w) {
      w = { resets: current.resets, used: 0, peak: 0 }
      l.windows.push(w)
    }
    w.used += used
    w.peak = Math.max(w.peak, percent)
  }
  return [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1))
}

// ---- The /usage-stats text ----

const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// "Thu 12 Nov", with the year when asked for or when it is not this year's.
const dateText = (day: string, thisYear: number, withYear = false): string => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  const weekday = weekdays[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
  const text = `${weekday} ${d} ${months[m - 1]}`
  return withYear || y !== thisYear ? `${text} ${y}` : text
}

const pad2h = (n: number) => String(n).padStart(2, '0')
const clock = (ms: number) => {
  const t = new Date(ms)
  return `${pad2h(t.getHours())}:${pad2h(t.getMinutes())}`
}

const pct = (n: number) => `${Math.round(n * 10) / 10}%`
const plus = (n: number | undefined) => (n === undefined ? '—' : `+${pct(n)}`)
const cost = (usd: number | undefined) => (usd === undefined ? '—' : money(usd))
// New tokens sent: uncached input and what was written to the cache. Cache reads are the
// conversation sent again on every request; shown apart, they would swamp the rest.
const inputOf = (c: Counts) => c.input + c.cacheWrite
const tokenCells = (c: Counts) => [compact(inputOf(c)), compact(c.output), compact(c.cacheRead)]

const total = (models: Record<string, Counts>): Counts => {
  const t = zero()
  for (const c of Object.values(models)) addInto(t, c)
  return t
}

// A table: a header, body rows, then a rule and the closing rows. The first column is
// left-aligned, the rest right-aligned, two spaces apart.
const table = (head: string[], body: string[][], foot: string[][] = []): string[] => {
  const all = [head, ...body, ...foot]
  const widths = head.map((_, i) => Math.max(...all.map(r => (r[i] ?? '').length)))
  const line = (r: string[]) =>
    `  ${r.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  ')}`.trimEnd()
  const width = widths.reduce((a, b) => a + b, 0) + 2 * (widths.length - 1)
  return [line(head), ...body.map(line), ...(foot.length ? [`  ${'─'.repeat(width)}`, ...foot.map(line)] : [])]
}

// /usage-stats help: the arguments, and what each column means.
const help = [
  'Usage by day',
  '',
  '  /usage-stats              every recorded day',
  '  /usage-stats 7            the last 7 recorded days',
  '  /usage-stats today        one day by model (also yesterday, 2026-11-12, 11-12)',
  '  /usage-stats help         this help',
  '',
  '  req     model requests (the session and its agents)',
  '  input   new tokens sent',
  '  output  tokens written by the model',
  '  cache   the earlier conversation, re-read on every request (far cheaper than input)',
  '  cost    input + output + cache at API list price; on a subscription it is not billed',
  '  5h      how much of the 5-hour limit the day used',
  '  week    how much of the weekly limit the day used',
  '  max     the highest the limit stood at that day',
].join('\n')

// Every day on one row: requests, tokens, cost and limits used, then the average and the total.
const overview = (days: readonly DayStats[], thisYear: number): string => {
  const rows = days.map(d => {
    const t = total(d.models)
    return [
      dateText(d.day, thisYear),
      String(t.requests),
      ...tokenCells(t),
      cost(t.usd),
      plus(d.limits.five_hour?.used),
      plus(d.limits.seven_day?.used),
    ]
  })
  const n = days.length
  const sums = total(Object.fromEntries(days.map(d => [d.day, total(d.models)])))
  const priced = days.some(d => total(d.models).usd !== undefined)
  const used = (kind: string) => days.map(d => d.limits[kind]?.used).filter((u): u is number => u !== undefined)
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined)
  const sum = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) : undefined)
  const foot =
    n > 1
      ? [
          [
            'avg / day',
            String(Math.round(sums.requests / n)),
            compact(Math.round(inputOf(sums) / n)),
            compact(Math.round(sums.output / n)),
            compact(Math.round(sums.cacheRead / n)),
            priced ? money((sums.usd ?? 0) / n) : '—',
            plus(avg(used('five_hour'))),
            plus(avg(used('seven_day'))),
          ],
          // 5-hour windows follow one another: their percents do not add up to anything.
          [`total (${n} days)`, String(sums.requests), ...tokenCells(sums), cost(sums.usd), '', plus(sum(used('seven_day')))],
        ]
      : []
  // A title first: the engine puts the plugin's name before the first line.
  return [
    'Usage by day',
    '',
    ...table(['', 'req', 'input', 'output', 'cache', 'cost', '5h', 'week'], rows, foot),
  ].join('\n')
}

// One day: each model's requests, tokens and cost, then the windows the limits were used in.
const dayView = (d: DayStats, thisYear: number): string => {
  const t = total(d.models)
  const five = d.limits.five_hour
  const week = d.limits.seven_day
  const models = Object.entries(d.models).sort((a, b) => (b[1].usd ?? 0) - (a[1].usd ?? 0))
  const out = [dateText(d.day, thisYear, true), '']
  if (models.length > 0) {
    out.push(
      ...table(
        ['model', 'req', 'input', 'output', 'cache', 'cost'],
        models.map(([name, c]) => [name, String(c.requests), ...tokenCells(c), cost(c.usd)]),
        models.length > 1 ? [['total', String(t.requests), ...tokenCells(t), cost(t.usd)]] : [],
      ),
      '',
    )
  }
  // The windows and the week share one table, so their used and max columns line up.
  const limits: string[][] = []
  if (five && five.windows.length > 0) {
    for (const w of five.windows) {
      limits.push([
        Number.isNaN(w.resets) ? 'unknown' : `${clock(w.resets - 5 * 3_600_000)} – ${clock(w.resets)}`,
        w.used > 0 ? `+${pct(w.used)}` : '—',
        pct(w.peak),
      ])
    }
  }
  if (week) {
    const last = week.windows[week.windows.length - 1]
    const resets = last && !Number.isNaN(last.resets) ? ` (resets ${dateText(dayOf(last.resets), thisYear)})` : ''
    if (limits.length > 0) limits.push(['', '', ''])
    limits.push([`week${resets}`, week.used > 0 ? `+${pct(week.used)}` : '—', pct(week.peak)])
  }
  // used: what the limit rose by that day; max: the highest it stood at.
  if (limits.length > 0) out.push(...table([five?.windows.length ? '5h limit' : 'limits', 'used', 'max'], limits))
  return out.join('\n').trimEnd()
}

const empty = 'No usage recorded yet: cc-status-bar counts responses from the moment it is installed.'

// The /usage-stats answer for its argument: nothing for every day, a number for the last that
// many recorded days, a date (YYYY-MM-DD, MM-DD, today, yesterday) for that day in detail,
// help for what the columns mean.
export const formatStats = (all: readonly DayStats[], arg: string, now: number): string => {
  const thisYear = new Date(now).getFullYear()
  const a = arg.trim().toLowerCase()
  if (a === 'help') return help
  const day =
    a === 'today'
      ? dayOf(now)
      : a === 'yesterday'
        ? dayOf(now - 86_400_000)
        : /^\d{4}-\d{2}-\d{2}$/.test(a)
          ? a
          : /^\d{2}-\d{2}$/.test(a)
            ? `${thisYear}-${a}`
            : undefined
  if (day !== undefined) {
    const d = all.find(x => x.day === day)
    return d ? dayView(d, thisYear) : `Nothing recorded on ${day}.`
  }
  const n = Number.parseInt(a, 10)
  const days = n > 0 ? all.slice(0, n) : all
  return days.length === 0 ? empty : overview(days, thisYear)
}
