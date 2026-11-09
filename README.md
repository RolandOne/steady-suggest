# steady-suggest

A Claude Code mod that suggests your next prompt after every reply, tells you why, and keeps your own prompts one click away.

It adds a strip above the prompt box:

```
▲ ▼ 16/16                      instead of just also adding a suggested text, I also want…
✦ restart the app and check the new suggestion bar
  The new lines only load after an app restart. · Last reply: Added a reason…   Mode Push ▾  Less
```

- **History row** (top): your latest prompt, with ▲ ▼ to step back through earlier ones. `/prompts` opens them all in a pane; click one to copy it.
- **Suggestion** (under it, desktop app): what you would likely type next. Click it (or **Use it** for a long one) to put it in the box. Nothing is sent until you press Enter.
- **Why and recap**: a one-sentence reason and a few words on Claude's last reply, on the dim line under the suggestion.
- **Mode**: how far the suggestion goes.
  - **Nudge**: 2–12 words, like Claude Code's own suggestion.
  - **Push**: one or two sentences naming the concrete next task.
  - **Autopilot**: a full hand-off brief (goal, steps, what done looks like, keep going until done unless blocked) so Claude can carry a feature or an investigation through. It leaves out deploying, pushing, merging, migrations and deleting data unless you already asked for them in the chat.
- **Less / More**: fold the suggestion to one line, or show it in full. Your Mode and view are remembered across chats.

## Install

At the prompt of a terminal session:

```
/plugin install steady-suggest --marketplace RolandOne/steady-suggest
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install steady-suggest --marketplace RolandOne/steady-suggest
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `RolandOne/steady-suggest`, then **Add plugin**. A mod installed from a terminal at the user scope also loads in the desktop app's Code tab. Restart the app after installing.

## Commands

| Command | What it does |
| --- | --- |
| `/suggest` | Shows what the suggestion did this session, the current Mode and view |
| `/suggest nudge` · `push` · `autopilot` | Sets the Mode and rewrites the current suggestion |
| `/suggest compact` · `full` | Folds the suggestion to one line, or shows it in full |
| `/prompts` | Lists every prompt of the session in a pane |
| `/pin-prompt` | Jumps the history row back to your newest prompt; `/pin-prompt smart` toggles hiding it while your newest prompt is on screen |

## How it works

1. When Claude's reply ends, the mod gathers your last few prompts and the end of the reply.
2. It asks Opus, in a side call outside your chat, for three lines: the suggestion, why, and a recap. The Mode sets how long the suggestion may be and how much of the session Opus reads.
3. It runs Claude Code's own checks on the suggestion (length, no "Let me…", no "looks good") and retries once if it fails.
4. It shows the result in the strip and, where the app allows, as the dim suggestion inside the box.

**Cost:** every reply makes one Opus call on your own account. Autopilot calls are larger.

**Desktop and terminal:** the suggestion strip draws in the desktop app's Code tab. In a terminal the mod fills in Claude Code's own suggestion on the turns where it skips one, and the history row adds a **Go to** button that scrolls the chat to that prompt (the desktop app does not let a mod scroll the chat).

A log of what the mod did is kept in `steady-suggest.log` inside the plugin folder.

## License

MIT
