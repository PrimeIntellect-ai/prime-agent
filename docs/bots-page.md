# The /bots page

A bot is a standing, named subagent that runs in its own Prime VM sandbox.
The sandbox runs the normal `prime-agent daemon`. The /bots page in the
TUI lists every bot this daemon owns, one row each, from the daemon's
`list_bots` answer.

## Open it

Type `/bots` in the composer (the command palette autocompletes it):

```sh
prime-agent   # in a session
> /bots
```

## The spawn opt-in (off by default)

The daemon admits new bot spawns only after an explicit opt-in: the global
`bots.enabled` setting, default off. `/bots status` reports the setting,
`/bots on` stores `true`, and `/bots off` stores `false`. Headless users
edit `<agent-dir>/settings.json` directly (`{"bots":{"enabled":true}}`).
The daemon reads the setting on every spawn attempt, so a change applies
to the next attempt without a restart.

The setting only gates new `rlm.spawn(target="sandbox")` calls. While it
is off, the daemon refuses those spawns before it creates a sandbox.
Existing bots keep their full lifecycle either way. Bare `/bots` always
opens the page.

## How a bot is made

Agents make bots. An agent calls
`rlm.spawn(prompt, name=..., target="sandbox")`, and messages the bot with
`agent_message.send(..., receiver_role="child", receiver_name=...)`. The
final answer of each settled bot turn comes back once as a child result.
A bot can message its owner with `receiver_role="parent"`. Bots cannot
message each other.

The `prime sandbox` CLI is the human and admin path only. Bot sandboxes
carry the labels `prime-agent-bot` and `prime-agent-bot:<id>`, so an admin
can find them with the CLI. Use the page or the owning agent to delete a
bot, so the daemon also removes its checkpoints.

## Attach

`↑/↓` move the selection. `Enter` attaches to the selected bot. `Esc` (or
`Ctrl+C`) closes the page.

Attach opens the normal session view against the bot's daemon. Prompts,
steering, scroll, and the model and effort pickers go to the bot
unchanged. Commands that only work on the local machine (local shells,
local file pickers) are refused with a clear message. Leaving the view
closes the connection to the bot.

## Version match

A bot runs the same prime-agent version as the daemon that owns it. The
daemon installs that exact release in the sandbox when it creates the bot,
and again on resume when the bot's version differs. If the versions still
differ, attach and messaging are refused with a message that says which
side to upgrade. A local build with no published Linux release cannot
spawn bots.

## Pause policy

The daemon pauses a bot 2 minutes after a settled turn. It does not pause
a bot while a message is queued, a turn is running, or a TUI is attached.
A pause keeps the bot's state. The next message or attach resumes it:

1. Resume the sandbox if it is paused.
2. Use it as it is if it is already running.
3. Otherwise restore it from its newest durable checkpoint.
4. Otherwise boot a new sandbox.

When the daemon starts, it rebuilds its bot list from the sandbox labels,
deletes duplicates (the newest wins), and pauses stray running bots.
