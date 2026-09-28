# Rust quickstart — installing and running the Rust build (`prime-agent`)

The Rust rewrite of Prime Agent, packaged for coworkers. It is the same product
— same wire protocol family, same session store, same CLI shape — as the
TypeScript build, re-implemented in Rust; the port is in progress and tracked
row by row in [FEATURE_PARITY.md](FEATURE_PARITY.md). The Rust port owns the
product keyword: it installs as `prime-agent` and takes over an existing
TypeScript install (its daemon is stopped cleanly, its files are preserved
under a legacy name, and its npm package is uninstalled), while the session
store the two products share is never touched. This page covers install, the
takeover rules, and known limits — for feature status, read the parity
tracker, not this page.

## Install

The safe path: download the installer from the repo's `rust` branch,
inspect it, then run it. The script fetches the binary from the
`continuous` workflow's build artifacts — GitHub's artifact downloads need
an authenticated principal, so `gh auth login` once, or export a
`GITHUB_TOKEN`:

```bash
curl -fsSL \
  https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent/rust/install-rust.sh \
  -o /tmp/install-rust.sh
less /tmp/install-rust.sh                                     # inspect what you run
sh /tmp/install-rust.sh
```

The convenience one-liner (internal use — it pipes the script straight
from the branch into `sh`, so you are trusting the branch instead of
verifying the download; prefer the safe path when in doubt):

```bash
curl -fsSL \
  https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent/rust/install-rust.sh | sh
```

`install-rust.sh` resolves the newest **successful `continuous` run on the
`rust` branch** and installs its platform artifact (`PRIME_AGENT_RUST_RUN=<id>`
pins an exact run; the run id is in the run-page URL). It verifies the
tarball against the artifact's `SHA256SUMS` before extracting, installs the
payload under `~/.local/share/prime-agent/`, and writes the
`~/.local/bin/prime-agent` launcher — the same keyword the TypeScript
product used (`PRIME_AGENT_RUST_PREFIX` moves both; `PRIME_AGENT_RUST_REPO`
retargets the repo; the `RUST_*` env names are unchanged from previous
releases). The installed binary answers its exact source commit:
`--version` reports `<workspace-version>-continuous.<commit-sha>`. The
same command with `--update` re-installs the newest run; it is the entry
point the `prime-agent update` command and the TUI `/update` exec.

The installer also pre-warms the Python kernel: it makes sure `uv` exists
(installing it from the command the product's own error names when missing)
and runs `prime-agent --prime-agent-bootstrap`, so the first session's
kernel venv is ready before you start. Both steps are best-effort — if the
machine is offline, the install still succeeds with a warning, and the
first session needs the network once to bootstrap the kernel itself.

Manual steps — download the platform artifact from the latest run, verify
it, extract it, and run the binary directly:

```bash
run="$(gh run list --repo PrimeIntellect-ai/prime-agent --workflow continuous \
  --branch rust --status success --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run download "$run" --repo PrimeIntellect-ai/prime-agent \
  --name artifacts-aarch64-apple-darwin --dir /tmp/pa
cd /tmp/pa
shasum -a 256 -c SHA256SUMS                                   # verify the tarball
mkdir -p ~/.local/share/prime-agent
tar xzf prime-agent-*-darwin-arm64.tar.gz -C ~/.local/share/prime-agent
# Load-bearing without the launcher (see the daemon section below): the Rust
# daemon must get its OWN socket so it never touches the TS daemon.
export PRIME_AGENT_DAEMON_SOCKET="${TMPDIR:-/tmp}/prime-agent-rust-$(id -u)/daemon.sock"
~/.local/share/prime-agent/prime-agent --version
```

Built platforms (the `continuous` matrix; the tarball names carry the
workspace version, the binary inside answers `<version>-continuous.<sha>`):

| Platform | uname | Target triple | Artifact |
|---|---|---|---|
| macOS Apple Silicon | `Darwin arm64` | `aarch64-apple-darwin` | `artifacts-aarch64-apple-darwin` |
| macOS Intel (incl. Rosetta shells) | `Darwin x86_64` | `x86_64-apple-darwin` | `artifacts-x86_64-apple-darwin` |
| Linux x86_64 | `Linux x86_64` | `x86_64-unknown-linux-gnu` | `artifacts-x86_64-unknown-linux-gnu` |
| Linux arm64 | `Linux aarch64` | `aarch64-unknown-linux-gnu` | `artifacts-aarch64-unknown-linux-gnu` |

Linux floor: the GNU/Linux artifacts are built inside an Ubuntu 22.04
(glibc 2.35) container — they start on any glibc >= 2.35, and
`install-rust.sh` refuses installs on older glibc (or musl) systems with
the exact floor instead of installing a binary the dynamic loader will
not start.

No tags, no releases: the repo's release history belongs to the TypeScript
product, and versioned Rust releases come when the port graduates
(`prime-agent-design/RELEASE_SECURITY.md`). Artifacts stay downloadable
from each run's page (GitHub's default 90-day retention window).

## Run

```bash
prime-agent              # interactive TUI in the current directory
prime-agent -p "..."     # one-shot print mode
prime-agent --resume     # browse sessions or resume one directly
prime-agent agents       # running, idle, and saved sessions
prime-agent shutdown    # the TS state-root sweep (see Uninstall before relying on it)
```

The rest of the public commands (`attach`, `status`, `doctor`, `prompt`,
...) mirror the TS product. To update this installation, run:

```bash
prime-agent update --check   # what the latest build is, without installing
prime-agent update           # uninstall the TS version, install the latest
                            # Rust build — ~/.prime/agent is never touched
```

`prime-agent update` downloads the branch's `install-rust.sh` and runs it,
so the script owns the whole move (the same source the curl|sh one-liner
uses). The command exists only in the Rust binary — the TypeScript version
does not have it; the move happens when you run the curl|sh URL above or
`prime-agent update` (after the Rust install exists). Restart `prime-agent`
after the update to run the new build.

## The TypeScript takeover — what the installer does

The keyword belongs to the Rust port. On a machine that also has the
TypeScript product installed, the installer (run for install or update —
the steps are idempotent):

- **Stops the TS daemon cleanly, never kills it.** It probes the TS
  daemon's own socket (`${TMPDIR:-/tmp}/prime-agent-$(id -u)/daemon.sock`)
  the same way the CLI's schema-id check does — the daemon hello carries a
  schema id, and only the TS schema id identifies the TS daemon. An idle
  TS daemon is asked to `shutdown` (the graceful command; sessions close
  with resume entries kept). A busy one is left running to drain on its
  own, and no signal is ever sent to any pid from the installer.
- **Preserves the TS native install under a legacy name.** The TS
  installer's managed root (`~/.local/share/prime-agent`, marked by
  `.managed`) moves to `~/.local/share/prime-agent-legacy` — nothing is
  deleted; rollback is `mv` back plus re-linking the public bin symlink
  (the installer prints the exact commands).
- **Replaces the public `~/.local/bin/prime-agent` symlink** with the Rust
  launcher — the keyword changes hands.
- **Uninstalls the TS npm package** (`npm uninstall -g prime-agent`, exact
  package only) when the TS product was npm-installed, printing the restore
  command with the recorded version.
- **Never touches `~/.prime/agent/`.** The session store (sessions,
  leases, config) is shared with the TS product by design and is never
  created, migrated, renamed, or deleted — the installer aborts if any
  step would write under it.

Why daemon conflicts are impossible after this install: the launcher pins
a rust-only daemon socket
(`${TMPDIR:-/tmp}/prime-agent-rust-$(id -u)/daemon.sock`), a different
path than the TS daemon's own — so this CLI can never attach to or
replace the TS daemon at runtime — and the install-time stop-when-idle
retires a TS daemon cleanly instead of orphaning one. Pin + clean stop
together: the two daemons cannot fight over a socket again.

## The shared store and the daemons

**The session store is shared by design.** Both products read and write
`~/.prime/agent/` — the sessions dir and its session leases. The same
sessions appear in both products; a session saved in one is resumable in
the other. There is one store on the machine, and the products are two
views of it.

**The daemons are not shared.** Each product runs its own daemon, and the
`prime-agent` launcher pins its socket:

```bash
export PRIME_AGENT_DAEMON_SOCKET="${TMPDIR:-/tmp}/prime-agent-rust-$(id -u)/daemon.sock"
```

Without the pin, the Rust CLI would resolve the default socket, find the
TypeScript daemon on it, and — because the two products' daemon schema ids
differ — treat it as a stale daemon and shut it down when idle. The products
share the store, not the daemon; the launcher makes that split physical.
Run the binary manually without the launcher and you must export this
yourself (the build honors `--daemon-socket` > env > default).

**A session open in one product refuses to open in the other.** The session
file's runtime lease belongs to the product that has it open; the other
product refuses with the session, who holds it, and the two ways out —
concrete commands, so nothing is left to guess:

> This session is currently open in your TypeScript version of Prime Agent
> (active in \<holder-id\>). The Rust and TS versions share the same session
> store but not the same daemon, so this build cannot open the file while that
> process holds it.
>
> • Continue where you left off:
>   `'<holder binary>' --resume '<session-id>'`
>   (that TypeScript binary holds the lease — its daemon owns this session)
>
> • Take over on this daemon:
>   `kill '<holder-pid>' # the holder is '<its process image>'`
>   Then retry — the file unlocks when the holder exits.
>
> Session: '<session-id>' ('<session-name>')

— and the TypeScript product refuses in the same situation when this build
holds the session (the Rust-holder flavor of the same refusal names the
`prime-agent --daemon-socket <socket> --resume <session-id>` attach
command instead). Because the Rust port owns the `prime-agent` keyword, the
TS-holder continue path names the holder's own TypeScript binary (resolved
from the live holder — wherever the takeover preserved it) rather than the
keyword, which now launches this build. `<holder-id>` is the holder's
identity: its active session id when it recorded one (the TS session id),
else the holder pid. Never race one file in both products — continue in the
holder's product, or stop the holder and retry.

**Refusals leave a log record.** The daemon logs every refused session open
to its rotating log: `~/.prime/agent/logs/daemon.sock.<hash>.log` — the
socket's basename plus an 8-char hash of the socket path — so a
silent-looking failure still leaves a trace.

## Updating and uninstalling

Update: re-run the installer (or pass `--update`, the entry point the
update command and the TUI funnel to). It resolves the newest successful
`continuous` run by default, verifies, and replaces the payload in place;
the launcher is rewritten each time, one `share/prime-agent.old.<pid>`
rollback generation is kept (the previous install; swept on the next
update), and the session store is never touched by an update.

Uninstall — close the sessions, stop the Rust daemon, remove the two
paths:

```bash
# Stop your sessions first (a held lease refuses the payload swap):
prime-agent stop <active-session-id>          # or close them in the TUI
# The Rust daemon's socket is pinned OUTSIDE the shared state root, so the
# TS-root `shutdown` sweep does not reach it — stop it directly. (Its pid is
# also the first line of its log, beside the socket's hash-named file under
# ~/.prime/agent/logs/.)
pkill -f 'share/prime-agent/prime-agent --mode daemon'
rm -rf ~/.local/share/prime-agent ~/.local/bin/prime-agent
```

Note `prime-agent shutdown --force` sweeps the SHARED state root — it
stops every agent, worker, and daemon it discovers there, the TypeScript
daemon included (the same state-root-wide sweep the TS product's own
`shutdown` performs) — but it does NOT stop this build's own daemon,
whose socket is pinned outside that root. Never remove the shared
`~/.prime/agent` store; the uninstall paths are exactly the two above
(plus `~/.local/share/prime-agent-legacy` if a preserved TS install is
there and you no longer want the rollback).

## Known limits

- No Windows build yet. The `continuous` matrix publishes darwin
  arm64/x64 and linux x64/arm64; `install-rust.sh` installs all four and
  turns other platforms away with a specific message instead of a guess.
- The nightly/benchmark distribution channels are TS-only for now; the
  Rust build reaches coworkers through the `continuous` branch-push
  artifacts only — no tags, no releases (the repo's release history is
  the TypeScript product's).
- The port is mid-flight. Before filing a "missing feature" bug, check
  the row in [FEATURE_PARITY.md](FEATURE_PARITY.md) — the gap may already
  be known and owned by a lane.
- The pre-takeover `prime-agent-rust` layout still migrates: an old
  `~/.local/share/prime-agent-rust` install moves to the rollback slot on
  the first takeover install (the sandbox test
  `tests/installer/installer-takeover-test.sh` covers it).
