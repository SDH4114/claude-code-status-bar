import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import { effortLevel, effortText, formatLine, spend } from './format'

type Dollar = Parameters<Hook<'session.measure'>>[0]

const effort = atom({ plugin: 'status-bar', key: 'effort' } as const, '')
const line = atom({ plugin: 'status-bar', key: 'line' } as const, '')
// Session cost when the current answer began; null before the first one.
const base = atom({ plugin: 'status-bar', key: 'base' } as const, null)

type Saved = { effortLevel?: string; modelSettings?: Record<string, { effortLevel?: string }> }

// The hooks compiler requires helpers receiving $ to be declared at module scope.
let seenModel = ''
let seenSetting: string | undefined
let ticker: { cancel: () => void } | undefined
let polling = false
// Current git branch, or a short commit in parentheses for a detached HEAD; '' outside a repository.
let branch = ''
let branchAt = -Infinity

async function draw($: Dollar): Promise<void> {
  const [model, usage] = await Promise.all([$.session.model(), $.session.usage()])
  const cost = spend(usage.cost?.usd, await read($, base))
  const text = formatLine(model, await read($, effort), usage.context, usage.rateLimits, await $.clock.now(), cost, branch)
  if (text !== (await read($, line))) await update($, line, () => text)
}

// git itself rather than .git/HEAD: worktrees, submodules and subdirectories resolve the same on every OS.
async function readBranch($: Dollar): Promise<string> {
  const git = (args: string[]) => $.process.run(['git', ...args], { timeoutMs: 3000 })
  const ref = await git(['symbolic-ref', '--short', '-q', 'HEAD'])
  if (ref.exitCode === 0) return ref.stdout.trim()
  const sha = await git(['rev-parse', '--short', 'HEAD'])
  return sha.exitCode === 0 && sha.stdout.trim() ? `(${sha.stdout.trim()})` : ''
}

// At most every 5 s from the ticker: a git process each second is noticeable on Windows.
async function refreshBranch($: Dollar, force = false): Promise<void> {
  const now = await $.clock.now()
  if (!force && now - branchAt < 5000) return
  branchAt = now
  // No git on PATH, or a timeout: no branch rather than a stale one.
  branch = await readBranch($).catch(() => '')
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Started first, so a failing read below cannot leave the footer frozen.
    ticker?.cancel()
    ticker = $.clock.every(1000, () => void tick($))
    $.ui.status(undefined)
    await update($, base, () => null)
    seenModel = await $.session.model()
    seenSetting = await savedEffort($, seenModel)
    await update($, effort, () => seenSetting ?? '')
    await refreshBranch($, true)
    await draw($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const usd = (await $.session.usage()).cost?.usd
      await update($, base, () => usd ?? null)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    await update($, effort, () => effortText(e.effort))
    await draw($)
    return yield* next(e)
  }).catch(async function* ($, e, next) {
    return yield* next(e)
  })

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
    const result = await next(e)
    // /clear ends the chat but not the process, and no session.start follows: keep ticking
    // and start the new chat clean, or the footer stays empty until the first prompt.
    if (e.reason === 'clear') {
      await update($, base, () => null)
      await update($, effort, () => '')
      seenModel = ''
      await tick($)
      return result
    }
    ticker?.cancel()
    ticker = undefined
    return result
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
