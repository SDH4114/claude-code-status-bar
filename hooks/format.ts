export type Context = { tokens?: number; window: number; percent?: number }

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

const label: Record<string, string> = { five_hour: '5h', seven_day: '7d' }

const levels = ['low', 'medium', 'high', 'xhigh', 'max']

export const effortLevel = (text: unknown): string | undefined => {
  const word = typeof text === 'string' ? text.trim().toLowerCase() : ''
  return levels.includes(word) ? word : undefined
}

// claude-opus-4-1-20250805 and the older claude-3-5-sonnet-20241022; a date is never a version.
export const modelName = (id: string): string => {
  const m = /(opus|sonnet|haiku|fable)-(\d{1,2})(?:-(\d{1,2}))?(?!\d)/i.exec(id)
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
  parts.push(
    context.percent === undefined
      ? `ctx –/${compact(context.window)}`
      : `ctx ${context.tokens === undefined ? '–' : compact(context.tokens)}/${compact(context.window)} ${Math.round(context.percent)}%`,
  )
  if (cost) parts.push(cost)
  for (const r of limits) {
    const name = label[r.kind]
    if (name) parts.push(`${name} ${Math.round(r.percentUsed)}%${until(r.resetsAt, now)}`)
  }
  if (branch) parts.push(branchText(branch))
  return parts.join(' │ ')
}
