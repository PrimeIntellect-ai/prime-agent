# The /bots page

A bot is a standing, named subagent that runs in its own Prime VM sandbox. The sandbox runs the normal `prime-agent daemon`. The /bots page in the TUI lists every bot this daemon owns, one row each, from the daemon's `list_bots` answer.

## Open it

Type `/bots` in the composer (the command palette autocompletes it):

```sh
prime-agent   # in a session
> /bots
```

## The spawn opt-in (off by default)

The daemon admits new bot spawns only after an explicit opt-in: the global `bots.enabled` setting, default off. `/bots status` reports the setting, `/bots on` stores `true`, and `/bots off` stores `false`. Headless users edit `<agent-dir>/settings.json` directly (`{"bots":{"enabled":true}}`). The daemon reads the setting on every spawn attempt, so a change applies to the next attempt without a restart.

The setting only gates new `rlm.spawn(target="sandbox")` calls. While it is off, the daemon refuses those spawns before it creates a sandbox. Existing bots keep their full lifecycle either way. Bare `/bots` always opens the page.

## How a bot is made

Agents make bots. An agent calls `rlm.spawn(prompt, name=..., target="sandbox")`, and messages the bot with `agent_message.send(..., receiver_role="child", receiver_name=...)`. The final answer of each settled bot turn comes back once, as an agent message from the bot (`[agent-message from <bot name>]`). Delivery is at most once: if the link drops before the bot confirms, the send is reported as uncertain and is never resent. A bot can also message its owner with `receiver_role="parent"`. Bots cannot message each other.

The `prime sandbox` CLI is the human and admin path only. A bot sandbox has the bot's name. It carries the labels `prime-agent-bot`, `prime-agent-bot:<id>`, and `prime-agent-bot-owner:<owner id>`, so an admin can find it with the CLI. Delete a bot through its owning agent (`rlm.delete_subagent`), so the daemon also removes its checkpoints.

A bot has no shared path with this machine. Its owner copies files out with `await rlm.pull_bot_files(bot, path, dest=".")`: the daemon streams a tar archive of `path` from the bot and unpacks it under `dest`, inside the owner's working directory. A paused bot is resumed for the pull. An archive over 256 MiB fails; nothing is cut. Only files and directories are copied, and an existing file is never replaced.

## What it shows

Each row shows a status dot, the bot's name and model, its version, and its last turn. Rows are grouped into `Running`, `Idle`, and `Inactive`, with the most recent activity first. `d` opens a detail pane with the pause timer, the bot id, sandbox id, checkpoint id, version, model, and timestamps. The pause timer reads `pauses in N min` while an idle bot waits out its grace, and `paused since <time>` for a paused bot.

## Attach

`↑/↓` move the selection, `Enter` attaches to the selected bot, `p` pauses a running bot or resumes a paused bot, `r` refreshes, and `Esc` closes the page. The daemon refuses to pause a bot that has an attached view. A resumed bot pauses again 2 minutes after it goes idle.

Attach opens the normal session view against the bot's daemon. Prompts, steering, scroll, and the model and effort pickers go to the bot unchanged. Slash commands that act on this machine (for example `/new`, `/fork`, `/login`, `/mcp`, `/update`) are refused with a clear message. Leaving the view closes the connection to the bot.

## GitHub access

A bot reaches GitHub with its owner's token, and the token never enters the sandbox. The daemon stores the token as two Prime secrets, one per Prime account: the token, and the git Basic credential. The sandbox's header rules set them on its HTTPS requests to `api.github.com` (`Authorization: Bearer`) and `github.com` (`Authorization: Basic`). In the bot, `GH_TOKEN` and the git credential hold a placeholder, which the platform replaces. The bot image gets a pinned `gh`.

- `prime-agent bots github set` reads a token from stdin and stores it on this machine. A fine-grained token with only the repositories the bots need is the safest choice.
- Without a stored token, the daemon uses the `gh` CLI login (`gh auth token`).
- `prime-agent bots github clear` removes the stored token and deletes the Prime secrets, so running bots lose access within a minute.
- `prime-agent bots github status` shows the token source, the setting, and the git author.

GitHub is on by default. Set `bots.github` to `false` in `settings.json`, or spawn with `rlm.spawn(..., target="sandbox", github=False)`, to turn it off. `github=True` with no token fails the spawn with the command to run. The daemon writes the current token to the secrets each time it creates a bot sandbox. Running bots get the new value within a minute. A bot commits as the owner's git author (`git config --global user.name` and `user.email`); `bots.gitIdentity` (`{"name": ..., "email": ...}`) overrides it. The /bots detail pane shows `github on` or `off`.

## Version match

A bot runs the same prime-agent version as the daemon that owns it. The sandbox boots the public `python:3.12-bookworm` image (override it with `PRIME_AGENT_BOT_IMAGE`). The daemon installs that exact release in the sandbox when it creates the bot, and again on resume when the bot's version differs. If the versions still differ, attach and messaging are refused with a message that says which side to upgrade. After the install, the daemon checks that the bot's build has the bot guest side; a release without it refuses the spawn with a clear message.

A local build (no published release) installs a linux-x64 tarball of its own build. Run `make bot-tarball` in its checkout on Linux: it puts the tarball next to `target/debug/prime-agent` and `target/release/prime-agent`, where the daemon finds it. Or set `PRIME_AGENT_BOT_TARBALL` to the tarball. The tarball must carry the daemon's exact version.

## Bots that spawn bots

A bot can spawn its own bots: `rlm.spawn(..., target="sandbox", bots=True)`. The flag is off by default and is stored on the bot's record. The /bots page indents a bot's children under it and marks the bots that spawn bots.

The owner's daemon stores its sandbox API key as a Prime secret and adds one header rule to that bot's sandbox: the platform sets `Authorization: Bearer <key>` on the bot's HTTPS requests to `api.primeintellect.ai`. The key value never enters the sandbox. The bot's own daemon then creates, pauses, and deletes its children directly through the sandbox API, so it keeps working while this Mac sleeps.

Bots nest two levels deep: owner, bot, bot. A bot at the second level cannot spawn another one, and `rlm.spawn(target="sandbox")` inside a bot that was not spawned with `bots=True` fails fast with "this bot may not spawn bots" instead of calling the platform. Children count toward the owner's bot list and its `bots.maxBots` cap (default 10, in `settings.json`), checked before each create. A child's sandbox carries the owner's label and a `prime-agent-bot-parent:<id>` label, so the owner's daemon lists them, shows them in the tree, prices them, and deletes them: deleting a bot deletes its descendants first.

`prime-agent bots allow-spawns <bot>` gives one running bot the same rule, guest settings, and flag without a respawn (it replaces the sandbox's whole network policy, keeping its current rules). `rlm.spawn(..., bots=True)` on a new bot is the cleaner path.

**Security note.** With `bots=True`, any code inside that bot can call the whole Prime sandbox API as the owner: create sandboxes, delete them, and exec into any sandbox of the account. Give such bots a dedicated, sandbox-scoped API key (its own key in `auth.json`, injected through a header rule) so it can be disabled alone, and review what runs in them.

## Pause policy

The daemon pauses a bot 2 minutes after a settled turn. It does not pause a bot while a message is queued, a turn is running, or a TUI is attached. A pause keeps the bot's state. The next message or attach resumes it:

1. Resume the sandbox if it is paused.
2. Use it as it is if it is already running.
3. Otherwise restore it from its newest durable checkpoint.
4. Otherwise boot a new sandbox.

When the daemon starts, it rebuilds its bot list from the sandbox labels, deletes duplicates (the newest wins), and pauses stray running bots.

With this machine offline, the daemon cannot pause anything. The bot's guest daemon then pauses its own sandbox after `bots.selfPauseMinutes` idle minutes (default 10; `0` disables it): no running turn, no attached client, and no inbound message for that long means nothing can need the bot. It asks an always-on relay to run the pause, named by the `bots.relay.url` setting; with the setting unset the guest never pauses itself. The relay holds the platform key. The bot holds a per-bot token instead, which the platform injects on its pause request through a header rule scoped to the relay's host alone, so no Prime API key ever enters the sandbox. The token and the sandbox id are registered with the relay at every wake (`bots.relay.token` is the credential the daemon presents; ask the relay's operator for it). A relay configured after the spawn reaches the bot at its next wake: the daemon then pushes the sandbox's rules too. A resume, by this daemon or by the relay, continues the guest daemon with its sessions intact and re-arms the timer; a sandbox the guest paused is treated like any paused bot.

`rlm_heartbeat` jobs also survive a pause. With `bots.relay.url` set, the guest daemon mirrors every heartbeat's next run time to the relay, using the same per-bot token on the relay host only. The relay resumes a paused bot when one is due. The guest then fires the heartbeat with its normal scheduler, so local timers remain the only firing path and a wake never duplicates a prompt. The guest mirrors the set on boot, after each change and fire, and just before it pauses. Deleting a bot clears its relay schedules.

## Model logins

A bot can run on its owner's subscription logins: Anthropic, OpenAI Codex, GitHub Copilot, and xAI. Every login this machine holds goes into new bots by default, next to the API keys. The tokens never enter the sandbox. Each login's access token is one Prime secret per Prime account (`PRIME_AGENT_LOGIN_<PROVIDER>_<account>`). A header rule sets it on the provider's API host. Codex also sends its account id from a second secret on the same rule. In the bot, the login record holds a placeholder token with no refresh token, so the bot never refreshes.

This machine refreshes a login while at least one running bot uses it. It refreshes when less than 10 minutes or a quarter of the token's life remains. It uses the same auth storage and lock as its own sessions, then updates the secret. Running bots get the new token within a minute, with no restart. A bot that resumes gets a fresh token first.

If a refresh fails, bots keep the current token until it expires, and the daemon logs one warning. The /bots page shows `login stale: <provider>`. After the login expires, a bot turn on it ends with "the owner's <provider> login expired; log in again on the Mac".

MCP server logins go in the same way, after every other credential. Each remote HTTP MCP server with a stored bearer token (an OAuth login or a pasted token) gets one header rule on its endpoint's host, and the bot holds a placeholder bound to that endpoint. A server that the user declared in `mcpServers` is declared in the bot too, with only its URL. A server with `enabled: false` stays out of the bot. A catalog connection (an alias such as `linear-2` too) gets its connection record, which holds no token. The platform allows 32 rule hosts per sandbox: past that limit, MCP logins are left out first, and the daemon logs one warning that names them. OAuth MCP logins refresh like the subscription logins.

Set `bots.inject.<provider>` to `false` in `settings.json` to keep a login or API key out of new bots. For an MCP server, the name is `mcp:<server>`.
