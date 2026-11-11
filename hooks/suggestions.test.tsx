import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelUsage, On, RenderSurface } from 'claude-code'

const WARM: ModelUsage = {
  input_tokens: 40,
  output_tokens: 300,
  cache_read_input_tokens: 90_000,
  cache_creation_input_tokens: 2_000,
}
const COLD: ModelUsage = { ...WARM, cache_creation_input_tokens: 25_000 }

interface Message {
  role: 'user' | 'assistant'
  text: string
  toolUses: []
}

interface World {
  surfaces: RenderSurface[]
  reply: string
  draft: string
  messages?: Message[]
  // Model replies given out first, before `reply`.
  replies?: string[]
  // Held open, the model is still thinking.
  gate?: Promise<void>
  // The plugin's store as an earlier session left it.
  store?: Record<string, unknown>
}

const HINT = {
  plugin: 'steady-suggest',
  component: 'PromptHint',
  requestId: 'hint',
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
} as const

const MESSAGES: Message[] = [
  { role: 'user', text: 'can we add a toggle?', toolUses: [] },
  { role: 'assistant', text: 'Added it.', toolUses: [] },
  { role: 'user', text: '<system-reminder>noise</system-reminder>', toolUses: [] },
]

// The hooks here stand for the engine beneath the mod.
function engine(on: On, world: World) {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const seen = { asks: [] as string[], models: [] as string[], caps: [] as (number | undefined)[], efforts: [] as (string | undefined)[], shown: [] as string[], fills: [] as string[], statuses: [] as (string | undefined)[], toasts: [] as string[] }
  const files = new Map<string, string>()
  const store = new Map<string, unknown>(Object.entries(world.store ?? {}))

  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)

    return { value: undefined }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'abcdef0123456789' }))
  on('session.surfaces', () => ({ value: world.surfaces }))
  on('session.messages', () => ({ value: world.messages ?? MESSAGES }))
  on('prompt.read', () => ({ value: { text: world.draft, cursor: 0 } }))
  on('model.complete', async (_, e) => {
    seen.asks.push(e.prompt)
    seen.models.push(e.model)
    seen.caps.push(e.maxTokens)
    seen.efforts.push(e.effort)
    await world.gate
    const usage = { ...WARM, cache_read_input_tokens: 0 }

    return { value: { isAnswered: true, text: world.replies?.shift() ?? world.reply, usage } }
  })
  // The prompt box, empty and idle.
  on('prompt.suggest', (_, e) => {
    seen.shown.push(e.text)

    return { isShown: true }
  })
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error('missing')

    return { value: text }
  })
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)

    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('prompt.fill', (_, e) => {
    seen.fills.push(e.text)

    return { isFilled: true }
  })
  on('ui.status', (_, e) => {
    seen.statuses.push(e.text)

    return { value: undefined }
  })
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  // The engine's own hint line, drawn when the mod passes.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{e.component === 'PromptHint' ? e.props.hint : 'engine'}</Text>
  })

  return { clock, seen, files, store }
}

async function turn($: Engine, usage: ModelUsage, answer = 'The toggle is in. Want me to commit it?') {
  await $.turn.start({ text: 'go', turnId: 't' })
  const step = $.turn.step({ turnId: 't', index: 0, model: 'opus', messageCount: 4 })
  for await (const _ of step) void _
  await $.turn.complete({
    answer,
    durationMs: 5_000,
    isAborted: false,
    turnId: 't',
    reason: 'answer',
    usage: { ...usage, model: 'opus' },
  })

  return usage
}

function stepWith(on: On, usage: ModelUsage) {
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'done',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { ...usage, model: 'opus' },
    }
  })
}

// Settle, then the hint line's minimum time up, then the suggestion.
const SHOWS = 2_500

const BAND = {
  plugin: 'steady-suggest',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const DESKTOP: World = { surfaces: ['desktop'], reply: 'commit it', draft: '' }

function slash(args: string) {
  return {
    command: 'suggest',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  } as const
}

test('a cold-cache turn gets a filled-in suggestion on the desktop', async ($, on) => {
  const { clock, seen, files } = engine(on, DESKTOP)
  stepWith(on, COLD)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await turn($, COLD)
  await clock.advance(SHOWS)

  expect(seen.shown).toEqual(['commit it'])
  // Nudge, the default, is Sonnet's.
  expect(seen.models).toEqual(['claude-sonnet-5-5'])
  expect(seen.caps).toEqual([1_024])
  expect(seen.efforts).toEqual(['low'])
  expect(seen.asks[0]).toContain('1. can we add a toggle?')
  expect(seen.asks[0]).not.toContain('system-reminder')
  expect([...files.values()][0]).toContain('shown (cold cache): commit it')
})

test('a warm desktop turn is filled in too, and the log says why', async ($, on) => {
  const { clock, seen, files } = engine(on, DESKTOP)
  stepWith(on, WARM)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await turn($, WARM)
  await clock.advance(SHOWS)

  expect(seen.shown).toEqual(['commit it'])
  const log = [...files.values()][0]
  expect(log).toMatch(/turn \d+: app; \[desktop\], fresh 340, new cache 2000/)
  expect(log).toContain('shown (app): commit it')
})

test('the terminal fills in only when its own suggestion stayed away', async ($, on) => {
  const { clock, seen } = engine(on, { ...DESKTOP, surfaces: ['terminal'] })
  stepWith(on, WARM)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await turn($, WARM)
  await $.prompt.suggest({ text: 'push it', origin: { kind: 'suggestion' } })
  await clock.advance(20_000)
  expect(seen.asks).toEqual([])

  await turn($, WARM)
  await clock.advance(20_000)
  expect(seen.shown).toEqual(['push it', 'commit it'])
})

test('a reply that fails the checks, or a new turn, shows nothing', async ($, on) => {
  const world = { ...DESKTOP, reply: "Let me know if you'd like anything else." }
  const { clock, seen, files } = engine(on, world)
  stepWith(on, COLD)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await turn($, COLD)
  await clock.advance(SHOWS)
  expect(seen.shown).toEqual([])
  expect([...files.values()][0]).toMatch(/dropped claude_voice/)

  world.reply = 'run the tests'
  await turn($, COLD)
  await $.turn.start({ text: 'next', turnId: 'u' })
  await clock.advance(SHOWS)
  expect(seen.shown).toEqual([])
})

test('/suggest reports what happened and has no off switch', async ($, on) => {
  const { clock, seen } = engine(on, DESKTOP)
  stepWith(on, COLD)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await turn($, COLD)
  await clock.advance(SHOWS)
  const report = await $.command.run(slash(''))
  expect(report.text).toContain('always on. Mode: Nudge')
  expect(report.text).toContain('This session:')
  expect(report.text).toContain('shown (cold cache): commit it')

  await $.command.run(slash('off'))
  await turn($, COLD)
  await clock.advance(SHOWS)
  expect(seen.shown).toEqual(['commit it', 'commit it'])
})

test('a guess that fails the checks gets a second try', async ($, on) => {
  const { clock, seen } = engine(on, { ...DESKTOP, replies: ['Let me commit it.'] })
  stepWith(on, COLD)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await turn($, COLD)
  await clock.advance(SHOWS)
  expect(seen.asks[1]).toContain('was rejected (claude_voice)')
  expect(seen.shown).toEqual(['commit it'])
})

test('a run with no prompt box on screen asks for nothing', async ($, on) => {
  const { clock, seen } = engine(on, { ...DESKTOP, surfaces: [] })
  stepWith(on, COLD)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: false })

  await turn($, COLD)
  await clock.advance(20_000)

  expect(seen.asks).toEqual([])
  const report = await $.command.run(slash(''))
  expect(report.text).toMatch(/turn \d+: no prompt box; \[\]/)
})

test('a turn that ends while its chat is hidden fills in when the chat opens', async ($, on) => {
  const world = { ...DESKTOP, surfaces: [] as RenderSurface[] }
  const { clock, seen, files } = engine(on, world)
  stepWith(on, WARM)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await turn($, WARM)
  await clock.advance(20_000)
  expect(seen.asks).toEqual([])

  world.surfaces = ['desktop']
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await clock.advance(SHOWS)
  expect(seen.shown).toEqual(['commit it'])
  expect([...files.values()][0]).toContain('shown (chat opened): commit it')

  // The window clears it on leaving, so a return shows it again, unasked.
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await clock.advance(SHOWS)
  expect(seen.shown).toEqual(['commit it', 'commit it'])
  expect(seen.asks).toHaveLength(1)
})

test('a chat reopened after a restart suggests from its last reply, asked once', async ($, on) => {
  const { clock, seen, files } = engine(on, DESKTOP)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await clock.advance(SHOWS)
  // The session's text sits in blocks whose tags share an id made for this ask.
  expect(seen.asks[0]).toMatch(/<reply id="(\w+)">\nAdded it\.\n<\/reply id="\1">/)
  expect(seen.shown).toEqual(['commit it'])
  expect([...files.values()][0]).toContain('shown (chat reopened): commit it')

  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await clock.advance(SHOWS)
  expect(seen.shown).toEqual(['commit it', 'commit it'])
  expect(seen.asks).toHaveLength(1)
})

test('a reopened chat whose last word is the person\'s own gets nothing', async ($, on) => {
  const messages: Message[] = [
    { role: 'assistant', text: 'Added it.', toolUses: [] },
    { role: 'user', text: 'now push it', toolUses: [] },
  ]
  const { clock, seen } = engine(on, { ...DESKTOP, messages })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await clock.advance(SHOWS)
  expect(seen.asks).toEqual([])
})

test('the hint line says a suggestion is on its way, then gives the line back', async ($, on) => {
  let release = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const { clock, seen } = engine(on, { ...DESKTOP, gate })
  stepWith(on, WARM)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await turn($, WARM)
  await clock.advance(500)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...HINT, surface })
    expect(await ui.find({ type: 'Text', text: /Thinking of a suggestion/ })).toBeDefined()
    await ui.unmount()
  }
  // The person typing gets the engine's line back at once.
  const typing = await $.ui.mount({ ...HINT, surface: 'desktop', props: { ...HINT.props, isDraft: true } })
  expect(await typing.find({ type: 'Text', text: '? for shortcuts' })).toBeDefined()
  await typing.unmount()

  // A quick answer still leaves the line up long enough to be seen.
  release()
  await clock.advance(10)
  expect(seen.shown).toEqual([])
  const held = await $.ui.mount({ ...HINT, surface: 'desktop' })
  expect(await held.find({ type: 'Text', text: /Thinking of a suggestion/ })).toBeDefined()
  await held.unmount()

  await clock.advance(2_000)
  expect(seen.shown).toEqual(['commit it'])
  // Then the desktop line offers the guess for a click; the terminal keeps its own.
  const ui = await $.ui.mount({ ...HINT, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Thinking/ })).toBeUndefined()
  await ui.press({ key: 'take' })
  expect(seen.fills).toEqual(['commit it'])
  await ui.unmount()
  const terminal = await $.ui.mount({ ...HINT, surface: 'terminal' })
  expect(await terminal.find({ type: 'Text', text: '? for shortcuts' })).toBeDefined()
})

test('a prompt box drawn anew gets the suggestion again, unasked', async ($, on) => {
  const { clock, seen, files } = engine(on, DESKTOP)
  stepWith(on, WARM)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await turn($, WARM)
  await clock.advance(SHOWS)
  expect(seen.shown).toEqual(['commit it'])

  const first = await $.ui.mount({ ...HINT, surface: 'desktop', requestId: 'box-1' })
  await clock.advance(SHOWS)
  // Drawing the same box again is not a new box.
  await first.unmount()
  await $.ui.mount({ ...HINT, surface: 'desktop', requestId: 'box-1' })
  await clock.advance(SHOWS)
  expect(seen.shown).toEqual(['commit it', 'commit it'])
  expect(seen.asks).toHaveLength(1)
  expect([...files.values()][0]).toContain('prompt box drawn: showing the guess again')
})

test('the status line under the box is left alone', async ($, on) => {
  const { clock, seen } = engine(on, DESKTOP)
  stepWith(on, WARM)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await turn($, WARM)
  await clock.advance(SHOWS)
  await $.turn.start({ text: 'next', turnId: 'u' })

  expect(seen.shown).toEqual(['commit it'])
  expect(seen.statuses).toEqual([])
})

test('every return to a chat shows its suggestion again, but never mid-turn or twice at once', async ($, on) => {
  const { clock, seen } = engine(on, DESKTOP)
  stepWith(on, WARM)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  // Opened while the turn's own fill-in is still on its way: one guess only.
  await turn($, WARM)
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await clock.advance(SHOWS)
  expect(seen.asks).toHaveLength(1)
  expect(seen.shown).toEqual(['commit it'])

  for (let i = 0; i < 2; i += 1) {
    await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
    await clock.advance(SHOWS)
  }
  expect(seen.shown).toEqual(['commit it', 'commit it', 'commit it'])
  expect(seen.asks).toHaveLength(1)

  // While the next turn runs, a return shows nothing.
  await $.turn.start({ text: 'next', turnId: 'u' })
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await clock.advance(SHOWS)
  expect(seen.shown).toHaveLength(3)
})

test('a return after the model stayed silent does not ask again', async ($, on) => {
  const { clock, seen } = engine(on, { ...DESKTOP, reply: '' })
  stepWith(on, WARM)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await turn($, WARM)
  await clock.advance(SHOWS)
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await clock.advance(SHOWS)
  expect(seen.shown).toEqual([])
  // Silence stands: no second try for the turn, none on the return.
  expect(seen.asks).toHaveLength(1)
})

test('the hint line says the mod runs here until there is a guess, then offers it until the next turn', async ($, on) => {
  const { clock, seen } = engine(on, DESKTOP)
  stepWith(on, WARM)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const before = await $.ui.mount({ ...HINT, surface: 'desktop' })
  expect(await before.find({ type: 'Text', text: '✦ Suggestions by steady-suggest (Sonnet 5.5)' })).toBeDefined()
  await before.unmount()

  await turn($, WARM)
  await clock.advance(SHOWS)
  const after = await $.ui.mount({ ...HINT, surface: 'desktop' })
  await after.press({ key: 'take' })
  expect(seen.fills).toEqual(['commit it'])
  await after.unmount()

  await $.turn.start({ text: 'next', turnId: 'u' })
  const next = await $.ui.mount({ ...HINT, surface: 'desktop', props: { ...HINT.props } })
  expect(await next.find({ type: 'Text', text: '✦ Suggestions by steady-suggest (Sonnet 5.5)' })).toBeDefined()
})

test('the band says a suggestion is on its way, then offers it, then clears on the next turn', async ($, on) => {
  let release = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const { clock } = engine(on, { ...DESKTOP, gate })
  stepWith(on, WARM)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await turn($, WARM)
  await clock.advance(500)
  const thinking = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await thinking.find({ type: 'Text', text: 'Thinking of a suggestion…' })).toBeDefined()
  expect(await thinking.find({ type: 'Text', text: 'engine' })).toBeDefined()
  await thinking.unmount()

  release()
  await clock.advance(SHOWS)
  const ready = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ready.find({ type: 'Text', text: /Thinking/ })).toBeUndefined()
  expect(await ready.find({ key: 'take-above' })).toBeDefined()
  await ready.unmount()

  await $.turn.start({ text: 'next', turnId: 'u' })
  const next = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await next.find({ key: 'take-above' })).toBeUndefined()
})

test('the band above the box offers the suggestion for a click, under any other plugin\'s band', async ($, on) => {
  const { clock, seen } = engine(on, DESKTOP)
  stepWith(on, WARM)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const empty = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await empty.find({ key: 'take-above' })).toBeUndefined()
  await empty.unmount()

  await turn($, WARM)
  await clock.advance(SHOWS)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: 'engine' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '✦' })).toBeDefined()
  // A bare guess has no reason or summary, so no dim line under it.
  expect(await band.find({ type: 'Text', text: /Last reply/ })).toBeUndefined()
  await band.press({ key: 'take-above' })
  expect(seen.fills).toEqual(['commit it'])
  await band.unmount()

  const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await terminal.find({ key: 'take-above' })).toBeUndefined()
})

test('the band gives the latest reply in a few words and why the guess fits', async ($, on) => {
  const reply = [
    'NEXT: commit it',
    'WHY: The toggle works and Claude offered to commit.',
    '**SUMMARY:** Added the settings toggle and asked whether to commit.',
  ].join('\n')
  const { clock, seen, files } = engine(on, { ...DESKTOP, reply })
  stepWith(on, WARM)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await turn($, WARM)
  await clock.advance(SHOWS)
  expect(seen.asks[0]).toContain('NEXT: the suggestion')
  expect(seen.shown).toEqual(['commit it'])
  expect([...files.values()][0]).toContain('shown (app): commit it (why: The toggle works')

  // Layout B: the guess, then the reason and the summary on one dim line.
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: /Last reply/ }))?.text).toBe(
    'The toggle works and Claude offered to commit. · Last reply: Added the settings toggle and asked whether to commit.',
  )
  await band.press({ key: 'take-above' })
  expect(seen.fills).toEqual(['commit it'])
  await band.unmount()

  // The next turn clears all three.
  await $.turn.start({ text: 'next', turnId: 'u' })
  const next = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await next.find({ type: 'Text', text: /Last reply|toggle works/ })).toBeUndefined()
})

test('an empty NEXT line is the model staying silent', async ($, on) => {
  const reply = 'NEXT:\nWHY: Claude built the wrong thing.\nSUMMARY: The build broke.'
  const { clock, seen, files } = engine(on, { ...DESKTOP, reply })
  stepWith(on, WARM)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await turn($, WARM)
  await clock.advance(SHOWS)
  expect(seen.shown).toEqual([])
  // It is not asked to guess again, and the log keeps its reason.
  expect(seen.asks).toHaveLength(1)
  expect([...files.values()][0]).toContain('silent (app, claude-sonnet-5-5): Claude built the wrong thing.')
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: /The build broke/ })).toBeUndefined()
})

const BRIEF =
  'Build the onboarding screens from the canvas with our Lib components, wire them to the auth API, ' +
  'add unit tests for the form checks, run just those specs, and keep going until the flow works end ' +
  'to end on localhost without checking in unless blocked.'
const LONG_REPLY = `NEXT: ${BRIEF}\nWHY: The designs are settled.\nSUMMARY: Drew the onboarding screens.`

test('/suggest thorough asks for a whole task, keeps it, and draws a long guess wrapped', async ($, on) => {
  const { clock, seen, store } = engine(on, { ...DESKTOP, reply: LONG_REPLY })
  stepWith(on, WARM)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const set = await $.command.run(slash('autopilot'))
  // Before any turn the transcript's last reply is asked about again.
  expect(set.text).toBe('Suggestion mode: Autopilot (Fable 5.2). Writing a new suggestion for this reply.')
  expect(store.get('length')).toBe('thorough')

  await turn($, WARM)
  await clock.advance(SHOWS)
  expect(seen.asks[0]).toContain('keep going until it gets there')
  expect(seen.asks[0]).toContain('Leave out steps that are hard to undo')
  expect(seen.shown).toEqual([BRIEF])
  // Every Autopilot brief is Fable's.
  expect(seen.models.length).toBeGreaterThan(0)
  expect([...new Set(seen.models)]).toEqual(['claude-fable-5-2'])
  expect([...new Set(seen.caps)]).toEqual([8_000])
  expect([...new Set(seen.efforts)]).toEqual(['high'])

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: BRIEF })).toBeDefined()
  expect(await band.find({ key: 'length' })).toBeDefined()
  await band.press({ key: 'take-above' })
  expect(seen.fills).toEqual([BRIEF])
  await band.unmount()

  expect((await $.command.run(slash('mode loud'))).text).toContain('Unknown option "loud"')
  // The old names still work.
  expect((await $.command.run(slash('medium'))).text).toContain('Suggestion mode: Push (Opus 5.5).')
  expect(store.get('length')).toBe('medium')
})

test('the dropdown on the band asks again at the new length, where a long guess is refused', async ($, on) => {
  const { clock, seen, store, files } = engine(on, { ...DESKTOP, reply: LONG_REPLY, store: { length: 'thorough' } })
  stepWith(on, WARM)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  // A new session starts at the length kept from the last one.
  await turn($, WARM)
  await clock.advance(SHOWS)
  expect(seen.shown).toEqual([BRIEF])

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.select({ key: 'length', value: 'short' })
  expect(store.get('length')).toBe('short')
  await clock.advance(SHOWS)
  // Short asks for 2 to 8 words, so the long reply is dropped twice.
  expect(seen.asks).toHaveLength(3)
  expect(seen.asks[1]).toContain('2 to 8 words')
  // The second try is told what was wrong with the first.
  expect(seen.asks[2]).toContain('was rejected (too_many_words): it must be well under 12 words')
  // The new mode's model writes the new guess.
  expect(seen.models).toEqual(['claude-fable-5-2', 'claude-sonnet-5-5', 'claude-sonnet-5-5'])
  expect(seen.shown).toEqual([BRIEF])
  expect([...files.values()][0]).toContain('dropped too_many_words (length changed, claude-sonnet-5-5)')
  expect([...files.values()][0]).toContain('length short: asking again')
})

test('a thorough guess may name a glob, and a very long one is cut short in the band only', async ($, on) => {
  const glob = `Run test/unit/*.spec.ts for the band. ${'Then keep checking each part of the flow. '.repeat(17)}`.trim()
  const { clock, seen } = engine(on, { ...DESKTOP, reply: `NEXT: ${glob}`, store: { length: 'thorough' } })
  stepWith(on, WARM)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await turn($, WARM)
  await clock.advance(SHOWS)
  expect(glob.length).toBeGreaterThan(600)
  expect(seen.shown).toEqual([glob])

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: /^Run test\/unit/ }))?.text).toMatch(/…$/)
  await band.press({ key: 'take-above' })
  expect(seen.fills).toEqual([glob])
})

test('a long guess may mention silence in passing, a short one that is only about it is dropped', async ($, on) => {
  const brief =
    'Replay the three modes on the audit turns from the log and check that the credential silence is ' +
    'gone, that Nudge stays silent when Claude is waiting on me, and that nothing claims I ran a command.'
  const world = { ...DESKTOP, reply: `NEXT: ${brief}`, store: { length: 'thorough' } }
  const { clock, seen, files } = engine(on, world)
  stepWith(on, WARM)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await turn($, WARM)
  await clock.advance(SHOWS)
  expect(seen.shown).toEqual([brief])

  world.reply = 'NEXT: silence is best here'
  await turn($, WARM)
  await clock.advance(SHOWS)
  expect(seen.shown).toEqual([brief])
  expect([...files.values()][0]).toContain('dropped meta_text (app, claude-fable-5-2): silence is best here')
})

test('a medium guess may run to two sentences', async ($, on) => {
  const medium = 'Run the band specs again. Then restart the app and check the switch.'
  const { clock, seen } = engine(on, { ...DESKTOP, reply: `NEXT: ${medium}`, store: { length: 'medium' } })
  stepWith(on, WARM)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await turn($, WARM)
  await clock.advance(SHOWS)
  expect(seen.asks[0]).toContain('10 to 40 words')
  expect(seen.models).toEqual(['claude-opus-5-5'])
  expect(seen.caps).toEqual([2_048])
  expect(seen.efforts).toEqual(['medium'])
  expect(seen.shown).toEqual([medium])
})

test('Less folds the band to one line and remembers it; More brings it all back', async ($, on) => {
  const { clock, seen, store } = engine(on, { ...DESKTOP, reply: LONG_REPLY, store: { length: 'thorough' } })
  stepWith(on, WARM)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await turn($, WARM)
  await clock.advance(SHOWS)
  const full = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await full.find({ type: 'Text', text: BRIEF })).toBeDefined()
  await full.press({ key: 'collapse' })
  expect(store.get('compact')).toBe(true)
  await full.unmount()

  // One line: the brief cut short, no reason line, no dropdown; Use it still
  // fills the whole brief.
  const folded = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await folded.find({ type: 'Text', text: /^Build the onboarding/ }))?.text).toMatch(/…$/)
  expect(await folded.find({ type: 'Text', text: /Last reply/ })).toBeUndefined()
  expect(await folded.find({ key: 'length' })).toBeUndefined()
  await folded.press({ key: 'take-above' })
  expect(seen.fills).toEqual([BRIEF])
  await folded.press({ key: 'expand' })
  expect(store.get('compact')).toBe(false)
  await folded.unmount()

  expect((await $.command.run(slash('compact'))).text).toBe('Suggestions fold to one line.')
  expect((await $.command.run(slash(''))).text).toContain('View: one line')
})

test('a new session starts folded when the last one was', async ($, on) => {
  const { clock } = engine(on, { ...DESKTOP, store: { compact: true } })
  stepWith(on, WARM)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await turn($, WARM)
  await clock.advance(SHOWS)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  // A short guess stays a button you click, with More beside it.
  expect(await band.find({ key: 'take-above' })).toBeDefined()
  expect(await band.find({ key: 'expand' })).toBeDefined()
  expect(await band.find({ key: 'collapse' })).toBeUndefined()
})
