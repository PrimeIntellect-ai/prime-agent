# Quickstart

This page gets you from install to a useful first Prime Agent session.

## Install

Install the latest stable release on Linux or macOS:

```bash
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh
```

To try the latest beta built from `main`:

```bash
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh -s -- beta
```

Both commands fetch versioned Prime Agent release artifacts and install the `prime-agent` command. The inherited npm workspace identifiers in the source tree are not the public install path.

Then start Prime Agent in the project directory you want it to work on:

```bash
cd /path/to/project
prime-agent
```

To run a source checkout instead, use Node.js 22.8.0 or newer:

```bash
git clone https://github.com/PrimeIntellect-ai/prime-agent
cd prime-agent
npm ci
./prime-agent.sh
```

The source runner preserves the directory from which it is invoked, so you can also call `/path/to/prime-agent/prime-agent.sh` from another project.

## Authenticate

Prime Agent can use subscription providers through `/login`, or API-key providers through environment variables or its auth file.

### Option 1: Subscription Login

Start Prime Agent and run:

```text
/login
```

Then select a provider. Built-in subscription logins include Claude Pro/Max, ChatGPT Plus/Pro (Codex), and GitHub Copilot.

### Option 2: API Key

Set an API key before launching Prime Agent:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
prime-agent
```

You can also run `/login` and select an API-key provider to store the key in `~/.prime/agent/auth.json`.

See [Providers](providers.md) for all supported providers, environment variables, and cloud-provider setup.

## First Session

Once Prime Agent starts, type a request and press Enter:

```text
Summarize this repository and tell me how to run its checks.
```

Prime Agent gives the model one built-in tool, `ipython`. The long-lived kernel is a control environment for reading and editing files, running project commands, inspecting data, retaining Python state, and invoking installed skills. The kernel runtime is bootstrapped automatically on first use; set `PRIME_AGENT_KERNEL_PYTHON` to use an existing Python environment with `ipykernel`.

Prime Agent runs in your current working directory and can modify files there. Use git or another checkpointing workflow if you want easy rollback.

## Recursive Subagents

Recursive subagents are a built-in Prime Agent capability. The model spawns independent work from IPython with `await rlm("subtask")`; each call returns at admission with a child handle and never returns the answer. Children send requested results as explicit `agent_message` replies to the parent or write them to files. Child agents use the same TypeScript agent runtime, providers, tools, skills, and session machinery as the parent.

You can prompt the model to use that capability directly:

```text
Review authentication and test coverage as independent subtasks. Run them in parallel, then synthesize the findings.
```

See [RLM Runtime Architecture](rlm-runtime.md) for the API and execution model.

## Give Prime Agent Project Instructions

Prime Agent loads context files at startup. Add an `AGENTS.md` file to tell it how to work in a project:

```markdown
# Project Instructions

- Run `npm run check` after code changes.
- Do not run production migrations locally.
- Keep responses concise.
```

Prime Agent loads:

- `~/.prime/agent/AGENTS.md` for global instructions
- `AGENTS.md` or `CLAUDE.md` from parent directories and the current directory

Restart Prime Agent, or run `/reload`, after changing context files.

## Common Things to Try

### Reference Files

Type `@` in the editor to fuzzy-search files, or pass files on the command line:

```bash
prime-agent @README.md "Summarize this"
prime-agent @src/app.ts @src/app.test.ts "Review these together"
```

Images can be pasted with Ctrl+V (Alt+V on Windows) or dragged into supported terminals.

### Run Shell Commands

In interactive mode:

```text
!npm run lint
```

The command output is sent to the model. Use `!!command` to run a command without adding its output to model context. During agent work, the model normally runs project commands from the IPython control environment with a `%%bash` cell.

### Switch Models

Use `/model` or Ctrl+L to choose a model. Use `/effort` to set the reasoning level. Use Ctrl+P / Shift+Ctrl+P to cycle through scoped models.

### Continue Later

Sessions are saved automatically under `~/.prime/agent/sessions/`:

```bash
prime-agent -c                  # Continue the most recent session
prime-agent -r [path|id]        # Browse sessions or open a specific session
```

Inside Prime Agent, use `/resume`, `/new`, `/tree`, `/fork`, and `/clone` to manage sessions. Persistent sessions run in worker processes, so closing the TUI detaches from the agent rather than necessarily stopping it. Use `prime-agent agents` to inspect or reattach to active work.

### Non-Interactive Mode

For one-shot prompts:

```bash
prime-agent -p "Summarize this codebase"
cat README.md | prime-agent -p "Summarize this text"
prime-agent -p @screenshot.png "What's in this image?"
```

Use `--mode json` for JSON event output or `--mode rpc` for process integration.

## Next Steps

- [Using Prime Agent](usage.md) - interactive mode, slash commands, sessions, context files, and CLI reference.
- [Providers](providers.md) - authentication and model setup.
- [Settings](settings.md) - global and project configuration.
- [Keybindings](keybindings.md) - shortcuts and customization.
- [Prime Agent Packages](packages.md) - install shared extensions, skills, prompts, and themes.

Platform notes: [Windows](windows.md), [Termux](termux.md), [tmux](tmux.md), [Terminal setup](terminal-setup.md), [Shell aliases](shell-aliases.md).
