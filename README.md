# Preme Agent

Preme Agent is an independent fork of [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent), rebuilt and maintained in [JonusNattapong/preme-agent](https://github.com/JonusNattapong/preme-agent).

It is an open-source coding and research agent for long-running work. The agent combines a persistent Python REPL, recursive subagents, durable sessions, and an extensible terminal interface.

> This repository is currently developed from source. Release installers and hosted services from the upstream project are not part of this fork.

## Highlights

- **Persistent Python control environment** for reading files, running commands, editing code, and inspecting data.
- **Recursive subagents** for parallel or background work.
- **Durable sessions** that can be resumed, branched, compacted, and shared.
- **Continual harness state** for prompts, memories, skills, and reusable subagent specifications.
- **Extensible workflows** through skills, extensions, MCP integrations, themes, and prompt templates.
- **Multiple execution modes** including interactive TUI, JSON, RPC, and ACP.
- **Cross-platform source runners** for Windows, macOS, and Linux.

## Requirements

- Node.js `22.8.0` or newer
- npm
- Python 3.11+ for the managed RLM runtime, or `uv` for automatic runtime setup
- A supported provider account or API key

## Run from source

Clone the fork and install dependencies:

```bash
git clone https://github.com/JonusNattapong/preme-agent.git
cd preme-agent
npm ci
```

Run the development version from the project directory you want the agent to work on:

### macOS / Linux

```bash
/path/to/preme-agent/prime-agent.sh
```

### Windows PowerShell

```powershell
C:\path\to\preme-agent\prime-agent.ps1
```

Both launchers preserve the current working directory. To run the compiled bundle instead:

```bash
npm run build
./prime-agent.sh --dist
```

On first launch, use `/login` to authenticate, or provide an API key through the environment. For example:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
./prime-agent.sh
```

Windows PowerShell:

```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."
.\prime-agent.ps1
```

## Basic usage

Start an interactive session in any project:

```bash
/path/to/preme-agent/prime-agent.sh
```

Useful commands inside the agent:

| Command | Purpose |
| --- | --- |
| `/login` | Authenticate with a provider |
| `/model` | Select a model |
| `/new` | Start a new session |
| `/resume` | Browse or resume saved sessions |
| `/compact` | Compact older context |
| `/tree` | Navigate session branches |
| `/settings` | Configure the agent |
| `/reload` | Reload skills, extensions, prompts, and context files |
| `/quit` | Exit the session |

Useful CLI commands:

```bash
preme-agent agents
preme-agent status
preme-agent doctor
preme-agent --resume
preme-agent shutdown
```

The source checkout exposes `preme-agent` when linked from `packages/coding-agent`. Compatibility aliases such as `prime-agent` and `pi` may remain in the source tree, but new integrations should use `preme-agent`.

## Documentation

- [Quickstart](packages/coding-agent/docs/quickstart.md)
- [Usage and CLI reference](packages/coding-agent/docs/usage.md)
- [Provider setup](packages/coding-agent/docs/providers.md)
- [Sessions and long-running agents](packages/coding-agent/docs/long-running-agents.md)
- [RLM runtime](packages/coding-agent/docs/rlm-runtime.md)
- [Skills](packages/coding-agent/docs/skills.md)
- [Extensions](packages/coding-agent/docs/extensions.md)
- [MCP integrations](packages/coding-agent/docs/mcp-integrations.md)
- [Architecture](packages/coding-agent/docs/architecture.md)
- [Development guide](packages/coding-agent/docs/development.md)

## Development

Install dependencies before making changes:

```bash
npm ci
```

Run the repository checks:

```bash
npm run check
```

Run a focused test from the relevant package when needed:

```bash
cd packages/coding-agent
npx tsx ../../node_modules/vitest/dist/cli.js --run test/<file>.test.ts
```

See [AGENTS.md](AGENTS.md) for repository conventions and validation rules.

## Security

Preme Agent can execute model-generated Python and project commands with your user permissions. It is not a security sandbox. Use trusted repositories, instructions, skills, extensions, and providers. Review changes before using them in production.

## Upstream and attribution

This project is an independent fork. It retains portions of the original Prime Agent codebase and the upstream [pi-mono](https://github.com/earendil-works/pi-mono) lineage. Please see [LICENSE](LICENSE) for licensing and attribution terms.

## License

Preme Agent is released under the [MIT License](LICENSE).
