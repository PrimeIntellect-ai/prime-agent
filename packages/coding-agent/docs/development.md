# Development

See the repository [AGENTS.md](../../../AGENTS.md) for the current contribution rules and required validation.

## Setup

Prime Agent requires Node.js 22.8.0 or newer.

```bash
git clone https://github.com/PrimeIntellect-ai/prime-agent
cd prime-agent
npm ci
```

Run from source:

```bash
/path/to/prime-agent/prime-agent.sh
```

The script can be called from any directory and preserves the caller's working directory. Use that behavior to run a source checkout against a separate test project.

## Pre-push Guard

`.husky/pre-push` runs for every `git push` and refuses mirror-like pushes and remote branch deletions to real GitHub remotes (github.com and ssh.github.com in scp, `http://`, `https://`, and `ssh://` forms, with or without credentials and ports, including `www.` and trailing-dot host spellings); local, `file://`, and other remotes are always allowed. The hook ships via husky and is active after `npm ci`.

Worktrees and clones without husky's `.husky/_` shims (for example a bare `git worktree add` tree) activate the tracked hooks directly, with no npm or husky needed:

```bash
git config core.hooksPath .husky
```

The setting is shared across worktrees and the relative path resolves per tree. Running `npm ci` in any tree regenerates husky's shims and resets the shared `core.hooksPath` to `.husky/_`, which silences the tracked hooks in shimless worktrees again; re-run the one-liner after `npm ci`, or run `npx husky` inside a worktree to give it its own shims.

Intentional pushes can opt out once with `PRIME_AGENT_ALLOW_MIRROR_PUSH=1 git push ...`. Pushes with more than 10 refs (a `git push --tags` release) are refused; use the escape hatch. Not caught: deletions of remote-only refs through `--mirror` pruning (git never lists them on the pre-push stdin), ssh alias remotes, `insteadOf` rewrites to a proxy, and uppercase hostnames. `git push --no-verify` bypasses pre-push hooks entirely, so this guard is advisory; server-side, GitHub branch protection rules are the real mitigation, and `main` is protected — that is what rejected the incident's force update to `main`.

## Product and Source Names

Prime Agent is the product, public CLI, release artifact, and repository name. The monorepo still retains inherited `@earendil-works/pi-*` npm workspace names, a source-package `pi` bin entry, the `pi` package manifest key, and some `PI_*` compatibility environment variables. These names are source and compatibility details, not a signal that contributors should install or develop against pi-mono.

Public releases are currently versioned tarball artifacts installed by the stable and beta installer scripts. `scripts/pack-prime-agent-release.mjs` rewrites the coding-agent package name, executable, config metadata, and internal dependency URLs for that distribution. Do not document the inherited npm workspace package as the public Prime Agent install path.

## Local Configuration

User configuration lives under `~/.prime/agent/`. Project-local settings, prompts, themes, extensions, skills, and system-prompt files live under `.prime/agent/` in the project root. Override the user config directory with `PRIME_AGENT_CODING_AGENT_DIR` and the session directory with `PRIME_AGENT_SESSION_DIR`.

Use an isolated config directory when manually exercising daemon behavior so development sessions do not collide with normal sessions:

```bash
PRIME_AGENT_CODING_AGENT_DIR=/tmp/prime-agent-dev /path/to/prime-agent/prime-agent.sh
```

## Daemon Protocol Changes

Classify every daemon command, event, or response-shape change as backward-compatible, capability-gated, or incompatible. Optional behavior must be negotiated and degrade locally. Follow the protocol-version, schema-revision, compatibility-map, and cross-version test requirements in the root `AGENTS.md` before changing the wire contract.

## Package Asset Resolution

Prime Agent runs from source, Node.js package output, and standalone release artifacts. Always use `src/config.ts` helpers for package assets:

```typescript
import { getPackageDir, getThemeDir } from "./config.js";
```

Do not resolve packaged assets directly from `__dirname`.

## Debugging

The hidden `/debug` command writes `~/.prime/agent/prime-agent-debug.log` with rendered TUI lines, their visible widths, and the current agent messages. Daemon, worker, client, and provider diagnostic logs live under `~/.prime/agent/logs/`.

Useful service commands:

```bash
prime-agent status
prime-agent doctor
prime-agent doctor --fix
prime-agent shutdown
```

## Validation

After code changes, run the repository check from the root:

```bash
npm run check
```

This performs formatting, linting, type checking, installer rendering checks, and the browser smoke check. It does not run the test suite.

Run focused tests from the package root. For example:

```bash
cd packages/coding-agent
npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts
```

If you create or modify a test file, run that file and iterate until it passes. Coding-agent suite regressions belong under `test/suite/regressions/` and use the suite harness and faux provider rather than live provider credentials.

## Capability Evals

End-to-end capability evals live under `scripts/evals/` and are not part of CI: a real-model run is a manual step with credentials in the environment. Each harness ships model-free self-tests that validate its fixtures and rubric without any model call - run them from the eval directory:

```bash
cd scripts/evals/swarm_fanout
uv run --locked ruff check .
uv run --locked python -m unittest discover -s tests -v
```

See `scripts/evals/README.md` for the rubric and the real-model run instructions.
