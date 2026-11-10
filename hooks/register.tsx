import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import { branchText, effortLevel, effortText, formatLine, promptTokens, spend, tokenCost } from './format'
import type { Tokens } from './format'

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
  const agent = viewed === undefined ? undefined : agents.get(viewed)
  let text: string
  if (agent) {
    // Limits are the account's, shared by every agent; the rest is the agent's own.
    const sameModel = agent.model === model
    const context = {
      tokens: agent.tokens,
      window: sameModel ? usage.context.window : undefined,
      percent: sameModel && agent.tokens !== undefined ? (agent.tokens / usage.context.window) * 100 : undefined,
    }
    const cost = agent.usd === undefined ? '' : `≈${spend(agent.usd, agent.base)}`
    const status = formatLine(agent.model || model, agent.effort, context, usage.rateLimits, now, cost, branchOf(agent.cwd))
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
    return yield* next(e)
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

  on('session.end', async ($, e, next) => {
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
