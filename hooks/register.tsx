import type { Register } from 'claude-code'

import { drawHistory, registerHistory, registerHistoryCommands, seedHistory } from './history'
import { drawSuggestion, registerSuggestions, startSuggestions } from './suggestions'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await registerHistoryCommands($)
    await startSuggestions($)
    const started = await next(e)
    await seedHistory($)

    return started
  })

  registerHistory(on)
  registerSuggestions(on)

  // One strip above the box: the prompt history on top and the suggestion
  // under it, nearest the box it fills. Another plugin's tree stays above
  // both; the engine's own drawing is never nested, as a band that wrapped it
  // never showed on the desktop.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below

    const history = await drawHistory($, e)
    const guess = await drawSuggestion($, e)
    if (history === undefined && guess === undefined) return below

    const { Box } = $.ui.resolve(e)
    const other = below.type === 'engine' ? undefined : below

    return (
      <Box flexDirection="column" gap={1}>
        {other !== undefined && other}
        {history !== undefined && history}
        {guess !== undefined && guess}
      </Box>
    )
  })
}
