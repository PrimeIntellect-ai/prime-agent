---
name: prime-intellect
description: Work with Prime Intellect products via the prime CLI and Python SDKs - verifiers environments and the Environments Hub, evaluations (local and hosted), Hosted Training and prime-rl, code sandboxes, Prime Inference, GPU compute (pods and clusters), storage, and tunnels. Use when a task involves Prime Intellect, the prime CLI, verifiers, RL environments, evals, training, sandboxes, renting GPUs, Prime Inference models, or when the user asks what Prime Intellect is or what it offers.
---

# Prime Intellect

Prime Intellect is an open superintelligence lab building open-source AGI infrastructure: a platform for RL environments, evaluations, post-training, inference, and globally distributed GPU compute. Prime Agent (this agent) is built by Prime Intellect, and the `prime` CLI is the default way to interface with every product below.

## Product Map

| Product | What it is | Details |
|---|---|---|
| verifiers | Python library for building LLM environments and evaluations | [environments.md](references/environments.md) |
| Environments Hub | Platform library of community RL environments (`prime env`) | [environments.md](references/environments.md) |
| Hosted Evaluations | Run evals on Prime-managed infra (`prime eval run --hosted`) | [environments.md](references/environments.md) |
| Hosted Training | Post-train models against environments (`prime train`, Lab) | [environments.md](references/environments.md) |
| prime-rl | Large-scale async RL framework for self-managed training | [environments.md](references/environments.md) |
| Sandboxes | Secure disposable Docker environments for AI-generated code | [sandboxes.md](references/sandboxes.md) |
| Tunnels | Public HTTPS URLs for local/sandboxed services | [sandboxes.md](references/sandboxes.md) |
| Inference | OpenAI-compatible API for frontier models | [inference.md](references/inference.md) |
| Compute | Rent single GPU pods or multi-node clusters | [compute.md](references/compute.md) |
| Storage | Persistent disks shared between instances | [compute.md](references/compute.md) |

## Prime CLI Setup

Default to the `prime` CLI for all Prime Intellect operations. If it is not installed:

```bash
uv tool install prime    # or: pip install prime
prime login              # browser auth; or: prime config set-api-key
prime config view        # verify configuration
```

The same package provides the Python SDKs (e.g. `prime_sandboxes`, `prime_tunnel`). Source: https://github.com/PrimeIntellect-ai/prime

## Live Documentation

Authoritative, current docs live at https://docs.primeintellect.ai. Any docs page is fetchable as Markdown by appending `.md` to its URL, and the full index is at https://docs.primeintellect.ai/llms.txt. When you need details not covered here (exact flags, API schemas, pricing, new features), fetch the live docs instead of guessing:

```bash
curl -s https://docs.primeintellect.ai/llms.txt                      # discover pages
curl -s https://docs.primeintellect.ai/sandboxes/overview.md         # fetch a page as markdown
```

The REST API is documented under `api-reference/` pages (OpenAPI spec: https://api.primeintellect.ai/openapi.json), with `https://api.primeintellect.ai` as the base URL.

## Command Quick Reference

```bash
# Environments Hub
prime env list --search "math"      # discover environments
prime env info owner/name           # inspect one
prime env install owner/name        # install locally
prime env init my-env --v1          # scaffold a new environment
prime env push                      # publish to the Hub

# Evaluations
prime eval run my-env -m openai/gpt-4.1-mini -n 5    # local smoke eval
prime eval run owner/env --hosted --follow           # hosted eval with logs

# Training
prime lab setup                     # set up a Lab workspace (Hosted Training)
prime train models                  # models, capacity, pricing
prime train init && prime train rl.toml              # configure + launch a run

# Sandboxes
prime sandbox create python:3.11-slim --timeout-minutes 120
prime sandbox run <sandbox-id> "python --version"
prime sandbox delete <sandbox-id>

# Inference
prime inference models              # list available models

# Compute
prime availability list             # GPU availability + pricing
prime pods create                   # provision a pod
prime pods ssh <pod-id>             # SSH in (needs: prime config set-ssh-key-path)
```

## Working Conventions

- Prefer ecosystem-native paths (`prime env init`, `prime eval run`, `prime lab setup`) over custom scaffolding.
- Smoke-test small (`-n 5`) before scaling evals or training; keep default result uploads unless the user explicitly opts out.
- For non-trivial eval/training work, ask whether the user wants instruct models (`gpt-4.1` series, `qwen3` instruct) or reasoning models (`gpt-5` series, `qwen3` thinking, `glm` series).
- Hosted Training launches from a CPU machine; self-managed `prime-rl` requires local GPU access and is a power-user path.
- The dashboard at https://app.primeintellect.ai covers API keys, billing, teams, and anything the CLI does not.
