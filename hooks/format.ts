// window is absent for a subagent on another model than the session's: its size is not known here.
export type Context = { tokens?: number; window?: number; percent?: number }

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

// The 5-hour limit first, then the weekly one; the footer tells them apart by position.
const shown = ['five_hour', 'seven_day']

const levels = ['low', 'medium', 'high', 'xhigh', 'max']

export const effortLevel = (text: unknown): string | undefined => {
  const word = typeof text === 'string' ? text.trim().toLowerCase() : ''
  return levels.includes(word) ? word : undefined
}

// claude-opus-4-1-20250805 and the older claude-3-5-sonnet-20241022; a date is never a version.
export const modelName = (id: string): string => {
  const m = /(opus|sonnet|haiku|fable|mythos)-(\d{1,2})(?:-(\d{1,2}))?(?!\d)/i.exec(id)
  const old = m ? null : /claude-(\d{1,2})(?:-(\d{1,2}))?-(opus|sonnet|haiku)/i.exec(id)
  const [family, major, minor] = m ? [m[1], m[2], m[3]] : old ? [old[3], old[1], old[2]] : []
  if (!family || !major) return id.replace(/^claude-/, '')
  const name = family.charAt(0).toUpperCase() + family.slice(1).toLowerCase()
  return minor ? `${name} ${major}.${minor}` : `${name} ${major}`
}

// 999_500 rounds up to 1M, not 1000k.
export const compact = (n: number): string =>
  n >= 999_500 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

// Effort as the request sent it: a level, or a thinking budget in tokens.
export const effortText = (effort: string | number | undefined): string =>
  typeof effort === 'number' ? `think ${compact(effort)}` : (effort ?? '')

// Long branch names would push the limits off a narrow footer.
export const branchText = (name: string, max = 32): string => {
  const chars = Array.from(name)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : name
}

export const until = (iso: string | undefined, now: number): string => {
  const ms = iso ? Date.parse(iso) - now : NaN
  if (!(ms > 0)) return ''
  const min = Math.ceil(ms / 60000)
  if (min >= 1440) return ` ↻${Math.floor(min / 1440)}d${Math.floor((min % 1440) / 60)}h`
  if (min >= 60) return ` ↻${Math.floor(min / 60)}h${min % 60}m`
  return ` ↻${min}m`
}

export const money = (usd: number): string =>
  usd > 0 && usd < 0.01 ? '<$0.01' : usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`

// Last answer / session total; the session total alone before the first answer.
export const spend = (usd: number | undefined, base: number | null): string => {
  if (usd === undefined) return ''
  return base === null ? money(usd) : `${money(Math.max(0, usd - base))} / ${money(usd)}`
}

// What one response's tokens count for: the four numbers the API reports.
export type Tokens = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

// Context a response was answered over, as the status line counts it: the whole input side.
export const promptTokens = (t: Tokens): number =>
  t.input_tokens + t.cache_read_input_tokens + t.cache_creation_input_tokens

// API list prices in $ per million tokens (platform.claude.com pricing, as of 2026-11).
// cacheRead where the model's differs from 0.1x input. The engine's own per-agent cost is not
// exposed to plugins, so a subagent's spend is estimated from its tokens with this table.
type Price = { input: number; output: number; cacheRead?: number }
const prices: Record<string, Price> = {
  'Fable 5.2': { input: 8, output: 40, cacheRead: 0.2 },
  'Mythos 5.2': { input: 8, output: 40, cacheRead: 0.2 },
  'Fable 5.1': { input: 10, output: 50, cacheRead: 0.25 },
  'Mythos 5.1': { input: 10, output: 50, cacheRead: 0.25 },
  'Fable 5': { input: 10, output: 50, cacheRead: 1 },
  'Mythos 5': { input: 10, output: 50, cacheRead: 1 },
  'Opus 5.5': { input: 4, output: 20, cacheRead: 0.2 },
  'Opus 5': { input: 5, output: 25 },
  'Opus 4.8': { input: 5, output: 25 },
  'Opus 4.7': { input: 5, output: 25 },
  'Opus 4.6': { input: 5, output: 25 },
  'Sonnet 5.5': { input: 2, output: 10, cacheRead: 0.1 },
  'Sonnet 5': { input: 2, output: 10 },
  'Sonnet 4.6': { input: 3, output: 15 },
  'Haiku 5.5': { input: 0.1, output: 0.5 },
  'Haiku 4.5': { input: 1, output: 5 },
}
// Haiku 5.5 bills a prompt over 100K tokens at a higher rate.
const haikuLong: Price = { input: 0.5, output: 2.5 }

// Dollars one response cost at list price; undefined for a model the table does not know.
// Cache writes are counted at the 5-minute rate (1.25x input): the usage does not say which TTL.
export const tokenCost = (model: string, t: Tokens): number | undefined => {
  const name = modelName(model)
  const base = name === 'Haiku 5.5' && promptTokens(t) > 100_000 ? haikuLong : prices[name]
  if (!base) return undefined
  const read = base.cacheRead ?? base.input * 0.1
  return (
    (t.input_tokens * base.input +
      t.cache_creation_input_tokens * base.input * 1.25 +
      t.cache_read_input_tokens * read +
      t.output_tokens * base.output) /
    1_000_000
  )
}

export const formatLine = (
  model: string,
  effort: string,
  context: Context,
  limits: readonly Limit[],
  now: number,
  cost = '',
  branch = '',
): string => {
  const parts = [modelName(model)]
  if (effort) parts.push(effort)
  const used = context.tokens === undefined ? '–' : compact(context.tokens)
  parts.push(
    context.window === undefined
      ? `ctx ${used}`
      : context.percent === undefined
        ? `ctx –/${compact(context.window)}`
        : `ctx ${used}/${compact(context.window)} ${Math.round(context.percent)}%`,
  )
  if (cost) parts.push(cost)
  for (const kind of shown) {
    const r = limits.find(l => l.kind === kind)
    if (r) parts.push(`${Math.round(r.percentUsed)}%${until(r.resetsAt, now)}`)
  }
  if (branch) parts.push(branchText(branch))
  return parts.join(' │ ')
}
