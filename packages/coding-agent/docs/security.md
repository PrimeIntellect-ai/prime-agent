# Security

Prime Agent treats project-provided instructions and executable resources as untrusted until the project trust boundary is resolved. Trust is resolved for the canonical working directory before project settings, resource discovery, or daemon-bound runtime services are created.

## Project trust boundary

The trust gate covers these project and ancestor resources:

- `.prime/agent/settings.json`
- `extensions`, `skills`, `prompts`, and `themes` under project resource configuration
- `.prime/agent/SYSTEM.md` and `.prime/agent/APPEND_SYSTEM.md`
- `AGENTS.md` and `CLAUDE.md` in the current directory and its ancestors
- non-user project and ancestor `.agents/skills` resources
- project package metadata and resources loaded through project packages

User-global resources under `~/.prime/agent` are not gated by project trust. An explicit absolute resource path supplied on the CLI is an explicit user choice and is loaded in CLI scope; project settings, package metadata, or an extension cannot manufacture that exception.

Trust decisions are keyed by canonical project paths in `<agentDir>/trust.json`. An explicitly trusted ancestor can apply to descendants, while trust for one sibling does not apply to another. Invalid or corrupt `trust.json` fails closed, reports a visible diagnostic, and loads zero project resources.

In interactive mode, the default `ask` decision offers:

- `Trust`
- `Trust parent folder (<path>)`
- `Trust (this session only)`
- `Do not trust`
- `Do not trust (this session only)`

The global-only `defaultProjectTrust` setting accepts exactly `"ask"`, `"always"`, or `"never"` and defaults to `"ask"`. It is read only from `~/.prime/agent/settings.json`; a project settings file cannot opt itself in. In non-interactive print, JSON, RPC, ACP, and daemon modes, `ask` behaves as untrusted because no prompt is shown.

The one-run overrides `--approve` / `-a` and `--no-approve` / `-na` take precedence over saved trust and the global default. They do not change saved trust.

## Daemon enforcement

Trust is resolved before the daemon creates cwd-bound runtime services, and the resolved decision is carried across the daemon protocol. A protocol-incompatible client and daemon are rejected rather than silently starting with different trust semantics: a new client does not send its trust decision to an old daemon, and an old client cannot start against a daemon that requires the new boundary. There is no unsafe compatibility fallback.

## Audit limitation

The moderate self-package CVE may continue to appear in `npm audit` because this fork has an independent version that still matches the upstream advisory range. That scanner result is a version-range limitation, not permission to suppress the advisory; behavioral project-trust tests provide the remediation evidence for this fork's boundary.
