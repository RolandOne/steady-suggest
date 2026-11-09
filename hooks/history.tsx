import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PromptOrigin, RenderInput, RenderSurface } from 'claude-code'

import type { PinnedPrompt } from '../types'

const PLUGIN = 'steady-suggest'
const PANE = 'prompt-history'
const LIMIT = 100
const BAND_LINES = 2
// Room the ▲ ▼ 12/34 controls take at the band's left edge, and Go to beside them.
const CONTROL_COLUMNS = 14
const GO_TO_COLUMNS = 8

const prompts = atom({ plugin: 'steady-suggest', key: 'prompts' } as const, [])
// How many prompts back from the newest the band shows: 0 is the newest.
const stepsBack = atom({ plugin: 'steady-suggest', key: 'stepsBack' } as const, 0)
const isSmart = atom({ plugin: 'steady-suggest', key: 'isSmart' } as const, true)
const isOffScreen = atom({ plugin: 'steady-suggest', key: 'isOffScreen' } as const, null)

// The person's own words reach prompt.submit from the terminal (composer), the
// phone (bridge) or the desktop app (sdk); everything else is a notification,
// a peer, a schedule or a plugin and must not replace the pin.
const OWN_KINDS: readonly PromptOrigin['kind'][] = ['composer', 'bridge', 'sdk']

// Host events the desktop app delivers as sdk turns (`<side-sessions-event>`,
// `<ci-monitor-event>`) open with a tag; a typed prompt almost never does.
const HOST_EVENT = /^\s*<[a-z][\w-]*[\s>]/i

// Wrappers the transcript keeps around a user row that the person never typed.
const ENGINE_WRAPPERS =
  /<(system-reminder|local-command-[\w-]+|command-[\w-]+)\b[^>]*>[\s\S]*?<\/\1>/g

// User-role rows the engine writes itself: a loaded skill's body, an interrupt
// marker, the caveat ahead of local command output.
const ENGINE_ROW =
  /^(Base directory for this skill:|\[Request interrupted|Caveat: The messages below)/

// prompt.submit carries no message id, so the transcript row of the newest
// prompt is found by its text the first time a row with that text is drawn.
// Module variables are fine here: a reload only costs smart mode one redraw.
let lastText: string | undefined
let latestRowId: string | undefined
let lastOffScreen: boolean | null = null
const seenRows = new Set<string>()
// Each prompt's transcript row, by its text, so the band can scroll to it.
const rowIds = new Map<string, string>()

function isOwnOrigin(origin: PromptOrigin) {
  return OWN_KINDS.includes(origin.kind)
}

function oneLine(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

function clip(text: string, chars: number) {
  const flat = oneLine(text)

  return flat.length > chars ? `${flat.slice(0, chars - 1)}…` : flat
}

function imageTag(images: number) {
  if (images === 0) return ''

  return images === 1 ? ' [+1 image]' : ` [+${images} images]`
}

function rowKey(text: string) {
  return oneLine(text).slice(0, 500)
}

function sameText(a: string, b: string) {
  return rowKey(a) === rowKey(b)
}

async function copyPrompt(
  $: EngineInterface,
  text: string,
  surface: RenderSurface,
) {
  const done = await $.ui.copy({ text, surface })

  $.ui.toast(done.isCopied ? 'Prompt copied' : `Could not copy: ${done.reason}`)
}

async function step($: EngineInterface, by: number) {
  const count = (await read($, prompts)).length

  await update($, stepsBack, n => Math.max(0, Math.min(count - 1, n + by)))
}

// Exact text first; else a row whose opening matches, since a surface may
// draw the prompt with framing the submitted text did not have.
function findRow(text: string) {
  const key = rowKey(text)
  const exact = rowIds.get(key)
  if (exact !== undefined) return exact

  const head = key.slice(0, 80)
  for (const [rowText, id] of rowIds) {
    if (rowText.startsWith(head) || (rowText.length >= 20 && key.startsWith(rowText))) return id
  }

  return undefined
}

async function goToRow($: EngineInterface, text: string) {
  const requestId = findRow(text)
  if (requestId === undefined) {
    $.ui.toast('That message is not in the chat view')

    return
  }
  // A transcript row scrolls only where the surface can, so a refusal or a
  // throw becomes a toast instead of a silent dead button.
  try {
    const moved = await $.ui.scroll({ to: { requestId }, block: 'start' })
    if (moved.deny !== undefined) $.ui.toast(`Could not scroll there: ${moved.deny}`)
  } catch (error) {
    $.ui.toast(`Could not scroll there: ${String(error)}`)
  }
}

function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: 'Prompts' })
}

// A resumed session starts with an empty list; the transcript still holds the
// person's earlier prompts, so the pin is there before they type anything.
async function seedFromTranscript($: EngineInterface) {
  if ((await read($, prompts)).length > 0) return

  const rows = await $.session.messages()
  const found = rows
    .filter(row => row.role === 'user' && !row.toolResults?.length)
    .map(row => row.text.replace(ENGINE_WRAPPERS, '').trim())
    .filter(text => text !== '' && !HOST_EVENT.test(text) && !ENGINE_ROW.test(text))
    .slice(-LIMIT)

  if (found.length === 0) return

  const seeded: PinnedPrompt[] = found.map((text, i) => ({ id: i, text, images: 0 }))
  await update($, prompts, list => (list.length > 0 ? list : seeded))
  lastText = found.at(-1)
}

// Before the session starts (a plugin registers `session.start` once, so the
// entry module calls this and `seedHistory` around the engine's own start).
export async function registerHistoryCommands($: EngineInterface) {
  await $.command.register({
    name: 'prompts',
    description: 'Show every prompt of this session in a pane',
  })
  await $.command.register({
    name: 'pin-prompt',
    description: 'Jump the history row back to your newest prompt, or toggle smart mode',
    argumentHint: 'smart',
  })
}

// After the session starts.
export async function seedHistory($: EngineInterface) {
  try {
    await seedFromTranscript($)
  } catch (error) {
    $.ui.log(`${PLUGIN}: could not read earlier prompts: ${String(error)}`)
  }
  lastText ??= (await read($, prompts)).at(-1)?.text
}

export function registerHistory(on: On) {

  on('prompt.submit', async ($, e, next) => {
    const isOwn =
      !e.command && !e.isMeta && isOwnOrigin(e.origin) && !HOST_EVENT.test(e.text)
    const text = e.text.trim()

    if (!isOwn || text === '') return next(e)

    // Set before next: the transcript row can be drawn before next resolves.
    const previous = { lastText, latestRowId, lastOffScreen }
    lastText = text
    latestRowId = undefined
    lastOffScreen = null

    const ran = await next(e)

    if (ran.drop !== undefined) {
      ;({ lastText, latestRowId, lastOffScreen } = previous)

      return ran
    }
    const prompt: PinnedPrompt = {
      id: await $.clock.now(),
      text,
      images: e.attachments?.length ?? 0,
    }
    await update($, prompts, list => [...list, prompt].slice(-LIMIT))
    await update($, stepsBack, () => 0)
    await update($, isOffScreen, () => null)

    return ran
  }).catch(($, e, next) => next(e)) // a pin failure must never block a prompt

  on('command.run', { command: 'prompts' }, async $ => {
    await openPane($)

    return { text: 'Prompt history opened.' }
  })

  on('command.run', { command: 'pin-prompt' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'smart') {
      const isOn = !(await read($, isSmart))
      await update($, isSmart, () => isOn)

      return {
        text: isOn
          ? 'Smart mode on: the pin shows once your prompt scrolls out of view.'
          : 'Smart mode off: the pin always shows.',
      }
    }
    await update($, stepsBack, () => 0)

    return { text: 'Pin back on your newest prompt.' }
  })

  // Smart mode: watch the newest prompt's own transcript row. A render hook
  // may not write state, so the write goes out on its own clock dispatch.
  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    // No origin filter: a row read back from a stored transcript can arrive
    // `unclassified`, and only rows whose text matches a pinned prompt are used.
    rowIds.set(rowKey(e.props.text), e.requestId)
    if (!seenRows.has(e.requestId)) {
      seenRows.add(e.requestId)
      const isNewest = lastText !== undefined && sameText(e.props.text, lastText)
      if (isNewest) latestRowId = e.requestId
    }
    const onScreen = e.props.onScreen
    if (e.requestId === latestRowId && onScreen !== undefined) {
      const isOff = onScreen === null
      if (isOff !== lastOffScreen) {
        lastOffScreen = isOff
        $.clock.after(0, () => {
          void update($, isOffScreen, () => isOff)
        })
      }
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, prompts)
    const width = Math.max(20, e.props.bodyColumns - 6)

    if (list.length === 0) {
      return <Text dimColor>No prompts yet.</Text>
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Text dimColor>Newest first. Click one to copy it.</Text>
        {[...list].reverse().map((prompt, i) => (
          <Button
            key={`p${prompt.id}`}
            plain
            onPress={press => copyPrompt($, prompt.text, press.surface)}
          >
            <Text dimColor>{list.length - i}. </Text>
            {clip(prompt.text, width)}
            {imageTag(prompt.images)}
          </Button>
        ))}
      </Box>
    )
  })
}

// The history row of the strip above the box: the newest prompt, or the
// earlier one ▲ ▼ stepped to, laid out like a sent message (text at the right
// edge, the controls at the left). Undefined where it has nothing to show.
export async function drawHistory($: EngineInterface, e: RenderInput<'AbovePrompt'>) {
  const list = await read($, prompts)
  const back = Math.min(await read($, stepsBack), list.length - 1)
  const shown = list[list.length - 1 - back]
  if (shown === undefined) return undefined

  const isInView = (await read($, isOffScreen)) === false
  if (back === 0 && isInView && (await read($, isSmart))) return undefined

  const { Box, Button, Text } = $.ui.resolve(e)
  // The desktop app answers a transcript scroll "transcript not scrollable
  // here", so Go to is offered only where the chat can be scrolled.
  const canGoTo = e.surface === 'terminal'
  const controls = CONTROL_COLUMNS + (canGoTo ? GO_TO_COLUMNS : 0)
  const room = Math.max(40, (e.props.bodyColumns - controls) * BAND_LINES)
  const hasOlder = back < list.length - 1
  const hasNewer = back > 0

  return (
    <Box flexDirection="row" alignItems="center" gap={2}>
      <Box flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
        <Button
          key="older"
          plain
          dimColor={!hasOlder}
          label="▲"
          onPress={() => step($, 1)}
        />
        <Button
          key="newer"
          plain
          dimColor={!hasNewer}
          label="▼"
          onPress={() => step($, -1)}
        />
        <Text dimColor>{`${list.length - back}/${list.length}`}</Text>
        {canGoTo && (
          <Button
            key="goto"
            plain
            dimColor
            label="Go to"
            onPress={() => goToRow($, shown.text)}
          />
        )}
      </Box>
      <Box flexGrow={1} flexShrink={1} justifyContent="flex-end">
        <Text wrap="wrap">
          {clip(shown.text, room)}
          {imageTag(shown.images)}
        </Text>
      </Box>
    </Box>
  )
}
