# Releasing

How to prepare, verify, and publish a Prime Agent release. The mechanical steps live in `scripts/release.mjs`; this document adds the verification the scripts cannot do.

## Prepare the release PR

1. Branch from fresh `main` (e.g. `chore/release-x.y.z`).
2. Bump versions in lockstep: `npm run version:<patch|minor|major>`. Known issue: on 0.x minor bumps the script's own `npm install` can fail with ETARGET before `sync-versions.js` runs, because dependent caret ranges (`^0.8.x`) cannot resolve the new minor from the registry. If that happens, run the steps manually: `node scripts/sync-versions.js`, bump the root `package.json` version and its `@earendil-works/pi-coding-agent` range, then reinstall.
3. Refresh the lockfile minimally: restore `package-lock.json` from `main` and run `npm install`. Do not regenerate the lockfile from scratch for a release PR — a fresh resolve floats every third-party dependency at once and has broken the browser-smoke check before (`@mistralai/mistralai` drifting to a version whose optional otel import esbuild cannot resolve).
4. Aggregate changelog fragments into the per-package `CHANGELOG.md`s for the new version and `git rm` the consumed fragments (the changelog portion of `scripts/release.mjs`). Check the rendered markdown: every entry must be a `-` list item (a fragment missing its marker merges into the previous entry).
5. Open the PR with the validation results listed explicitly (see #1794, #1956 for the format). Tag and publish only after merge.

## Pre-release verification

### Test gate

Run the full suite in a clean sandbox at the release base, mirroring the CI matrix (`npm run build`, root `npm run check`, per-package suites, coding-agent `test:ci` shards + `test:process` + `test:kernel`, and the `prime-agent-runtime` Python suite). Compare failures by file against the environmental baseline below; any failure outside the baseline blocks the release.

The environmental baseline is the set of test failures caused by the sandbox environment rather than the code, re-derived by running the same suite at the previous release tag in an identical sandbox: only failures that occur at BOTH refs, in the same files, are baseline. As of v0.9.1 the CI-mirroring baseline is 4 tests across 3 files, all environment-shaped: `tools.test.ts` (2 EACCES failures when running as root), `config.test.ts` (config dir not writable as root), and `4603-worker-recovery.test.ts` (requires `lsof`). A raw full-suite run without CI's environment adds kernel-skill bridge suites (`kernel-agent-message-skill`, `kernel-agent-observe-skill`, `kernel-attach-image-skill`, `kernel-rlm-heartbeat-skill`), `sdk-session-manager`, `agent-session-recursion`, and `4428-cancel-mid-tool` — legitimate in CI, environment-dependent outside it. When the baseline changes, update this paragraph in the same PR that observed the change.

### Cross-surface data checks

Motivation: v0.9.0 shipped with an empty Inactive section in the agents view. The roster seed had been scoped down (#1951) with byte-for-byte parity proven for `list --all` — but the agents view consumed the seeded rows through a different surface (`roster_subscribe`), which nobody re-checked. Parity on one surface does not cover the others: **when a producer changes what it emits, every consumer surface must be re-verified.**

Build one populated fixture agent dir: a few hundred saved sessions including finished subagent families with no live worker ("dead families"), plus one live session with a running and a completed subagent. Then check every surface that displays session or agent data:

- `prime-agent list`: live rows only, correct statuses.
- `prime-agent list --all`: saved sessions and dead-family subagent rows all present.
- TUI agents view on a **fresh** view (no search text typed): Running, Idle, and Inactive sections all populate; search narrows without losing sections.
- Subagents bar in an active chat: counts match the spawned children.
- Resume a saved session; wake/message a completed subagent by name.
- `prime-agent update` path: daemon restores sessions after the update and the surfaces above still hold.

### Performance spot checks

On a large session corpus (thousands of saved sessions), time daemon cold boot (first command after daemon death) and first/steady `list --all` against the previous release. Regressions here are user-visible on every machine with a long history; they must be either fixed or called out in the release notes.

## Publish

After merge: `git tag vx.y.z`, push the tag, `npm run publish` (see the tail of `scripts/release.mjs`). Announce with the release notes and changelog.

