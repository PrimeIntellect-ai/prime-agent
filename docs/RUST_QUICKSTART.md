# Rust quickstart — installing and running the Rust build (`prime-agent-rust`)

The Rust rewrite of Prime Agent, packaged for coworkers. It is the same product
— same wire protocol family, same session store, same CLI shape — as the
TypeScript build, re-implemented in Rust; the port is in progress and tracked
row by row in [FEATURE_PARITY.md](FEATURE_PARITY.md). It installs side by side
with the TypeScript product under the name `prime-agent-rust` and never touches
the TS install: both products can run at once, and they share one session
store, so the same sessions are visible in both. This page covers install, the
day-one cohabitation rules, and known limits — for feature status, read the
parity tracker, not this page.

## Install

The one-liner. The repo is private, so authentication is mandatory:
`gh auth login` once, or export a `GITHUB_TOKEN`:

```bash
curl -fsSL -H "Authorization: Bearer $(gh auth token)" \
  https://github.com/PrimeIntellect-ai/prime-agent/releases/download/rust-v0.1.0/install-rust.sh | sh
```

`install-rust.sh` travels on every `rust-v*` release, so the one-liner works
from whichever one you grab; whatever release the script came from, it installs
the latest `rust-v*` binaries by default (`PRIME_AGENT_RUST_TAG=rust-v0.2.0`
pins a version). It verifies the tarball against the release's `SHA256SUMS`,
installs the payload under `~/.local/share/prime-agent-rust/`, and writes the
`~/.local/bin/prime-agent-rust` launcher (`PRIME_AGENT_RUST_PREFIX` moves both;
`PRIME_AGENT_RUST_REPO` retargets the repo).

Manual steps — download the tarball for your platform, verify it, extract it,
and run the binary directly:

```bash
gh release download rust-v0.1.0 --repo PrimeIntellect-ai/prime-agent \
  --pattern 'prime-agent-0.1.0-aarch64-apple-darwin.tar.gz' --pattern SHA256SUMS --dir /tmp/pa
cd /tmp/pa
# SHA256SUMS covers every platform; check only the one you downloaded
# (portable on macOS and Linux — no --ignore-missing needed).
grep 'prime-agent-0.1.0-aarch64-apple-darwin.tar.gz$' SHA256SUMS | shasum -a 256 -c
mkdir -p ~/.local/share/prime-agent-rust
tar xzf prime-agent-0.1.0-aarch64-apple-darwin.tar.gz -C ~/.local/share/prime-agent-rust
# Load-bearing without the launcher (see the daemon section below): the Rust
# daemon must get its OWN socket so it never touches the TS daemon.
export PRIME_AGENT_DAEMON_SOCKET="${TMPDIR:-/tmp}/prime-agent-rust/daemon.sock"
~/.local/share/prime-agent-rust/prime-agent --version
```

Published platforms (`0.1.0` is the workspace version at the time of writing;
each `rust-v*` release supersedes it — the asset names follow the release
tag):

| Platform | uname | Target triple | Tarball |
|---|---|---|---|
| macOS Apple Silicon | `Darwin arm64` | `aarch64-apple-darwin` | `prime-agent-0.1.0-aarch64-apple-darwin.tar.gz` |
| macOS Intel (incl. Rosetta shells) | `Darwin x86_64` | `x86_64-apple-darwin` | `prime-agent-0.1.0-x86_64-apple-darwin.tar.gz` |
| Linux x86_64 | `Linux x86_64` | `x86_64-unknown-linux-gnu` | `prime-agent-0.1.0-x86_64-unknown-linux-gnu.tar.gz` |

Before a tag is cut, every push to the `rust` branch also produces downloadable
artifacts on the rust-release workflow's run page — the early-adopter channel.

## Run

```bash
prime-agent-rust              # interactive TUI in the current directory
prime-agent-rust -p "..."     # one-shot print mode
prime-agent-rust --resume     # browse sessions or resume one directly
prime-agent-rust agents       # running, idle, and saved sessions
prime-agent-rust shutdown    # stop every agent, worker, and daemon it discovers
```

The rest of the public commands (`attach`, `status`, `doctor`, `update`,
`prompt`, ...) mirror the TS product.

## Both versions installed — what to expect

This is the section that matters. The two products share one session store and
never share a daemon; everything else follows from that split.

**The session store is shared by design.** Both products read and write
`~/.prime/agent/` — the sessions dir and its session leases. The same
sessions appear in both products; a session saved in one is resumable in the
other. There is one store on the machine, and the products are two views of
it.

**The daemons are not shared.** Each product runs its own daemon, and the
`prime-agent-rust` launcher pins its socket:

```bash
export PRIME_AGENT_DAEMON_SOCKET="${TMPDIR:-/tmp}/prime-agent-rust/daemon.sock"
```

Without the pin, the Rust CLI would resolve the default socket, find the
TypeScript daemon on it, and — because the two products' daemon schema ids
differ — treat it as a stale daemon and shut it down when idle. The products
share the store, not the daemon; the launcher makes that split physical. Run
the binary manually without the launcher and you must export this yourself
(the build honors `--daemon-socket` > env > default).

**A session open in one product refuses to open in the other.** The session
file's runtime lease belongs to the product that has it open; the other product
refuses with the session, who holds it, and the two ways out — concrete
commands, so nothing is left to guess:

> This session is currently open in your TypeScript version of Prime Agent
> (active in \<holder-id\>). The Rust and TS versions share the same session
> store but not the same daemon, so this build cannot open the file while that
> process holds it.
>
> • Continue where you left off:
>   `prime-agent --resume \<session-id\>`
>   (switch to the TypeScript product — its daemon owns this session)
>
> • Take over on this daemon:
>   `kill \<holder-pid\>`
>   Then retry — the file unlocks when the holder exits.
>
> Session: \<session-id\> (\<session-name\>)

— and the TypeScript product refuses in the same situation when this build
holds the session (the Rust-holder flavor of the same refusal names the
`prime-agent-rust --daemon-socket <socket> --resume <session-id>` attach
command instead). `<holder-id>` is the holder's identity: its active session
id when it recorded one (the TS session id), else the holder pid. Never race
one file in both products — continue in the holder's product, or stop the
holder and retry.

**Refusals leave a log record.** The daemon logs every refused session open
to its rotating log: `~/.prime/agent/logs/daemon.sock.<hash>.log` — the
socket's basename plus an 8-char hash of the socket path — so a
silent-looking failure still leaves a trace.

## Updating and uninstalling

Update: re-run the installer. It resolves the latest `rust-v*` release by
default, verifies, and replaces the payload in place; the launcher is
rewritten each time, and the session store is never touched by an update.

Uninstall:

```bash
prime-agent-rust shutdown --force
rm -rf ~/.local/share/prime-agent-rust ~/.local/bin/prime-agent-rust
```

Close your sessions first (a held lease refuses the sweep). Note that
`shutdown` stops every agent, worker, and daemon it discovers in the state
root — the TypeScript daemon included: it is the same state-root-wide sweep
the TS product's own `shutdown` performs, on both sides. If you would rather
leave the TS daemon running, close the Rust sessions and go straight to the
`rm -rf`. Never remove the TypeScript product's files; the Rust uninstall
paths are exactly the two above.

## Known limits

- No linux-arm64 or Windows builds yet. The rust-release matrix publishes
  darwin arm64/x64 and linux x64; `install-rust.sh` turns linux-arm64 away
  with a specific message instead of a guess.
- The nightly/benchmark distribution channels are TS-only for now; the Rust
  build reaches coworkers through `rust-v*` releases and branch-push
  artifacts only.
- The port is mid-flight. Before filing a "missing feature" bug, check the
  row in [FEATURE_PARITY.md](FEATURE_PARITY.md) — the gap may already be
  known and owned by a lane.
