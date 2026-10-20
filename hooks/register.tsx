import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import { effortLevel, formatLine, spend } from './format'

type Dollar = Parameters<Hook<'session.measure'>>[0]

const effort = atom({ plugin: 'status-bar', key: 'effort' } as const, '')
const line = atom({ plugin: 'status-bar', key: 'line' } as const, '')
// Session cost when the current answer began; null before the first one.
const base = atom({ plugin: 'status-bar', key: 'base' } as const, null)

type Saved = { effortLevel?: string; modelSettings?: Record<string, { effortLevel?: string }> }

// What the last poll saw, so a change of model or effort redraws at once.
let seenModel = ''
let seenSetting: string | undefined
let ticker: { cancel: () => void } | undefined

async function draw($: Dollar): Promise<void> {
  const [model, usage] = await Promise.all([$.session.model(), $.session.usage()])
  seenModel = model
  const cost = spend(usage.cost?.usd, await read($, base))
  const text = formatLine(model, await read($, effort), usage.context, usage.rateLimits, await $.clock.now(), cost)
  if (text !== (await read($, line))) await update($, line, () => text)
}

// /effort saves per model (modelSettings.<id>.effortLevel); the top-level key is the older spelling.
const savedEffort = async ($: Dollar, model: string): Promise<string | undefined> => {
  const all = (await $.settings.read().catch(() => undefined)) as Saved | undefined
  return effortLevel(all?.modelSettings?.[model]?.effortLevel) ?? effortLevel(all?.effortLevel)
}

async function poll($: Dollar): Promise<void> {
  const model = await $.session.model()
  const setting = await savedEffort($, model)
  const isNewSetting = setting !== seenSetting
  seenSetting = setting
  if (isNewSetting && setting) await update($, effort, () => setting)
  if (isNewSetting || model !== seenModel) await draw($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.ui.status(undefined)
    await update($, base, () => null)
    seenSetting = await savedEffort($, await $.session.model())
    await draw($)
    ticker?.cancel()
    ticker = $.clock.every(1000, () => poll($).catch(() => {}))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const usd = (await $.session.usage()).cost?.usd
      if (usd !== undefined) await update($, base, () => usd)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    await update($, effort, () => (e.effort === undefined ? '' : String(e.effort)))
    await draw($)
    return yield* next(e)
  }).catch(async function* ($, e, next) {
    return yield* next(e)
  })

  on('command.run', async ($, e, next) => {
    const result = await next(e)
    const level = e.command === 'effort' ? effortLevel(e.args) : undefined
    if (level) await update($, effort, () => level)
    if (e.command === 'model' || e.command === 'effort') await poll($)
    return result
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    ticker?.cancel()
    ticker = undefined
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

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text dimColor>{e.props.hint}</Text>
        <Text dimColor>{'  │  '}</Text>
        <Text color="warning">{text}</Text>
      </Box>
    )
  }).catch(($, e, next) => next(e))
}
