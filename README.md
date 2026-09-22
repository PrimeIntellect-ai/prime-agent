<p align="center">
  <a href="https://primeintellect.ai">
    <picture>
      <source media="(prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/40c36e38-c5bd-4c5a-9cb3-f7b902cd155d">
      <source media="(prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/6414bc9b-126b-41ca-9307-9e982430cde8">
      <img alt="Prime Intellect" src="https://github.com/user-attachments/assets/6414bc9b-126b-41ca-9307-9e982430cde8" width="312" style="max-width: 100%;">
    </picture>
  </a>
</p>

<h3 align="center">
Prime Agent: A Self-Improving RLM Harness
</h3>

<p align="center">
  <a href="https://github.com/PrimeIntellect-ai/verifiers">Verifiers</a> &bull;
  <a href="https://github.com/PrimeIntellect-ai/prime-rl">PRIME-RL</a> &bull;
  <a href="https://arxiv.org/abs/2608.23552">RLM Paper</a>
</p>

<p align="center">
  <a href="https://github.com/PrimeIntellect-ai/prime-agent/actions/workflows/continuous.yml">
    <img src="https://github.com/PrimeIntellect-ai/prime-agent/actions/workflows/continuous.yml/badge.svg" alt="Continuous Build" />
  </a>
  <a href="https://arxiv.org/abs/2605.09998">
    <img src="https://img.shields.io/badge/arXiv-2605.09998-b31b1b.svg" alt="arXiv" />
  </a>
</p>

Prime Agent is an open-source coding and research agent for general and long-running work. It is designed around two core abstractions:

- The **[Recursive Language Model (RLM)](https://www.primeintellect.ai/blog/rlm)** treats context as variables (*prompt-as-a-variable*) and tools like recursive subagents as function calls (*programmatic tool /sub-agent calling*) inside a persistent REPL.
- The **[Continual Harness](https://arxiv.org/abs/2605.09998)** stores supplemental prompts, memories, skill descriptions, and reusable subagent specifications as durable state that Prime Agent can refine through small, evidence-backed updates, local to the session by default.

## Install

Download the latest build for your platform from the
[continuous release](https://github.com/PrimeIntellect-ai/prime-agent/releases/tag/continuous):

```sh
# macOS Apple Silicon (M1/M2/M3/M4)
curl -fsSL https://github.com/PrimeIntellect-ai/prime-agent/releases/download/continuous/prime-agent-0.1.0-aarch64-apple-darwin.tar.gz | tar xz -C prime-agent && ./prime-agent/prime-agent

# Linux x64
curl -fsSL https://github.com/PrimeIntellect-ai/prime-agent/releases/download/continuous/prime-agent-0.1.0-x86_64-unknown-linux-gnu.tar.gz | tar xz -C prime-agent && ./prime-agent/prime-agent
```

No Rust toolchain needed: the kernel runtime sidecar ships inside the tarball.

Or build from source:

```bash
cargo build --release --locked --workspace
```

## The Rust implementation

This branch is the Rust implementation of Prime Agent, a behavioral-parity rewrite of the TypeScript product on `main`. Same user experience, same model-facing surface, same wire protocol — faster, lighter, and more reliable:

- ~5x faster cold startup, ~7x lighter at idle
- The daemon is a supervisor: one worker process per session, restart-safe, append-only session state
- The TUI renders via ratatui with the same keybindings, themes, and visual language

## Architecture

The workspace is organized into focused crates with a cycle-free dependency direction (see [AGENTS.md](./AGENTS.md) for the full rules):

| crate | role |
|---|---|
| `pa-types` | shared wire & domain types |
| `pa-ai` | providers, model registry, streaming |
| `pa-models` | live model catalog |
| `pa-agent` | the agent loop |
| `pa-core` | session engine: tools, skills, compaction, refinement, kernel |
| `pa-daemon` | supervisor + per-session workers |
| `pa-tui` | terminal UI |
| `pa-cli` | the `prime-agent` binary |

## Contributing

Read [AGENTS.md](./AGENTS.md) before working in this repo. All changes go through PRs targeting the `rust` branch.

## License

See [LICENSE](./LICENSE).
