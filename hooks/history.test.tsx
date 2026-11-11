import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const
const SCROLL = { offset: 0, bodyRows: 20 }

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
    scroll: SCROLL,
    view: {},
  },
} as const

const PANE = {
  plugin: 'steady-suggest',
  component: 'Pane',
  requestId: 'prompt-history',
  props: {
    title: 'Prompts',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: SCROLL,
    view: {},
  },
} as const

// The hooks here stand for the engine beneath the mod.
function engine(on: On, history: { role: 'user' | 'assistant'; text: string }[] = []) {
  const seen = { copied: [] as string[], toasts: [] as string[] }
  let now = 1000

  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_, e) => {
    seen.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.copy', (_, e) => {
    seen.copied.push(e.text)

    return { value: { isCopied: true } }
  })
  on('clock.now', () => ({ value: (now += 1) }))
  on('session.messages', () => ({
    value: history.map(row => ({ ...row, toolUses: [] })),
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  // The engine's own band, drawn when the mod passes.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  return seen
}

function typed(text: string) {
  return { text, wait: false, origin: { kind: 'composer' } } as const
}

const COUNTER = { type: 'Text', text: /^\d+\/\d+$/ } as const

test('the newest prompt is pinned; ▲ ▼ step through earlier ones', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit(typed('first question'))
  await $.prompt.submit(typed('can we pin   my last\nprompt?'))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /can we pin my last prompt\?/ })).toBeDefined()
    expect((await ui.find(COUNTER))?.text).toBe('2/2')

    await ui.press({ key: 'older' })
    expect(await ui.find({ type: 'Text', text: /first question/ })).toBeDefined()
    expect((await ui.find(COUNTER))?.text).toBe('1/2')

    await ui.press({ key: 'older' })
    expect((await ui.find(COUNTER))?.text).toBe('1/2')

    await ui.press({ key: 'newer' })
    expect((await ui.find(COUNTER))?.text).toBe('2/2')
    await ui.unmount()
  }
})

test('prompts the person did not type are not pinned', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit(typed('mine'))
  await $.prompt.submit({ ...typed('a task finished'), origin: { kind: 'task-notification' } })
  await $.prompt.submit({ ...typed('<side-sessions-event>x</side-sessions-event>'), origin: { kind: 'sdk' } })
  await $.prompt.submit({ ...typed('also mine, from the app'), origin: { kind: 'sdk' } })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /also mine, from the app/ })).toBeDefined()
  expect((await ui.find(COUNTER))?.text).toBe('2/2')
  await ui.unmount()
})

test('a new prompt brings the pin back to the newest', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit(typed('one'))
  await $.prompt.submit(typed('two'))

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'older' })
  expect((await ui.find(COUNTER))?.text).toBe('1/2')
  await ui.unmount()

  await $.prompt.submit(typed('three'))
  const again = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await again.find({ type: 'Text', text: /three/ })).toBeDefined()
  expect((await again.find(COUNTER))?.text).toBe('3/3')
  await again.unmount()
})

// The kit draws no transcript, so a row scroll cannot land here; what this
// shows is that Go to finds the shown prompt's row and asks for it.
test('Go to shows on the terminal only, and asks for the shown prompt’s row', async ($, on) => {
  const seen = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit(typed('find the bug'))
  await $.prompt.submit(typed('now fix it'))

  const row = await $.ui.mount({
    plugin: 'steady-suggest',
    component: 'UserMessage',
    requestId: 'row-1',
    surface: 'terminal',
    props: { text: 'find the bug', origin: { kind: 'unclassified' }, isExpanded: true },
  })
  await row.unmount()

  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await desktop.find({ key: 'goto' })).toBeUndefined()
  await desktop.unmount()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'goto' })
  expect(seen.toasts.at(-1)).toBe('That message is not in the chat view')

  await ui.press({ key: 'older' })
  await ui.press({ key: 'goto' })
  expect(seen.toasts.at(-1)).toMatch(/^Could not scroll there: .*ui\.scroll/)
  await ui.unmount()
})

test('the pane lists every prompt, newest first', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit(typed('alpha'))
  await $.prompt.submit(typed('beta'))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const rows = await ui.find({ type: 'Button', text: /^\d+\. / })
    expect(rows?.text).toBe('2. beta')
    await ui.unmount()
  }
})

test('a resumed session pins the transcript’s last prompt', async ($, on) => {
  engine(on, [
    { role: 'user', text: 'older ask' },
    { role: 'assistant', text: 'done' },
    { role: 'user', text: 'newest ask<system-reminder>hidden</system-reminder>' },
    { role: 'user', text: '<ci-monitor-event>noise</ci-monitor-event>' },
    { role: 'user', text: 'Base directory for this skill: /tmp/x' },
    { role: 'user', text: '[Request interrupted by user]' },
  ])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /newest ask/ }))?.text).toBe('newest ask')
  expect((await ui.find(COUNTER))?.text).toBe('2/2')
  await ui.unmount()
})

test('a band drawn beneath the pin gets its own line in the same bar', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit(typed('first question'))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /first question/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
  await ui.unmount()
})
