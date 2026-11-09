import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, On, RenderInput, SessionMessage } from 'claude-code'

import type { Length } from '../types'

const PLUGIN = 'steady-suggest'
// Opus at the person's request (2026-11-03): with the app's own suggestion
// turned off nothing races it, so a slower, better guess is fine while the
// band above the box says one is on its way.
const MODEL = 'opus'
const THINKING = 'Thinking of a suggestion'
// The terminal hint line's idle text. The status line under the box carried it
// too until the person had that line removed (2026-11-04): the band above the
// box already shows the guess.
const BADGE = `✦ Suggestions by steady-suggest (${MODEL})`
// The line stays up at least this long: a quick answer flashed it by too fast
// to notice (the person's report, 2026-11-03).
const THINKING_MIN_MS = 2_000
// Three dots that pulse in turn, in Claude's orange so they stand out from the
// grey hint text; it reads on light and dark themes.
const CLAY = '#d97757'
const DOTS = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="8" viewBox="0 0 26 8">',
  ...[0, 1, 2].map(i =>
    `<circle cx="${4 + i * 9}" cy="4" r="3" fill="${CLAY}" opacity="0.3">` +
    `<animate attributeName="opacity" values="0.3;1;0.3" dur="1.2s" begin="${i * 0.2}s" repeatCount="indefinite"/>` +
    '</circle>'),
  '</svg>',
].join('')

const isThinking = atom({ plugin: 'steady-suggest', key: 'isThinking' } as const, false)
// The desktop app hides the box's own suggestion in any chat that draws the
// wrap-up card (its composer drops it while the turn box is drawn and the chat
// has wrap_up), which is most chats. So the guess also sits in the band above
// the box, where a click puts it in the box.
const suggestion = atom({ plugin: 'steady-suggest', key: 'suggestion' } as const, null)
// A few words on Claude's latest reply and why the guess fits, so the band
// gives context at a glance (the person's ask, 2026-11-05).
const detail = atom({ plugin: 'steady-suggest', key: 'detail' } as const, null)
const lengthChoice = atom({ plugin: 'steady-suggest', key: 'length' } as const, 'short')
// The guess folded to one line (the person's ask, 2026-11-06: a long guess
// took over the screen). Kept across sessions in the store.
const compactChoice = atom({ plugin: 'steady-suggest', key: 'isCompact' } as const, false)
// Claude Code drops its own suggestion when the turn's last response wrote
// more than this many fresh tokens (its `cache_cold` check).
const COLD_TOKENS = 10_000
// The terminal's own suggestion shows through `prompt.suggest`; this long
// without one there means it skipped the turn.
const BUILT_IN_WAIT_MS = 10_000
// `turn.complete` can fire before the turn stops counting as running, and the
// box refuses a suggestion while it runs.
const SETTLE_MS = 400
const RETRY_MS = 1_500
const LOG_LINES = 500
const RECENT = 8
// A guess that is empty or fails the checks gets one more try.
const GUESSES = 2

// What the transcript wraps around the person's own prompts.
const HOST_EVENT = /^\s*<[a-z][\w-]*[\s>]/i
const ENGINE_WRAPPERS =
  /<(system-reminder|local-command-[\w-]+|command-[\w-]+)\b[^>]*>[\s\S]*?<\/\1>/g
const ENGINE_ROW =
  /^(Base directory for this skill:|\[Request interrupted|Caveat: The messages below)/

// What the model is told about writing a guess. It guesses even when the
// next step is unclear (showing up every turn is the point of this mod); the
// size comes from the chosen length, and it also writes the band's reason and
// summary.
const CORE = `You are writing the next message a developer will send to Claude Code, the coding assistant they are working with.
Read their recent prompts and Claude's latest reply, then write what they are most likely to type next, in their own voice.
Aim for the message they would recognise as the step they were about to take, not advice of your own.
Good next steps look like this:
- Claude fixed the bug they reported and offered to run the tests: "run the tests"
- Claude finished writing code: "try it out"
- Claude laid out options: the one they would most likely pick, judging by the conversation
- Claude asked whether to continue: "go ahead"
- The task is done and the follow-up is obvious: "commit this"
A concrete step ("run the tests") beats a vague one ("continue").
Do not write:
- praise or thanks ("looks good", "thanks")
- questions ("what about...?")
- words in Claude's voice ("Let me...", "I'll...", "Here's...")
- ideas the conversation has not raised
If Claude just hit an error or misunderstood them, write nothing: they will want to set it straight themselves.
If the next step is merely unclear, still give your best guess.
Write nothing if a suggestion could be unsafe or inappropriate, including on sensitive topics (security incidents, credentials, harm, private data).`

// NEXT comes first so a reply cut short still carries the guess.
const REPLY_FORMAT = `Reply in exactly three lines, no quotes or other text:
NEXT: the suggestion, on one line, or nothing after the colon to stay silent
WHY: one short sentence, under 15 words, on why they would type it next
SUMMARY: Claude's latest reply in under 15 words`

interface LengthRule {
  // How the guess is asked for, after the shared instructions.
  format: string
  maxWords: number
  maxChars: number
  maxTokens: number
  // How much of the session the model reads: the end of Claude's reply and
  // the person's last few prompts.
  answerChars: number
  prompts: number
}

// Short is Claude Code's own size. The longer ones hand Claude more of the
// work in one go (the person's ask, 2026-11-05: "carry out most of the feature
// until completion"), so they read more of the session and get more tokens.
const LENGTHS: Record<Length, LengthRule> = {
  short: {
    format: "Format: 2-12 words, one sentence, match the user's style. Or nothing.",
    maxWords: 12,
    maxChars: 100,
    maxTokens: 200,
    answerChars: 3_000,
    prompts: 3,
  },
  medium: {
    format: "Format: one or two sentences, 10-40 words, in the user's style. Name the concrete next task and the files, commands or checks it involves. Or nothing.",
    maxWords: 50,
    maxChars: 360,
    maxTokens: 350,
    answerChars: 5_000,
    prompts: 4,
  },
  thorough: {
    // The person clicks it without always rereading it, so a brief never
    // carries a step that can't be taken back unless they already asked for it.
    format: [
      "Format: one paragraph of 40-150 words, plain prose with no lists or markdown, in the user's voice.",
      'Write the prompt they would send to hand Claude the whole next piece of work to run on its own:',
      'the goal, the concrete steps or areas (files, commands, checks), what done looks like,',
      'and to keep going until it is done, or the investigation reaches a conclusion, without stopping to check in unless it is blocked.',
      'Stay within what this conversation is building: no unrelated new ideas.',
      'Leave out irreversible or outward steps (deploying, pushing, merging, running migrations or seed scripts, deleting data) unless the user already asked for them.',
      'Or nothing.',
    ].join(' '),
    maxWords: 170,
    maxChars: 1_200,
    maxTokens: 900,
    answerChars: 10_000,
    prompts: 6,
  },
}

const LENGTH_NAMES: readonly Length[] = ['short', 'medium', 'thorough']
// The names the person sees (their pick, 2026-11-05); the stored values stay
// short, medium and thorough.
const LENGTH_LABELS: Record<Length, string> = { short: 'Nudge', medium: 'Push', thorough: 'Autopilot' }
const LENGTH_KEY = 'length'
// A guess longer than this is drawn as wrapping text with its own button: a
// button's label never wraps on the desktop.
const LONG_TEXT = 80
// The band shows this much of a long guess, so it stays a few lines tall;
// Use it puts the whole of it in the box.
const DRAWN_CHARS = 600
// What one folded line shows of a guess.
const ONE_LINE_CHARS = 90
const COMPACT_KEY = 'compact'

// Longest reason or summary drawn in the band.
const DETAIL_CHARS = 140

const ONE_WORD_OK = new Set([
  'yes', 'yeah', 'yep', 'yea', 'yup', 'sure', 'ok', 'okay', 'push', 'commit',
  'deploy', 'stop', 'continue', 'check', 'exit', 'quit', 'no',
])

const EVALUATIVE =
  /thanks|thank you|looks good|sounds good|that works|that worked|that's all|nice|great|perfect|makes sense|awesome|excellent/

type Check = (text: string, lower: string, words: number, rule: LengthRule) => boolean

// Checks modelled on the ones Claude Code runs on its own suggestion, sized
// to the chosen length.
const REJECTS: readonly [string, Check][] = [
  ['done', (_, lower) => lower === 'done'],
  ['meta_text', (_, lower) =>
    lower.startsWith('nothing found') ||
    lower.startsWith('nothing to suggest') ||
    lower.startsWith('no suggestion') ||
    /\bsilence is\b|\bstay(s|ing)? silent\b|^\W*silence\W*$/.test(lower)],
  ['meta_wrapped', text => /^(\(.*\)|\[.*\])$/.test(text)],
  ['error_message', (_, lower) =>
    /^(api error:|prompt is too long|request timed out|invalid api key)/.test(lower)],
  ['prefixed_label', text => /^\w+:\s/.test(text)],
  ['too_few_words', (text, lower, words) =>
    words < 2 && !text.startsWith('/') && !ONE_WORD_OK.has(lower)],
  ['too_many_words', (_, __, words, rule) => words > rule.maxWords],
  ['too_long', (text, _, __, rule) => text.length >= rule.maxChars],
  // Only the short size is one sentence.
  ['multiple_sentences', (text, _, __, rule) =>
    rule === LENGTHS.short && /[.!?]\s+[A-Z]/.test(text)],
  // A longer guess is already flattened, and may name a glob (`test/*.spec.ts`).
  ['has_formatting', (text, _, __, rule) => (rule === LENGTHS.short ? /[\n*]/ : /\n/).test(text)],
  // A long guess may say "that works" in passing, so only its opening counts.
  ['evaluative', (_, lower, words) =>
    EVALUATIVE.test(words > 12 ? lower.split(/\s+/).slice(0, 4).join(' ') : lower)],
  ['claude_voice', text =>
    /^(let me|i'll|i've|i'm|i can|i would|i think|i notice|here's|here is|here are|that's|this is|this will|you can|you should|you could|sure,|of course|certainly)/i.test(text)],
]

// Module variables: a reload costs at most one turn's fallback.
// Bumped by every main-loop turn start; a fallback started for an older turn
// sees the change and stays quiet.
let turnSerial = 0
let lastStepUsage: ModelUsage | null = null
let builtInShownFor = -1
// The app attaches a window only while it shows the session, and clears the
// chat's suggestion whenever the person leaves it. So every return to the chat
// shows the latest turn's suggestion again, and a turn that ended while the
// chat was hidden gets its first one then.
let latest: { serial: number; answer: string } | null = null
// The latest finished guess; text is undefined when the model stayed silent
// or the checks dropped it, so a return does not ask again.
let filled: { serial: number; text: string | undefined } | null = null
// The turn a fill-in is scheduled or running for.
let pendingFor = -1
let isRunning = false
// The prompt-box drawings already seen, by their instance.
const boxesSeen = new Set<string>()
const bandsSeen = new Set<string>()
const recent: string[] = []

function isColdTurn(usage: ModelUsage | null) {
  if (usage === null) return false
  const fresh = usage.input_tokens + usage.output_tokens

  return fresh > COLD_TOKENS || fresh + usage.cache_creation_input_tokens > COLD_TOKENS
}

function unwrap(reply: string) {
  return reply
    .trim()
    .replace(/^<(suggestion|response|output|answer|result)>([\s\S]*)<\/\1>$/i, '$2')
    .replace(/^\s*(suggested\s+(response|reply|input|prompt)|suggestion|response|reply|answer|output|result)\s*:\s*/i, '')
    .replace(/^["'`](.*)["'`]$/s, '$1')
    .trim()
}

interface Guess {
  text: string
  reason: string
  summary: string
}

// Bold labels come both ways: **NEXT**: and **NEXT:**.
const LABEL = /^\s*\**(NEXT|WHY|SUMMARY)\**\s*:\**[ \t]*(.*)$/i

// Each labelled line, with the unlabelled lines after it joined on: a long
// guess can run over several lines.
function fields(reply: string) {
  const found = new Map<string, string>()
  let current: string | undefined
  for (const line of reply.split('\n')) {
    const labelled = LABEL.exec(line)
    if (labelled !== null) {
      current = (labelled[1] ?? '').toUpperCase()
      found.set(current, (labelled[2] ?? '').trim())
    } else if (current !== undefined && line.trim() !== '') {
      found.set(current, `${found.get(current) ?? ''} ${line.trim()}`.trim())
    }
  }

  return found
}

// One paragraph, as the band draws it.
function flatten(text: string) {
  return text.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()
}

function shortLine(text: string) {
  const flat = text.replace(/\s+/g, ' ').replace(/^["'`](.*)["'`]$/, '$1').trim()

  return flat.length > DETAIL_CHARS ? `${flat.slice(0, DETAIL_CHARS - 1)}…` : flat
}

// A reply without the NEXT line is read as the bare suggestion.
function parseReply(reply: string): Guess {
  const found = fields(reply)
  const next = found.get('NEXT')
  if (next === undefined) return { text: unwrap(reply), reason: '', summary: '' }

  return {
    text: unwrap(next),
    reason: shortLine(found.get('WHY') ?? ''),
    summary: shortLine(found.get('SUMMARY') ?? ''),
  }
}

function rejectReason(text: string, rule: LengthRule) {
  const lower = text.toLowerCase()
  const words = text.split(/\s+/).filter(Boolean).length
  if (text === '') return 'empty'

  return REJECTS.find(([, fails]) => fails(text, lower, words, rule))?.[0]
}

function isLength(value: unknown): value is Length {
  return LENGTH_NAMES.includes(value as Length)
}

// A length by its stored value or the name the person sees.
function lengthNamed(word: string) {
  if (isLength(word)) return word

  return LENGTH_NAMES.find(name => LENGTH_LABELS[name].toLowerCase() === word)
}

function thinkingText(length: Length) {
  if (length === 'short') return `${THINKING}…`
  const label = LENGTH_LABELS[length]

  return `Thinking of ${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label} suggestion…`
}

async function note($: EngineInterface, line: string) {
  recent.push(line)
  if (recent.length > RECENT) recent.shift()
  const path = `${$.plugin.root}/${PLUGIN}.log`
  const stamp = new Date(await $.clock.now()).toISOString()
  const id = (await $.session.id()).slice(0, 8)
  const old = await $.fs.read(path).catch(() => '')
  const lines = [...old.split('\n').filter(Boolean), `${stamp} ${id} ${line}`]
  await $.fs.write(path, `${lines.slice(-LOG_LINES).join('\n')}\n`)
}

// The person's own words in a row, or '' for a tool result or engine text.
function promptText(row: SessionMessage) {
  if (row.role !== 'user' || row.toolResults?.length) return ''
  const text = row.text.replace(ENGINE_WRAPPERS, '').trim()

  return HOST_EVENT.test(text) || ENGINE_ROW.test(text) ? '' : text
}

async function recentPrompts($: EngineInterface, count: number) {
  const rows = await $.session.messages()

  return rows.map(promptText).filter(text => text !== '').slice(-count)
}

// Claude's last reply, or '' when the person has written since.
async function lastReply($: EngineInterface) {
  const rows = await $.session.messages()
  for (const row of [...rows].reverse()) {
    if (row.role === 'assistant') return row.text.trim()
    if (promptText(row) !== '') return ''
  }

  return ''
}

async function buildAsk($: EngineInterface, answer: string, rule: LengthRule) {
  // The reply alone still makes a guess when the transcript can't be read.
  const earlier = await recentPrompts($, rule.prompts).catch(() => [])
  const prompts = earlier.map((text, i) => `${i + 1}. ${text.slice(0, 600)}`)
  const tail = answer.length > rule.answerChars ? `…${answer.slice(-rule.answerChars)}` : answer

  return [
    'This is the end of a Claude Code session.',
    `The user's recent prompts, oldest first:\n${prompts.join('\n') || '(none)'}`,
    `Claude's latest reply:\n<reply>\n${tail}\n</reply>`,
    [CORE, rule.format, REPLY_FORMAT].join('\n'),
  ].join('\n\n')
}

async function show($: EngineInterface, serial: number, text: string) {
  const first = await $.prompt.suggest({ text })
  if (first.isShown) return true

  await $.clock.sleep(RETRY_MS)
  if (serial !== turnSerial) return false

  return (await $.prompt.suggest({ text })).isShown
}

// A guess that passes the checks, or undefined.
async function guess($: EngineInterface, ask: string, why: string, rule: LengthRule) {
  let picked: Guess = { text: '', reason: '', summary: '' }
  let rejected: string | undefined = 'empty'
  for (let tries = 0; tries < GUESSES && rejected !== undefined; tries += 1) {
    const retry = tries === 0 ? '' : `\n\nYour last guess "${picked.text}" was rejected (${rejected}). Give a different one.`
    // An empty or failed answer is retried once, told why; only a call that
    // gets no answer at all ends the loop early.
    const reply = await $.model.complete({ model: MODEL, prompt: ask + retry, maxTokens: rule.maxTokens })
    if (!reply.isAnswered) {
      await note($, `no reply (${why}): ${reply.reason}`)

      return undefined
    }
    picked = parseReply(reply.text)
    // A longer guess may come over several lines or in bold; the band draws
    // one paragraph, so it is joined rather than refused.
    if (rule !== LENGTHS.short) picked = { ...picked, text: flatten(picked.text) }
    rejected = rejectReason(picked.text, rule)
    if (rejected !== undefined) await note($, `dropped ${rejected} (${why}): ${picked.text}`)
  }

  return rejected === undefined ? picked : undefined
}

async function whileThinking<T>($: EngineInterface, work: () => Promise<T>) {
  await update($, isThinking, () => true)
  try {
    return await work()
  } finally {
    await update($, isThinking, () => false)
  }
}

async function fillIn($: EngineInterface, serial: number, answer: string, why: string) {
  if (serial !== turnSerial || builtInShownFor === serial) return
  if ((await $.prompt.read()).text.trim() !== '') return

  const rule = LENGTHS[await read($, lengthChoice)]
  const ask = await buildAsk($, answer, rule)
  await whileThinking($, async () => {
    const started = await $.clock.now()
    const picked = await guess($, ask, why, rule)
    if (serial === turnSerial) filled = { serial, text: picked?.text }
    if (picked === undefined || serial !== turnSerial) return

    const rest = THINKING_MIN_MS - ((await $.clock.now()) - started)
    if (rest > 0) await $.clock.sleep(rest)
    if (serial !== turnSerial) return

    // Shown before the line goes back, so the dots hand straight over to it.
    const { text, reason, summary } = picked
    await update($, detail, () => ({ reason, summary }))
    await update($, suggestion, () => text)
    const isShown = await show($, serial, text)
    // A refusal is logged, not toasted: it is rare (5 by 2026-11-02, against
    // 50 shown), and the box may already hold Claude Code's own suggestion.
    const because = reason === '' ? '' : ` (why: ${reason})`
    await note($, `${isShown ? 'shown' : 'not shown'} (${why}): ${text}${because}`)
  })
}

function startFillIn($: EngineInterface, ms: number, serial: number, answer: string, why: string) {
  pendingFor = serial
  $.clock.after(ms, () => {
    fillIn($, serial, answer, why).catch(error => {
      $.ui.log(`${PLUGIN}: ${String(error)}`)
      return note($, `error (${why}): ${String(error)}`)
    }).catch(() => undefined).finally(() => {
      if (pendingFor === serial) pendingFor = -1
    })
  })
}

// What a chat being opened, or its prompt box being drawn again, gets: the
// guess already made for this turn shown again, a first guess for a turn that
// has none, or nothing (and why, for the log).
async function offer($: EngineInterface) {
  if (isRunning) return 'nothing: a turn is running'
  if (pendingFor === turnSerial) return 'nothing: a guess is on its way'
  if (filled?.serial === turnSerial) {
    if (filled.text === undefined) return 'nothing: the model stayed silent'
    startReshow($, turnSerial, filled.text)

    return 'showing the guess again'
  }
  if (latest?.serial === turnSerial) {
    startFillIn($, SETTLE_MS, turnSerial, latest.answer, 'chat opened')

    return 'asking for a guess'
  }
  if (turnSerial !== 0) return 'nothing: the last turn had no reply'
  // A chat reopened after a restart has no turn in this process yet, so its
  // last reply from the transcript stands in for one.
  const reply = await lastReply($).catch(() => '')
  if (reply === '') return 'nothing: the person wrote last'
  startFillIn($, SETTLE_MS, 0, reply, 'chat reopened')

  return 'asking for a guess from the transcript'
}

// The guess for the turn on screen, asked for again at the length just picked.
async function askAgain($: EngineInterface) {
  if (isRunning) return 'nothing: a turn is running'
  if (pendingFor === turnSerial) return 'nothing: a guess is on its way'
  const answer = latest?.serial === turnSerial
    ? latest.answer
    : turnSerial === 0 ? await lastReply($).catch(() => '') : ''
  if (answer === '') return 'nothing: no reply to suggest from'
  startFillIn($, 0, turnSerial, answer, 'length changed')

  return 'asking again'
}

// Pressing the length already chosen asks again too: a way to get another guess.
async function chooseLength($: EngineInterface, length: Length) {
  await update($, lengthChoice, () => length)
  await $.store.set(LENGTH_KEY, length).catch(() => undefined)
  const why = await askAgain($)
  await note($, `length ${length}: ${why}`)

  return why
}

async function setCompact($: EngineInterface, isCompact: boolean) {
  await update($, compactChoice, () => isCompact)
  await $.store.set(COMPACT_KEY, isCompact).catch(() => undefined)
}

async function take($: EngineInterface, text: string) {
  const filled = await $.prompt.fill({ text, mode: 'replace' })
  await note($, `${filled.isFilled ? 'taken from the line' : 'not taken from the line'}: ${text}`)
}

// The guess already made for this turn, shown again without asking the model.
function startReshow($: EngineInterface, serial: number, text: string) {
  $.clock.after(SETTLE_MS, () => {
    if (serial !== turnSerial || isRunning) return
    show($, serial, text)
      .then(isShown => note($, `${isShown ? 'shown again' : 'not shown again'}: ${text}`))
      .catch(() => undefined)
  })
}

function tokens(usage: ModelUsage | null) {
  if (usage === null) return 'no usage'
  const fresh = usage.input_tokens + usage.output_tokens

  return `fresh ${fresh}, new cache ${usage.cache_creation_input_tokens}`
}

// Which fill-in a finished turn gets, or why it gets none.
function planFor(surfaces: readonly string[], reason: string, answer: string) {
  if (reason !== 'answer' || answer.trim() === '') return `no answer (${reason})`
  // A -p run draws no prompt box to suggest into.
  if (surfaces.length === 0) return 'no prompt box'
  if (isColdTurn(lastStepUsage)) return 'cold cache'
  // Only the terminal's own suggestion passes `prompt.suggest`. The app's
  // goes straight to the app, out of a mod's sight, and it skips most turns
  // there, so the mod answers every app turn.
  return surfaces.includes('terminal') ? 'built-in skipped' : 'app'
}

function status(length: Length, isCompact: boolean) {
  const lines = recent.length > 0 ? recent.map(line => `- ${line}`).join('\n') : '- nothing yet'

  return [
    `Fill-in suggestions are always on. Mode: ${LENGTH_LABELS[length]} (/suggest nudge, push or autopilot).`,
    `View: ${isCompact ? 'one line' : 'full'} (/suggest compact or full).`,
    `This session:\n${lines}`,
  ].join(' ')
}

// Before the session starts (the entry module's `session.start` calls it).
export async function startSuggestions($: EngineInterface) {
  await $.command.register({
    name: 'suggest',
    description: 'Show what the suggestion fill-in did, or set its mode',
    argumentHint: 'nudge | push | autopilot | compact | full',
  })
  // The length and the view are the person's standing choices, so every
  // session starts with them.
  const stored = await $.store.get(LENGTH_KEY).catch(() => undefined)
  if (isLength(stored)) await update($, lengthChoice, () => stored)
  const compact = await $.store.get(COMPACT_KEY).catch(() => undefined)
  if (typeof compact === 'boolean') await update($, compactChoice, () => compact)
}

export function registerSuggestions(on: On) {

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      turnSerial += 1
      lastStepUsage = null
      isRunning = true
      await update($, suggestion, () => null)
      await update($, detail, () => null)
    }

    return next(e)
  })

  // The last response's usage decides, as it does for Claude Code's own check.
  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)
    if (e.agentId === undefined) lastStepUsage = response.usage

    return response
  })

  on('prompt.suggest', async ($, e, next) => {
    const shown = await next(e)
    if (shown.isShown && e.origin.kind === 'suggestion') builtInShownFor = turnSerial

    return shown
  })

  on('turn.complete', async ($, e, next) => {
    // Taken before next: a queued prompt's turn can start while it settles.
    const serial = turnSerial
    const done = await next(e)
    if (e.agentId !== undefined) return done
    if (serial === turnSerial) isRunning = false
    if (e.reason === 'answer' && e.answer.trim() !== '') latest = { serial, answer: e.answer }

    const surfaces = await $.session.surfaces()
    const plan = planFor(surfaces, e.reason, e.answer)
    // Every turn's line, so `/suggest` and the log show where a turn stopped.
    await note($, `turn ${serial}: ${plan}; [${surfaces.join(', ')}], ${tokens(lastStepUsage)}`)
      .catch(() => undefined)

    if (plan === 'cold cache' || plan === 'app') {
      startFillIn($, SETTLE_MS, serial, e.answer, plan)
    } else if (plan === 'built-in skipped') {
      startFillIn($, BUILT_IN_WAIT_MS, serial, e.answer, plan)
    }

    return done
  }).catch(($, e, next) => next(e)) // a fill-in failure must never touch the turn

  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    const why = await offer($).catch(error => `error: ${String(error)}`)
    await note($, `chat opened: ${why}`).catch(() => undefined)

    return attached
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'suggest' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase().replace(/^(mode|length)\s+/, '')
    if (arg === '') return { text: status(await read($, lengthChoice), await read($, compactChoice)) }
    if (arg === 'compact' || arg === 'full') {
      await setCompact($, arg === 'compact')

      return { text: arg === 'compact' ? 'Suggestions fold to one line.' : 'Suggestions show in full.' }
    }
    const length = lengthNamed(arg)
    if (length === undefined) {
      return { text: `Unknown option "${arg}". Use /suggest nudge, /suggest push or /suggest autopilot.` }
    }
    const why = await chooseLength($, length)
    const again = why === 'asking again' ? ' Writing a new suggestion for this reply.' : ''

    return { text: `Suggestion mode: ${LENGTH_LABELS[length]}.${again}` }
  })

  // The hint line under the prompt: dots while a guess is on its way, else
  // the guess to click, else a badge. Each new drawing of it is a freshly
  // mounted prompt box, and mounting one clears the box's suggestion, so the
  // guess is offered again then.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (e.surface === 'desktop' && !boxesSeen.has(e.requestId)) {
      boxesSeen.add(e.requestId)
      // A render hook may not write state, so the offer goes out on the clock.
      $.clock.after(0, () => {
        offer($).then(why => note($, `prompt box drawn: ${why}`)).catch(() => undefined)
      })
    }
    if (e.props.isDraft || e.props.isWorking) return next(e)

    const isBusy = await read($, isThinking)
    if (e.surface !== 'desktop') {
      return isBusy ? next({ ...e, props: { ...e.props, hint: `${THINKING}…` } }) : next(e)
    }
    const { Box, Button, Svg, Text } = $.ui.resolve(e)
    if (isBusy) {
      return (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Svg source={DOTS} alt="…" width={26} height={8} />
          <Text dimColor>{THINKING}</Text>
        </Box>
      )
    }
    const text = await read($, suggestion)
    if (text === null) return <Text dimColor>{BADGE}</Text>

    return <Button key="take" plain label={`✦ ${text}`} onPress={() => take($, text)} />
  })

}

// The suggestion's lines in the strip above the box, which the desktop draws
// (the app hides the box's own suggestion in most chats): dots while a guess
// is on its way, then the guess to click. Desktop only; undefined where there
// is nothing to show.
export async function drawSuggestion($: EngineInterface, e: RenderInput<'AbovePrompt'>) {
  if (e.surface !== 'desktop' || e.props.isWorking) return undefined
  if (!bandsSeen.has(e.requestId)) {
    bandsSeen.add(e.requestId)
    $.clock.after(0, () => {
      note($, `band drawn (${e.requestId})`).catch(() => undefined)
    })
  }
  const isBusy = await read($, isThinking)
  const text = await read($, suggestion)
  const length = await read($, lengthChoice)
  const isCompact = await read($, compactChoice)

  const { Box, Button, Select, Svg, Text } = $.ui.resolve(e)
  if (isBusy) {
    return (
      <Box key="steady-suggest" flexDirection="row" alignItems="center" gap={1}>
        <Svg source={DOTS} alt="…" width={26} height={8} />
        <Text dimColor>{thinkingText(length)}</Text>
      </Box>
    )
  }
  if (text === null) return undefined

  if (isCompact) {
    // Folded: one line whatever the guess's length; More unfolds it, and
    // Use it still puts the whole of it in the box.
    const fits = text.length <= ONE_LINE_CHARS

    return (
      <Box key="steady-suggest" flexDirection="row" alignItems="center" gap={1}>
        <Text color={CLAY}>✦</Text>
        {fits ? (
          <Button key="take-above" plain label={text} onPress={() => take($, text)} />
        ) : (
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="truncate-end">{`${text.slice(0, ONE_LINE_CHARS - 1)}…`}</Text>
          </Box>
        )}
        {fits && <Box flexGrow={1} />}
        {!fits && <Button key="take-above" plain label="Use it" onPress={() => take($, text)} />}
        <Button key="expand" plain dimColor label="More" onPress={() => setCompact($, false)} />
      </Box>
    )
  }

  // The guess leads, and the reason and the reply summary share one dim line
  // under it. That line is its own row: beside the button, which never
  // shrinks, wrapping text gets squeezed into a narrow column.
  const { summary = '', reason = '' } = (await read($, detail)) ?? {}
  const context = [reason, summary === '' ? '' : `Last reply: ${summary}`]
    .filter(part => part !== '')
    .join(' · ')
  // A long guess is wrapping text with a short button beside it, so all of
  // what would be sent can be read.
  const guessRow = text.length > LONG_TEXT ? (
    <Box flexDirection="row" alignItems="flex-start" gap={1}>
      <Text color={CLAY}>✦</Text>
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="wrap">
          {text.length > DRAWN_CHARS ? `${text.slice(0, DRAWN_CHARS - 1)}…` : text}
        </Text>
      </Box>
      <Button key="take-above" plain label="Use it" onPress={() => take($, text)} />
    </Box>
  ) : (
    <Box flexDirection="row" alignItems="center" gap={1}>
      <Text color={CLAY}>✦</Text>
      <Button key="take-above" plain label={text} onPress={() => take($, text)} />
    </Box>
  )

  // The Mode dropdown rides on the dim line's right; picking one asks for
  // this reply's suggestion again at that length. Mode, not Length: Autopilot
  // changes how far Claude runs, not just the text's size.
  return (
    <Box key="steady-suggest" flexDirection="column">
      {guessRow}
      <Box flexDirection="row" alignItems="flex-start" gap={2} paddingLeft={2}>
        <Box flexGrow={1} flexShrink={1}>
          {context !== '' && <Text dimColor wrap="wrap">{context}</Text>}
        </Box>
        <Box flexDirection="row" alignItems="center" gap={2} flexShrink={0}>
          <Select
            key="length"
            label="Mode"
            options={LENGTH_NAMES.map(name => ({ value: name, label: LENGTH_LABELS[name] }))}
            value={length}
            onSelect={value => {
              const picked = lengthNamed(value)
              if (picked !== undefined) chooseLength($, picked).catch(() => undefined)
            }}
          />
          <Button key="collapse" plain dimColor label="Less" onPress={() => setCompact($, true)} />
        </Box>
      </Box>
    </Box>
  )
}
