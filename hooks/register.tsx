import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import { branchText, effortLevel, effortText, formatLine, promptTokens, spend, tokenCost } from './format'
import type { Tokens } from './format'
import { aggregate, emptyLog, formatStats, parseLog, recordLimits, recordTokens } from './stats'
import type { Log } from './stats'

type Dollar = Parameters<Hook<'session.measure'>>[0]

const effort = atom({ plugin: 'cc-status-bar', key: 'effort' } as const, '')
const line = atom({ plugin: 'cc-status-bar', key: 'line' } as const, '')
// Session cost when the current answer began; null before the first one.
const base = atom({ plugin: 'cc-status-bar', key: 'base' } as const, null)

type Saved = { effortLevel?: string; modelSettings?: Record<string, { effortLevel?: string }> }

// The hooks compiler requires helpers receiving $ to be declared at module scope.
let seenModel = ''
let seenSetting: string | undefined
let ticker: { cancel: () => void } | undefined
let polling = false
// Git branch per working directory ('' for the session's own): the branch, or a short commit in
// parentheses for a detached HEAD; '' outside a repository.
const branches = new Map<string, { name: string; at: number }>()

// What one subagent or teammate has done so far, from its own model requests.
type AgentStats = {
  label: string
  model: string
  effort: string
  tokens?: number
  // Estimated from tokens at list price; undefined until a response of a priced model.
  usd?: number
  // usd when the agent's current turn began, as the main line's base.
  base: number | null
  // Where it runs when apart from the session (a worktree, a cwd of its own).
  cwd?: string
}
const agents = new Map<string, AgentStats>()
// The agent whose transcript is on screen; undefined for the main conversation.
let viewed: string | undefined

// Daily usage: this session's record, kept in its own file and saved at most every 10 s.
let log: Log = emptyLog()
let logPath: string | undefined
let dirty = false
let savedAt = 0
// The last limit reading written, per kind, so an unchanged one is not written again.
const lastLimit = new Map<string, string>()

const agentOf = (id: string): AgentStats => {
  let a = agents.get(id)
  if (!a) {
    a = { label: '', model: '', effort: '', base: null }
    agents.set(id, a)
  }
  return a
}

async function draw($: Dollar): Promise<void> {
  const [model, usage] = await Promise.all([$.session.model(), $.session.usage()])
  const now = await $.clock.now()
  if (recordLimits(log, now, usage.rateLimits, lastLimit)) dirty = true
  const agent = viewed === undefined ? undefined : agents.get(viewed)
  let text: string
  if (agent) {
    // The limits are the account's, already on the main line: an agent's shows its own figures only.
    const sameModel = agent.model === model
    const context = {
      tokens: agent.tokens,
      window: sameModel ? usage.context.window : undefined,
      percent: sameModel && agent.tokens !== undefined ? (agent.tokens / usage.context.window) * 100 : undefined,
    }
    const cost = agent.usd === undefined ? '' : `≈${spend(agent.usd, agent.base)}`
    const status = formatLine(agent.model || model, agent.effort, context, [], now, cost, branchOf(agent.cwd))
    text = agent.label ? `${branchText(agent.label, 20)} │ ${status}` : status
  } else {
    const cost = spend(usage.cost?.usd, await read($, base))
    text = formatLine(model, await read($, effort), usage.context, usage.rateLimits, now, cost, branchOf(undefined))
  }
  if (text !== (await read($, line))) await update($, line, () => text)
}

const branchOf = (cwd: string | undefined): string => branches.get(cwd ?? '')?.name ?? ''

// git itself rather than .git/HEAD: worktrees, submodules and subdirectories resolve the same on every OS.
async function readBranch($: Dollar, cwd: string | undefined): Promise<string> {
  const git = (args: string[]) => $.process.run(['git', ...args], { timeoutMs: 3000, ...(cwd ? { cwd } : {}) })
  const ref = await git(['symbolic-ref', '--short', '-q', 'HEAD'])
  if (ref.exitCode === 0) return ref.stdout.trim()
  const sha = await git(['rev-parse', '--short', 'HEAD'])
  return sha.exitCode === 0 && sha.stdout.trim() ? `(${sha.stdout.trim()})` : ''
}

// At most every 5 s from the ticker: a git process each second is noticeable on Windows.
async function refreshBranch($: Dollar, force = false): Promise<void> {
  // The branch on screen: the viewed agent's directory, or the session's.
  const cwd = viewed === undefined ? undefined : agents.get(viewed)?.cwd
  const key = cwd ?? ''
  const now = await $.clock.now()
  const seen = branches.get(key)
  if (!force && seen && now - seen.at < 5000) return
  branches.set(key, { name: seen?.name ?? '', at: now })
  // No git on PATH, or a timeout: no branch rather than a stale one.
  const name = await readBranch($, cwd).catch(() => '')
  branches.set(key, { name, at: now })
}

// /effort saves per model (modelSettings.<id>.effortLevel); the top-level key is the older spelling.
const savedEffort = async ($: Dollar, model: string): Promise<string | undefined> => {
  const all = (await $.settings.read().catch(() => undefined)) as Saved | undefined
  return effortLevel(all?.modelSettings?.[model]?.effortLevel) ?? effortLevel(all?.effortLevel)
}

// Where the daily records live: one file per session under the Claude config directory.
async function usageDir($: Dollar): Promise<string | undefined> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  if (config) return `${config}/cc-status-bar/usage`
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  return home ? `${home}/.claude/cc-status-bar/usage` : undefined
}

async function save($: Dollar, force = false): Promise<void> {
  if (!dirty || !logPath) return
  const now = await $.clock.now()
  if (!force && now - savedAt < 10_000) return
  savedAt = now
  dirty = false
  await $.fs.write(logPath, JSON.stringify(log)).catch(() => {
    dirty = true
  })
}

// A resumed session goes on with its own file instead of starting it over. A file there that
// cannot be read is left as it is and this session writes beside it.
async function openLog($: Dollar): Promise<void> {
  const dir = await usageDir($)
  const id = await $.session.id()
  let path = dir && id ? `${dir}/${id}.json` : undefined
  let next = emptyLog()
  if (path && (await $.fs.exists(path))) {
    try {
      next = parseLog(await $.fs.read(path))
    } catch {
      path = `${dir}/${id}-${await $.clock.now()}.json`
    }
  }
  // Swapped in one step after the reads: a tick saving meanwhile still writes the old file.
  logPath = path
  log = next
  dirty = false
  lastLimit.clear()
}

function countResponse(now: number, usage: (Tokens & { model: string }) | null, model: string): void {
  if (!usage) return
  recordTokens(log, now, usage.model || model, usage)
  dirty = true
}

async function statsText($: Dollar, args: string): Promise<string> {
  await save($, true)
  const dir = await usageDir($)
  if (!dir) return 'No home directory: cannot find the usage records.'
  const entries = await $.fs.list(dir).catch(() => [])
  const logs: Log[] = []
  for (const f of entries) {
    if (f.kind !== 'file' || !f.name.endsWith('.json')) continue
    const text = await $.fs.read(`${dir}/${f.name}`).catch(() => undefined)
    if (text === undefined) continue
    try {
      logs.push(parseLog(text))
    } catch {
      // A broken file is skipped rather than hiding every other day.
    }
  }
  const n = Number.parseInt(args.trim(), 10)
  return formatStats(aggregate(logs), n > 0 ? n : undefined)
}

async function poll($: Dollar): Promise<void> {
  const model = await $.session.model()
  const setting = await savedEffort($, model)
  if (setting !== seenSetting || model !== seenModel) {
    await update($, effort, () => setting ?? '')
  }
  seenModel = model
  seenSetting = setting
  await refreshBranch($)
  // Time until a reset changes even when the model and settings stay the same.
  await draw($)
  await save($)
}

// A slow git or settings read must not let ticks pile up behind it.
async function tick($: Dollar): Promise<void> {
  if (polling) return
  polling = true
  try {
    await poll($)
  } catch {
    // Next tick tries again.
  } finally {
    polling = false
  }
}

// A new chat: the first start, and a /clear or /resume, which end the old one without a
// session.start. The ticker is started anew too: it keeps the $ it was started with.
async function begin($: Dollar): Promise<void> {
  // Started first, so a failing read below cannot leave the footer frozen.
  ticker?.cancel()
  ticker = $.clock.every(1000, () => void tick($))
  // The old chat's last responses go to its own file before the new one opens.
  await save($, true).catch(() => {})
  await openLog($).catch(() => {
    logPath = undefined
    log = emptyLog()
  })
  await $.command
    .register({ name: 'usage-stats', description: 'Tokens per model and limits used, by day', argumentHint: '[days]' })
    .catch(() => {})
  await update($, base, () => null)
  // A new chat has none of the old one's agents.
  agents.clear()
  viewed = undefined
  seenModel = await $.session.model()
  seenSetting = await savedEffort($, seenModel)
  await update($, effort, () => seenSetting ?? '')
  await refreshBranch($, true)
  await draw($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.ui.status(undefined)
    await begin($)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Fires inside the new chat, before the settings hooks; a failure here runs them once, from .catch.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear' || e.source === 'resume') await begin($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const usd = (await $.session.usage()).cost?.usd
      await update($, base, () => usd ?? null)
    } else {
      const a = agentOf(e.agentId)
      a.base = a.usd ?? 0
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    if (id !== undefined) {
      const a = agentOf(id)
      a.model = e.model
      a.effort = effortText(e.effort)
      const result = yield* next(e)
      // After the request: a failure here must not reach .catch, which would send it again.
      try {
        const used = result.usage as (Tokens & { model: string }) | null
        if (used) {
          countResponse(await $.clock.now(), used, a.model)
          a.model = used.model || a.model
          a.tokens = promptTokens(used)
          const usd = tokenCost(a.model, used)
          if (usd !== undefined) a.usd = (a.usd ?? 0) + usd
        }
        if (viewed === id) await draw($)
      } catch {
        // The next tick draws it.
      }
      return result
    }
    await update($, effort, () => effortText(e.effort))
    await draw($)
    const result = yield* next(e)
    // After the request, as for an agent: a failure here must not send it again.
    try {
      countResponse(await $.clock.now(), result.usage as (Tokens & { model: string }) | null, e.model)
    } catch {
      // Lost from the daily record; the footer is unaffected.
    }
    return result
  }).catch(async function* ($, e, next) {
    return yield* next(e)
  })

  // The agent's name for the line, and its own directory when it runs apart from the session.
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    // After the spawn: nothing here may reach .catch, which would start the agent again.
    if (result.agentId) {
      const a = agentOf(result.agentId)
      a.label = e.name || e.description || e.subagentType || ''
      if (e.cwd) a.cwd = e.cwd
      if (result.model) a.model = a.model || result.model
    }
    return result
  }).catch(($, e, next) => next(e))

  // A worktree agent's directory is known only here, where it starts.
  on('classic.SubagentStart', async ($, e, next) => {
    const a = agentOf(e.agent_id)
    if (e.cwd && e.cwd !== (await $.session.cwd().catch(() => undefined))) a.cwd = e.cwd
    return next(e)
  }).catch(($, e, next) => next(e))

  // The prompt line has no view of its own; the band above it does. Drawing the band may not
  // write state, so the view is noted here and the next tick redraws the line for it.
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    viewed = e.props.view.agentId
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', async ($, e, next) => {
    const result = await next(e)
    if (e.command === 'model' || e.command === 'effort') await poll($)
    const level = e.command === 'effort' ? effortLevel(e.args) : undefined
    if (level) {
      await update($, effort, () => level)
      await draw($)
    }
    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'usage-stats' }, async ($, e) => ({ text: await statsText($, e.args ?? '') })).catch(
    ($, e, next) => next(e),
  )

  on('session.end', async ($, e, next) => {
    await save($, true).catch(() => {})
    // /clear and /resume go on in this process: classic.SessionStart restarts the ticker.
    if (e.reason !== 'clear' && e.reason !== 'resume') {
      ticker?.cancel()
      ticker = undefined
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    await draw($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    await draw($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const text = await read($, line)
    if (!text) return next(e)

    const { Text } = $.ui.resolve(e)

    // One Text, so the footer stays a single row and is cut at the edge; the engine's own
    // line tree (next(e)) fills the row and would push the status onto a second one.
    return (
      <Text wrap="truncate-end">
        <Text dimColor>{e.props.hint}</Text>
        <Text dimColor>{'  │  '}</Text>
        <Text color="warning">{text}</Text>
      </Text>
    )
  }).catch(($, e, next) => next(e))
}
