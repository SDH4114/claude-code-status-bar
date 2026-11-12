import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import { branchText, effortLevel, effortText, formatLine, promptTokens, spend, tokenCost } from './format'
import type { Tokens } from './format'
import {
  aggregate,
  byMonth,
  emptyLog,
  formatStats,
  isEmptyLog,
  mergeLog,
  monthBefore,
  monthFile,
  parseLog,
  recordLimits,
  recordTokens,
} from './stats'
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

// Daily usage: this chat's record, kept in a file of its own and saved at most every 10 s.
// onDisk is what the file holds, fresh what came since; the file gets both on the next save.
let onDisk: Log = emptyLog()
let fresh: Log = emptyLog()
// The file, and what its name starts with: <dir>/<session id>.
let logPath: string | undefined
let logStem: string | undefined
let savedAt = 0
// When the file was last written; 0 before the first write.
let wroteAt = 0
// Saves run one after another: two at once would each write onDisk plus their own batch.
let saving: Promise<void> = Promise.resolve()
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
  recordLimits(fresh, now, usage.rateLimits, lastLimit)
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

// A file this long unwritten is left to the tidy-up (it takes files idle 24 h): the chat goes
// on in a new one, so the two never touch the same file.
const handOffAfter = 20 * 3_600_000

function save($: Dollar, force = false): Promise<void> {
  const run = () => saveNow($, force)
  saving = saving.then(run, run)
  return saving
}

async function saveNow($: Dollar, force: boolean): Promise<void> {
  if (!logPath || isEmptyLog(fresh)) return
  const now = await $.clock.now()
  if (!force && now - savedAt < 10_000) return
  savedAt = now
  const pending = fresh
  fresh = emptyLog()
  try {
    // Idle long enough for a tidy-up to take it, or already taken (merged into its month):
    // what it held is the tidy-up's now, and the rest goes to a new file.
    if (!isEmptyLog(onDisk) && (now - wroteAt > handOffAfter || !(await $.fs.exists(logPath)))) {
      logPath = `${logStem}-${now}.json`
      onDisk = emptyLog()
    }
    const path = logPath
    const next = emptyLog()
    mergeLog(next, onDisk)
    mergeLog(next, pending)
    await $.fs.write(path, JSON.stringify(next))
    if (path === logPath) {
      onDisk = next
      wroteAt = now
    }
  } catch {
    mergeLog(pending, fresh)
    fresh = pending
  }
}

// Every run of a chat (a start, /clear, /resume) gets a file of its own: a name is never
// used twice, so a month's list of merged files can never match a newer one.
async function openLog($: Dollar): Promise<void> {
  const dir = await usageDir($)
  const id = await $.session.id()
  const now = await $.clock.now()
  logStem = dir && id ? `${dir}/${id}` : undefined
  logPath = logStem ? `${logStem}-${now}.json` : undefined
  onDisk = emptyLog()
  fresh = emptyLog()
  wroteAt = 0
  lastLimit.clear()
}

function countResponse(now: number, usage: (Tokens & { model: string }) | null, model: string): void {
  if (!usage) return
  recordTokens(fresh, now, usage.model || model, usage)
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

// Only names this plugin writes are read, merged or deleted: a session file
// (<session id>.json, <session id>-<ms>.json) or a month (YYYY-MM.json).
const sessionFile = /^[0-9A-Za-z-]+\.json$/
const isOurs = (f: { name: string; kind: string; isLink: boolean }) =>
  f.kind === 'file' && !f.isLink && (sessionFile.test(f.name) || monthFile.test(f.name))

const gone = async ($: Dollar, path: string) => !(await $.fs.exists(path).catch(() => true))

// $.fs cannot delete. rm on macOS and Linux; on Windows rm is there only with Git's tools, so
// PowerShell is tried whenever the file is still there. The path goes in the environment, not
// the command line, so no character in it is read as part of a command.
async function remove($: Dollar, path: string): Promise<boolean> {
  await $.process.run(['rm', '-f', '--', path], { timeoutMs: 5000 }).catch(() => undefined)
  if (await gone($, path)) return true
  await $.process
    .run(['powershell', '-NoProfile', '-NonInteractive', '-Command', 'Remove-Item -LiteralPath $env:CC_STATUS_BAR_FILE -Force'], {
      env: { CC_STATUS_BAR_FILE: path.replace(/\//g, '\\') },
      timeoutMs: 15_000,
    })
    .catch(() => undefined)
  return gone($, path)
}

const keepMonths = 6
const tidyEvery = 6 * 3_600_000
// A session file this long unwritten is done with (its chat goes on in a new one after 20 h).
const mergeAfter = 24 * 3_600_000

// Merges session files older than a day into one file per month and deletes them, then deletes
// months past the last 6. At most every 6 hours, from one process at a time.
async function tidy($: Dollar): Promise<void> {
  const dir = await usageDir($)
  if (!dir || !logPath) return
  const now = await $.clock.now()
  const lock = `${dir}/tidy.lock`
  const readLock = async (): Promise<{ at?: number; token?: string }> => {
    try {
      return JSON.parse(await $.fs.read(lock)) as { at?: number; token?: string }
    } catch {
      return {}
    }
  }
  const held = await readLock()
  // A lock from the future (a clock set back) does not hold.
  if (typeof held.at === 'number' && held.at <= now && now - held.at < tidyEvery) return
  // Not atomic: a second process that slips in here is caught by reading the lock back.
  const token = baseName(logPath)
  await $.fs.write(lock, JSON.stringify({ at: now, token }))
  await $.clock.sleep(200)
  if ((await readLock()).token !== token) return

  const oldest = monthBefore(now, keepMonths - 1)
  const entries = (await $.fs.list(dir)).filter(isOurs)
  // What goes into each month, by the session file it comes from.
  const into = new Map<string, { name: string; part: Log }[]>()
  const parted = new Map<string, string[]>()
  for (const f of entries) {
    if (monthFile.test(f.name) || f.name === baseName(logPath) || now - f.mtimeMs < mergeAfter) continue
    let log: Log
    try {
      log = parseLog(await $.fs.read(`${dir}/${f.name}`))
    } catch {
      continue
    }
    const months: string[] = []
    for (const [m, part] of byMonth(log)) {
      if (m < oldest) continue
      months.push(m)
      const list = into.get(m) ?? []
      list.push({ name: f.name, part })
      into.set(m, list)
    }
    parted.set(f.name, months)
  }
  // Each month is read again just before it is written, and a file it already lists is not
  // added twice: a delete that failed, or another process's tidy-up, cannot count a file twice.
  const failed = new Set<string>()
  for (const [m, parts] of into) {
    const path = `${dir}/${m}.json`
    try {
      const log = (await $.fs.exists(path)) ? parseLog(await $.fs.read(path)) : emptyLog()
      const listed = new Set(log.merged ?? [])
      for (const { name, part } of parts) {
        if (listed.has(name)) continue
        mergeLog(log, part)
        listed.add(name)
      }
      log.merged = [...listed]
      await $.fs.write(path, JSON.stringify(log))
    } catch {
      // Unreadable or unwritable: nothing of it is deleted, so nothing is lost.
      for (const { name } of parts) failed.add(name)
    }
  }
  // A session file is deleted only once every month it reaches holds its part.
  const deleted = new Set<string>()
  for (const name of parted.keys()) {
    if (!failed.has(name) && (await remove($, `${dir}/${name}`))) deleted.add(name)
  }
  // A deleted file needs no mention; one still there stays listed, so it is not counted twice.
  if (deleted.size > 0) {
    for (const m of into.keys()) {
      const path = `${dir}/${m}.json`
      try {
        const log = parseLog(await $.fs.read(path))
        const left = (log.merged ?? []).filter(n => !deleted.has(n))
        if (left.length === (log.merged ?? []).length) continue
        if (left.length > 0) log.merged = left
        else delete log.merged
        await $.fs.write(path, JSON.stringify(log))
      } catch {
        // Still listed: harmless, the file is gone.
      }
    }
  }
  for (const f of entries) {
    const m = monthFile.exec(f.name)?.[1]
    if (m && m < oldest) await remove($, `${dir}/${f.name}`)
  }
}

async function statsText($: Dollar, args: string): Promise<string> {
  await save($, true)
  const dir = await usageDir($)
  if (!dir) return 'No home directory: cannot find the usage records.'
  const entries = (await $.fs.list(dir).catch(() => [])).filter(isOurs)
  const sessions = new Map<string, Log>()
  const months = new Map<string, Log>()
  for (const f of entries) {
    const text = await $.fs.read(`${dir}/${f.name}`).catch(() => undefined)
    if (text === undefined) continue
    try {
      const log = parseLog(text)
      const m = monthFile.exec(f.name)?.[1]
      if (m) months.set(m, log)
      else sessions.set(f.name, log)
    } catch {
      // A broken file is skipped rather than hiding every other day.
    }
  }
  const now = await $.clock.now()
  const oldest = monthBefore(now, keepMonths - 1)
  // A session file still on disk that a month lists (its delete failed, or the tidy-up stopped
  // before it) counts only for the months that do not list it yet; one they all hold is stuck.
  const stuck = new Set<string>()
  const logs: Log[] = [...months.values()]
  for (const [name, log] of sessions) {
    const listedBy = (m: string) => months.get(m)?.merged?.includes(name) ?? false
    const parts = [...byMonth(log)]
    if (!parts.some(([m]) => listedBy(m))) {
      logs.push(log)
      continue
    }
    const rest = parts.filter(([m]) => !listedBy(m) && m >= oldest)
    for (const [, part] of rest) logs.push(part)
    if (rest.length === 0) stuck.add(name)
  }
  // Months past the kept ones are still there only when deleting them failed.
  for (const m of months.keys()) if (m < oldest) stuck.add(`${m}.json`)
  const text = formatStats(aggregate(logs), args, now)
  return stuck.size === 0 ? text : `${text}\n\n${stuckText(dir, [...stuck].sort())}`
}

// The old records a tidy-up merged or let expire but could not delete: where, so they can be
// deleted by hand. They are not counted twice meanwhile.
const stuckText = (dir: string, names: string[]): string => {
  const shown = names.slice(0, 5).map(n => `    ${n}`)
  if (names.length > 5) shown.push(`    … and ${names.length - 5} more`)
  return [`  Could not delete old usage records (${names.length}). Delete them by hand from:`, `    ${dir}`, ...shown].join('\n')
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
  })
  // In the background: it waits on the lock and may read many files.
  void tidy($).catch(() => {})
  await $.command
    .register({ name: 'usage-stats', description: 'Tokens per model and limits used, by day', argumentHint: '[days | YYYY-MM-DD | today | yesterday | help]' })
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
