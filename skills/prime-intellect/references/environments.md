# Environments, Evaluations & Training

verifiers is Prime Intellect's Python library for LLM environments: packages that expose `load_environment` and bundle datasets, rollout logic, and reward rubrics. Environments power evaluations (local and hosted) and RL training (Hosted Training or self-managed prime-rl).

Live docs: `verifiers/overview.md`, `tutorials-environments/getting-started.md`, `hosted-training/getting-started.md`, `prime-rl/overview.md` under https://docs.primeintellect.ai/ (append `.md` for raw markdown). Source: https://github.com/PrimeIntellect-ai/verifiers and https://github.com/PrimeIntellect-ai/prime-rl

## Discovering Environments (Hub)

```bash
prime env list --search "math" --owner primeintellect --show-actions
prime env list --tag tools --tag sandbox
prime env list --mine
prime env list --starred
prime env info owner/name        # metadata, version, dependencies
prime env status owner/name      # CI/action status
prime env pull owner/name -t ./tmp-env   # pull source for inspection
prime env install owner/name     # install locally
```

When picking candidates, prefer: `primeintellect`-owned, passing latest actions, updated within ~2 months, recent verifiers versions. Compare task type (single-turn, multi-turn, tool, sandbox, agent), reward type (binary, continuous, judge-based), and dependency/secret requirements.

## Creating Environments

```bash
prime env init my-env --v1       # scaffold (add --with-harness for an explicit reusable harness)
prime env install my-env
prime eval run my-env -m openai/gpt-4.1-mini -n 5   # smoke test immediately
prime env push                   # publish to the Hub
```

Build guidance:

- Define the task contract first: prompt shape, allowed tools, stop conditions, rubric outputs, metrics.
- Prefer starting from an existing Hub environment (`prime env list --search`, then `prime env install owner/name`) over building from scratch.
- v1 environments expose `load_environment(config: vf.EnvConfig) -> vf.Env`; Taskset + Harness environments additionally expose `load_taskset(config)` and optionally `load_harness(config)` with `load_environment` delegating through `vf.load_taskset`/`vf.load_harness`.
- The environment must install, load, evaluate, and train without hidden setup.

## Evaluations

`prime eval run` is the canonical eval path. Runs save automatically (visible in the Evaluations tab and `prime eval view`); do not add `--skip-upload` unless the user explicitly asks.

```bash
prime eval run my-env -m openai/gpt-4.1-mini -n 5               # smoke
prime eval run owner/env -m openai/gpt-4.1-mini -n 200 -r 3 --shuffle -s   # scaled
prime eval run owner/env --hosted --follow                       # hosted, streaming logs
```

- Smoke-test first; scale only after a pass. Use `--shuffle` (seed defaults to 0; set `--shuffle-seed` for reproducible reports).
- Hosted evals require the environment to be published (`prime env push`) and support TOML configs and temporary sandbox/tunnel permissions (`--allow-tunnel-access`).
- Prime Inference models include estimated run cost in eval output automatically.
- Keep reusable model endpoints as aliases in `configs/endpoints.toml` (fields: `endpoint_id`, `model`, `url`, key) and reference them with `-m <endpoint_id>`.

## Training

Default to Hosted Training unless the user explicitly wants self-managed infrastructure.

```bash
prime lab setup                  # Lab workspace for environments, evals, GEPA, Hosted Training
prime train models               # supported models, capacity, pricing
prime train init                 # generate a training config
prime train rl.toml              # launch the run
```

- Hosted Training launches from a CPU machine; no local GPUs needed.
- Validate the environment with an eval before training (e.g. `-n 20 -r 3 -s`) and confirm reward diversity exists at baseline.
- Self-managed path: `prime lab setup --prime-rl`, then follow prime-rl's own configs and launch commands. Treat prime-rl as a power-user path requiring local GPU access; see https://docs.primeintellect.ai/prime-rl/overview.md.

## Model Family Choice

Ask the user whether they want instruct or reasoning models before non-trivial runs:

- Instruct (quick behavior checks): `gpt-4.1` series, `qwen3` instruct series.
- Reasoning (harder probes, deeper coverage): `gpt-5` series, `qwen3` thinking series, `glm` series.
