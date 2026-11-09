// One of the person's own prompts, as the history row shows it.
export interface PinnedPrompt {
  id: number
  text: string
  images: number
}
// True while the model writes a guess, so the strip can say so.
export type IsThinking = boolean
// The latest turn's guess, drawn in the strip for a click to take.
export type Suggestion = string | null
// Drawn around the guess: Claude's latest reply in a few words, and one
// sentence on why the guess fits. Either is '' when the model left it out.
export interface SuggestionDetail {
  summary: string
  reason: string
}
export type Detail = SuggestionDetail | null
// How long and detailed the guess is, shown as the Mode: short (Nudge) is
// Claude Code's own size, thorough (Autopilot) hands Claude a whole piece of
// work. Kept across sessions in the plugin's store.
export type Length = 'short' | 'medium' | 'thorough'
// True when the strip folds the guess to one line. Kept across sessions in
// the plugin's store.
export type IsCompact = boolean

declare module 'claude-code' {
  interface PluginState {
    'steady-suggest': {
      prompts: PinnedPrompt[]
      // How many prompts back from the newest the history row shows: 0 is the newest.
      stepsBack: number
      isSmart: boolean
      isOffScreen: boolean | null
      isThinking: IsThinking
      suggestion: Suggestion
      detail: Detail
      length: Length
      isCompact: IsCompact
    }
  }
}
