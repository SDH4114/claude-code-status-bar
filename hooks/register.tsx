import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import { formatLine } from './format'

type Dollar = Parameters<Hook<'session.measure'>>[0]

const effort = atom({ plugin: 'status-bar', key: 'effort' } as const, '')
const line = atom({ plugin: 'status-bar', key: 'line' } as const, '')

async function draw($: Dollar): Promise<void> {
  const [model, usage] = await Promise.all([$.session.model(), $.session.usage()])
  const text = formatLine(model, await read($, effort), usage.context, usage.rateLimits, $.clock.now())
  await update($, line, () => text)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.ui.status(undefined)
    await draw($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    await update($, effort, () => (e.effort === undefined ? '' : String(e.effort)))
    await draw($)
    return yield* next(e)
  }).catch(async function* ($, e, next) {
    return yield* next(e)
  })

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
