# Development

See the repository [AGENTS.md](../../../AGENTS.md) for the current contribution rules and required validation.

## Setup

Prime Agent requires Node.js 22.8.0 or newer.

```bash
git clone https://github.com/PrimeIntellect-ai/prime-agent
cd prime-agent
bun install --frozen-lockfile
```

Run from source:

```bash
/path/to/prime-agent/prime-agent.sh
```

The script can be called from any directory and preserves the caller's working directory. Use that behavior to run a source checkout against a separate test project.

## Product and Source Names

Prime Agent is the product, public CLI, release artifact, and repository name. The monorepo publishes its workspaces under the `@prime-intellect` npm scope and retains the inherited `pi` package manifest key and some `PI_*` compatibility environment variables.

Public releases are compiled Bun binary archives installed by the stable and beta installer scripts. `scripts/pack-prime-agent-release.mjs` assembles the platform archives and metadata. Do not document a package-manager install path for the public Prime Agent CLI.

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
bun run check
```

This performs formatting, linting, type checking, installer rendering checks, and the browser smoke check. It does not run the test suite.

Run focused tests from the package root. For example:

```bash
cd packages/coding-agent
bun test test/specific.test.ts
```

If you create or modify a test file, run that file and iterate until it passes. Coding-agent suite regressions belong under `test/suite/regressions/` and use the suite harness and faux provider rather than live provider credentials.
