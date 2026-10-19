export type Context = { tokens?: number; window: number; percent?: number }

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

const label: Record<string, string> = { five_hour: '5h', seven_day: '7d' }

export const modelName = (id: string): string => {
  const m = /(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/i.exec(id)
  if (!m) return id.replace(/^claude-/, '')
  const name = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()
  return m[3] && m[3].length < 4 ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`
}

export const compact = (n: number): string =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

export const until = (iso: string | undefined, now: number): string => {
  const ms = iso ? Date.parse(iso) - now : NaN
  if (!(ms > 0)) return ''
  const min = Math.round(ms / 60000)
  if (min >= 1440) return ` ↻${Math.floor(min / 1440)}d${Math.floor((min % 1440) / 60)}h`
  if (min >= 60) return ` ↻${Math.floor(min / 60)}h${min % 60}m`
  return ` ↻${min}m`
}

export const formatLine = (
  model: string,
  effort: string,
  context: Context,
  limits: readonly Limit[],
  now: number,
): string => {
  const parts = [modelName(model)]
  if (effort) parts.push(effort)
  parts.push(
    context.percent === undefined
      ? `ctx –/${compact(context.window)}`
      : `ctx ${compact(context.tokens ?? 0)}/${compact(context.window)} ${Math.round(context.percent)}%`,
  )
  for (const r of limits) {
    const name = label[r.kind]
    if (name) parts.push(`${name} ${Math.round(r.percentUsed)}%${until(r.resetsAt, now)}`)
  }
  return parts.join(' │ ')
}
