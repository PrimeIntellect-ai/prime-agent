# Quickstart

This page gets you from install to a useful first Preme Agent session.

## Install

Windows, Linux, and macOS are supported. The release installer below targets Linux/macOS; Windows setup is covered in [Windows Setup](windows.md).

Install the latest stable release on Linux or macOS:

```bash
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh
```

To try the latest beta built from `main`:

```bash
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh -s -- beta
```

Both commands fetch versioned Preme Agent release artifacts and install the `preme-agent` command. The inherited npm workspace identifiers in the source tree are not the public install path.

Then start Preme Agent in the project directory you want it to work on:

```bash
cd /path/to/project
preme-agent
```

To run a source checkout instead, use Node.js 22.8.0 or newer:

```bash
git clone https://github.com/PrimeIntellect-ai/prime-agent
cd preme-agent
npm ci
./prime-agent.sh
```

The source runner preserves the directory from which it is invoked, so you can also call `/path/to/prime-agent/prime-agent.sh` from another project. On Windows, install Node.js 22.8.0 or newer and Git for Windows, run `npm ci`, then `npm link` from `packages/coding-agent`; this exposes `supreme` and `preme-agent` as the primary CLI names.

## Authenticate

Preme Agent can use subscription providers through `/login`, or API-key providers through environment variables or its auth file.

### Option 1: Subscription Login

Start Preme Agent and run:

```text
/login
```

Then select a provider. Built-in subscription logins include Claude Pro/Max, ChatGPT Plus/Pro (Codex), and GitHub Copilot.

### Option 2: API Key

Set an API key before launching Preme Agent:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
preme-agent
```

You can also run `/login` and select an API-key provider to store the key in `~/.supreme/agent/auth.json`.

See [Providers](providers.md) for all supported providers, environment variables, and cloud-provider setup.

## First Session

Once Preme Agent starts, type a request and press Enter:

```text
Summarize this repository and tell me how to run its checks.
```

Prime Agent gives the model one built-in tool, `ipython`. The long-lived kernel is a control environment for reading and editing files, running project commands, inspecting data, retaining Python state, and invoking installed skills. The kernel runtime is bootstrapped automatically on first use. Windows uses the venv interpreter under `kernel-venv\Scripts\python.exe`; POSIX uses `kernel-venv/bin/python`. Set `PRIME_AGENT_KERNEL_PYTHON` only to override the managed environment with an existing Python that already has `prime-agent-runtime`.

Preme Agent runs in your current working directory and can modify files there. Use git or another checkpointing workflow if you want easy rollback.

## Recursive Subagents

Recursive subagents are a built-in Preme Agent capability. The model spawns independent work from the Python REPL with `await rlm("subtask")`; each call returns at admission with a child handle and never returns the answer. Children send requested results as explicit `agent_message` replies to the parent or write them to files. Child agents use the same TypeScript agent runtime, providers, tools, skills, and session machinery as the parent.

You can prompt the model to use that capability directly:

```text
Review authentication and test coverage as independent subtasks. Run them in parallel, then synthesize the findings.
```

See [RLM Runtime Architecture](rlm-runtime.md) for the API and execution model.

## Give Preme Agent Project Instructions

Preme Agent loads context files at startup. Add an `AGENTS.md` file to tell it how to work in a project:

```markdown
# Project Instructions

- Run `npm run check` after code changes.
- Do not run production migrations locally.
- Keep responses concise.
```

Preme Agent loads:

- `~/.supreme/agent/AGENTS.md` for global instructions
- `AGENTS.md` or `CLAUDE.md` from parent directories and the current directory

Restart Preme Agent, or run `/reload`, after changing context files.

## Common Things to Try

### Reference Files

Type `@` in the editor to fuzzy-search files, or pass files on the command line:

```bash
preme-agent @README.md "Summarize this"
preme-agent @src/app.ts @src/app.test.ts "Review these together"
```

Images can be pasted with Ctrl+V (Alt+V on Windows) or dragged into supported terminals.

### Run Shell Commands

In interactive mode:

```text
!npm run lint
```

The command output is sent to the model. Use `!!command` to run a command without adding its output to model context. During agent work, the model normally runs project commands from the Python REPL with `bash()`.

### Switch Models

Use `/model` or Ctrl+L to choose a model. Use `/effort` to set the reasoning level. Use Ctrl+P / Shift+Ctrl+P to cycle through scoped models.

### Continue Later

Sessions are saved automatically under `~/.supreme/agent/sessions/`:

```bash
preme-agent -c                  # Continue the most recent session
preme-agent -r [path|id]        # Browse sessions or open a specific session
```

Inside Preme Agent, use `/resume`, `/new`, `/tree`, `/fork`, and `/clone` to manage sessions. Persistent sessions run in worker processes, so closing the TUI detaches from the agent rather than necessarily stopping it. Use `preme-agent agents` to inspect or reattach to active work.

### Non-Interactive Mode

For one-shot prompts:

```bash
preme-agent -p "Summarize this codebase"
cat README.md | preme-agent -p "Summarize this text"
preme-agent -p @screenshot.png "What's in this image?"
```

Use `--mode json` for JSON event output or `--mode rpc` for process integration.

## Next Steps

- [Using Preme Agent](usage.md) - interactive mode, slash commands, sessions, context files, and CLI reference.
- [Providers](providers.md) - authentication and model setup.
- [Settings](settings.md) - global and project configuration.
- [Keybindings](keybindings.md) - shortcuts and customization.
- [Preme Agent Packages](packages.md) - install shared extensions, skills, prompts, and themes.

Platform notes: [Windows](windows.md), [Termux](termux.md), [tmux](tmux.md), [Terminal setup](terminal-setup.md), [Shell aliases](shell-aliases.md).