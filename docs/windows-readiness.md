# Windows-readiness audit

Status: audited and (daemon-critical rows) fixed by lane `win-audit`. The
requirement (MISSION.md, *Windows-readiness*): no hard POSIX assumptions;
all platform-specific code behind small platform traits in cfg-gated modules
(transport, process control, file locking, file permissions, temp/config
dirs, shell selection). Windows support later means implementing traits,
never re-plumbing.

Markers: **[D]** daemon-redesign-critical (fixed in this lane),
**[P]** product-wide (fixed here when mechanical, otherwise follow-up lane),
**[T]** test-only (gate with `#[cfg(unix)]` where Unix-only).

## Platform module map (as landed)

| module | owns | Unix impl | Windows stub |
|---|---|---|---|
| `pa-types::platform::transport` | `TransportListener` / `TransportStream` (async, dyn-compatible) + `BlockingTransportStream`; `bind_transport` / `connect_transport` / `connect_blocking` | AF_UNIX socket files | named pipes (`platform/windows_pipe.rs`, lane `windows`): byte-mode duplex instances, busy-retry connect, blocking client with read deadline |
| `pa-types::platform::process` | `process_start_id` (pid-reuse identity), `is_process_alive` | `/proc/<pid>/stat` + `/proc/<pid>/status` | implemented (lane `windows`): `win:<creation FILETIME ticks>` via `OpenProcess`+`GetProcessTimes` (byte-equal in meaning to the TS PowerShell `.Ticks` query); liveness via `STILL_ACTIVE` exit-code probe, access-denied reads alive (TS EPERM semantics) |
| `pa-core::platform::process` | `Signal`, `kill_pid`, `kill_process_group_or_pid`, `pid_exists`, `set_new_process_group`, `set_no_window`, `termination_signal` | libc `kill(2)`, `process_group(0)`, `ExitStatusExt` | implemented (lane `windows`): `kill_pid` = TerminateProcess on the single pid (libuv/Node win32 mapping); `kill_process_group_or_pid` = absolute-System32 `taskkill /F /T /PID` (TS hardened `killOrphanProcess`; Job objects skipped - TS precedent is taskkill); `pid_exists` = shared handle probe; `set_new_process_group` = `CREATE_NEW_PROCESS_GROUP\|DETACHED_PROCESS\|CREATE_NO_WINDOW` (Node `detached:true` via `spawnHidden`); `set_no_window` = `CREATE_NO_WINDOW` (TS `windowsHide`); `termination_signal` = None (exit codes) |
| `pa-core::platform::lock_dir` | `LockDir::acquire` | mkdir `{file}.lock` + `utimensat` mtime bump, rmdir on Drop (proper-lockfile protocol) | implemented (lane `windows`): same mkdir/rmdir protocol; mtime probe via `CreateFileW(FILE_FLAG_BACKUP_SEMANTICS)` + `SetFileTime` |
| `pa-core::platform::perms` | `restrict_file` (0o600), `restrict_dir` (0o700), `set_private_mode`, `file_mode`, `is_executable`, `is_readable_writable` | chmod/mode bits, `access(2)` | inherited-ACL no-ops (documented degradation), open-probe readability |
| `pa-core::platform::shell` | `get_shell_config`, `resolve_kernel_bash_shell` | `/bin/bash` -> `which bash` -> `sh` | `Err(...)`; real impl = TS Git-Bash candidate order (never PATH) |
| `pa-daemon::platform` (paths) | per-OS endpoint naming: `socket_dir`, `default_daemon_socket_path`, `worker_socket_path`, `socket_identity` | `<TMPDIR>/prime-agent-<uid>/*.sock`, dev/ino identity | `\\.\pipe\prime-agent-daemon`, `\\.\pipe\prime-agent-worker-<key>-<id>`, identity `None` |

Ownership note: pa-types is the only crate every transport consumer can depend
on (pa-tui depends on pa-types alone), so the shared transport/process
contracts and their cfg-gated Unix impls live there; its README scope was
extended accordingly. pa-daemon reuses pa-core's `platform::perms` (it sits
above pa-core in the dependency direction).

## Audit tables (per crate)

### pa-types

| file:line | coupling | category | disposition |
|---|---|---|---|
| `platform/*` (new) | transport + process identity | **[D]** | fixed here |

No other platform coupling in pa-types (serde types only).

### pa-ai

No platform coupling found: pure HTTP/streaming over reqwest (rustls). No
`unsafe`, no `libc`. The `~/.aws` / `~/.config/gcloud` / `~/.prime` config
reads resolved via `$HOME` only (lane `win-dirs` finding) now route through
`pa_types::platform::home_dir` with the same per-site fallbacks.

### pa-agent

No platform coupling found (loop policy only; no process/socket code).

### pa-core

| file:line | coupling | category | disposition |
|---|---|---|---|
| `auth/storage.rs` (directory lock sidecar, 0o600/0o700, retry) | mkdir/utimensat + chmod | **[D]** | fixed: `platform::lock_dir` + `platform::perms` |
| `settings/storage.rs` (directory lock sidecar, atomic write 0o600) | mkdir/utimensat + chmod | **[D]** | fixed: same |
| `kernel/orphan_journal.rs` (`/proc/<pid>/stat` starttime, group SIGKILL, 0o600 append) | /proc + process control + chmod | **[D]** | fixed: `pa_types::platform::process::process_start_id` + `platform::process` + `platform::perms` |
| `kernel/manager/teardown.rs` (`kill_process`, cfg split) | signals | **[D]** | fixed: `platform::process::kill_pid` |
| `kernel/manager/requests.rs` (`Signal::as_libc`) | signals | **[D]** | fixed: enum moved to `platform::process` |
| `kernel/manager/startup.rs` (`unix_signal_of`) | signals | **[D]** | fixed: `platform::process::termination_signal` |
| `kernel/bootstrap.rs` (`is_executable` mode bits, `kill(pid,0)` probe, 0o600 lock file, `link(2)` dir lock) | perms + process + link(2) | **[D]** (kernel supervision) | fixed: `platform::perms`/`platform::process`; the `link(2)` dir lock stays Unix-only (Windows: `create_new` rename-publish; follow-up) |
| `tools/bash_local.rs` (`process_group(0)` detached spawn) | process control | **[D]** (bash tool exec model) | fixed: `platform::process::set_new_process_group` |
| `tools/shell_utils.rs` (`/bin/bash`, `which`, group SIGKILL) | shell + process control | **[D]** | fixed: `platform::shell` + `platform::process` |
| `tools/edit.rs` (`nix::unistd::access`) | access(2) | **[P]** | fixed: `platform::perms::is_readable_writable` |
| `tools/edit_diff.rs` (line endings) | line endings | **[P]** | already handled: `detect_line_ending` / `normalize_to_lf` / `restore_line_endings` preserve CRLF; no action |
| `session/manager.rs` (0o600 session files, atomic writes) | chmod | **[D]** (session files are the daemon reattach surface) | fixed: `platform::perms` |
| `models/private_auth.rs` (0o600 cache) | chmod | **[P]** | fixed: `platform::perms::restrict_file` |
| `refinement/mod.rs` (atomic save via settings storage) | chmod | **[P]** | fixed transitively (`settings::storage::atomic_write` walls the mode) |
| `cron/store/state.rs` (create_new lockfile + stale takeover) | locking | **[P]** | portable as-is (`create_new` works on Windows); keep, note in Windows lane (stale takeover timing unchanged) |
| `packages/mod.rs` (`std::env::temp_dir()/pi-extensions`) | temp dir | **[P]** | portable (`std::env::temp_dir`); TS uses `tmpdir()` too - no action |
| `packages/process.rs` (ExitStatusExt signal name) | signals | **[P]** | fixed: `platform::process::termination_signal` |
| `kernel/provisioner.rs:584-607` (`"/tmp"` fixtures) | test-only | **[T]** | in `#[cfg(test)]`; use `std::env::temp_dir()` in a follow-up |
| `tools/golden_replay.rs:94` (`/bin/bash -c` fixture runner) | test-only | **[T]** | whole module is `#![cfg(test)]`; route through `platform::shell` in a follow-up |
| `tools/edit_diff.rs:572` (`access_readable`, dead code w/ mode bits + euid) | test-only/dead | **[T]** | gated `#[cfg(unix)]`; candidate for deletion in a follow-up |
| `packages/tests.rs:5`, auth/settings test modules (mode assertions) | test-only | **[T]** | keep, or `platform::perms::file_mode` on the Windows lane |
| home-dir reads (skills loader/prompt-templates, packages mod/manager/resolve-auto, resources, settings manager, bootstrap venv, path/render/shell tools, models) | dirs | **[P]** | fixed (lane `win-dirs`): routed through `pa-types::platform::dirs::home_dir`, per-site fallbacks preserved |
| `tools/shell_utils.rs` `get_shell_env` (PATH split/join on hardcoded `:`) | path delimiter | **[P]** | fixed (lane `win-dirs`): `std::env::split_paths`/`join_paths` (Node `path.delimiter`) |
| `kernel/bootstrap/venv.rs` `find_executable` (bare name, no PATHEXT) + `~/.local/bin/uv` (no `.exe`) | PATH/PATHEXT | **[P]** | fixed (lane `win-dirs`): TS `windowsExecutableCandidates` port (pure fn, unit-tested on Linux) + `uv.exe` fallback |
| `auth/resolve_config_value.rs` (hardcoded `Command::new("bash")` for `!command`) | shell selection | **[P]** | fixed (lane `win-dirs`): configured shell via `platform::shell` with `ComSpec` (cmd.exe) fallback on win32 (TS `executeWithConfiguredShell` + `execSync`); Unix keeps `bash -c` |
| `tools/render_utils.rs` `shorten_path_replaces_home` (HOME-reading unit test) | test-only | **[T]** | fixed (lane `win-dirs`): gated `#[cfg(unix)]` |

### pa-daemon

| file:line | coupling | category | disposition |
|---|---|---|---|
| `socket.rs` (UnixStream connect/probe, dev/ino identity, `is_socket`, stale-file dance, 0o600) | transport + flock-adjacent lifecycle + perms | **[D]** | fixed: bind/connect via `pa_types::platform::transport`, naming/identity via `pa-daemon::platform`, perms via pa-core; `prepare_socket_path` cfg-split (win32: named pipes leave no file - TS returns early there too) |
| `platform/paths.rs` (new) | per-OS socket paths | **[D]** | fixed here; `\\.\pipe\...` names match TS `workerSocketPath` win32 branch |
| `platform/paths.rs` uid (`/proc/self/status`) | /proc | **[D]** | fixed (unix impl); Windows pipe names need no uid |
| `supervisor.rs` (UnixListener/UnixStream serve, worker spawn env/stdio, direct worker connect) | transport + process control | **[D]** | transport fixed. Worker spawn flags: stdio inherit is portable; Windows will want `CREATE_NO_WINDOW` (TS `windowsHide`) - follow-up in the Windows ProcessControl impl |
| `worker.rs` (UnixListener/UnixStream serve) | transport | **[D]** | fixed |
| `lease.rs` (`/proc/<pid>/stat`, `/proc/<pid>/status` liveness) | /proc identity | **[D]** | fixed: `pa_types::platform::process` (single parser shared with pa-core now); unverifiable liveness errs and counts the owner alive (fail-safe against reclaiming live leases) |
| `protocol.rs` (`process_start_id` from `/proc`) | /proc identity | **[D]** | fixed: shared parser |
| `descriptor.rs` (0o600 persist) | chmod | **[D]** | fixed: `pa_core::platform::perms` |
| `paths.rs` (HOME-based agent dir, `expand_tilde`, 0o700 ensure_dir) | dirs + chmod | **[D]** (dirs feed session store layout) | ensure_dir fixed via perms wall; HOME resolution fixed (lane `win-dirs`): `pa-types::platform::dirs::home_dir` (`HOME` -> `USERPROFILE` -> `HOMEDRIVE`+`HOMEPATH`, Node `os.homedir()` parity), and the unresolvable home is an explicit error instead of the old silent `/tmp` default (`home_dir`/`agent_dir`/`sessions_dir`/`expand_tilde` return `Result`) |
| `session_store.rs:593,621`, `worker.rs:1583`, `types.rs:195`, `session_stats.rs:286`, tests | test-only literals | **[T]** | in `#[cfg(test)]`; no action |

### pa-cli

| file:line | coupling | category | disposition |
|---|---|---|---|
| `daemon_client.rs` (std `UnixStream`, `try_clone`, `set_read_timeout`) | blocking transport | **[D]** | fixed: `BlockingTransportStream` (trait gained `set_read_timeout`), `connect_blocking`; mock tests gated `#[cfg(all(test, unix))]` |
| `interactive_mode.rs` (`process_group(0)` detached supervisor spawn) | process control | **[D]** | fixed: `pa_core::platform::process::set_new_process_group` (Windows impl will add `DETACHED_PROCESS`/Job semantics) |
| `daemon_command.rs` / `daemon_mode.rs` (default socket path) | socket path | **[D]** | fixed transitively via `pa_daemon::socket::default_daemon_socket_path` -> `pa-daemon::platform` |
| `daemon_discovery/mod.rs` (`std::os::unix` socket probe, `socket_dir()`, Unix-only root scoping; landed post-audit in #97) | transport + socket-dir scoping | **[D]** | fixed (lane `windows`): `scan_socket_dir`/`is_socket_file` gated `#[cfg(unix)]` with an empty not-unix sweep (TS `scanSocketDir` returns [] on win32); `state_root_matches` Windows arm is containment + always-true (TS `createDaemonStateRootMatcher` win32 predicate); `pa-daemon::platform::socket_dir` gained a not-unix impl (`<tmpdir>/prime-agent-user`, TS `defaultDaemonSocketDir` win32 shape) |
| `tests/daemon_commands_e2e.rs`, `tests/interactive_daemon_e2e.rs` (std UnixStream, `/proc/<pid>/stat` liveness) | test-only | **[T]** | keep; these drive the Linux product end-to-end; Windows CI lane will gate them `#[cfg(unix)]` |
| `tests/package_e2e.rs` (0o755 shim) | test-only | **[T]** | keep |
| `config.rs` (`expand_tilde_path`/`get_agent_dir` HOME reads) | dirs | **[P]** | fixed (lane `win-dirs`): `pa_types::platform::home_dir` + the win32 `~\` arm (TS `expandTildePath`) |

### pa-tui

| file:line | coupling | category | disposition |
|---|---|---|---|
| `daemon_client.rs` (tokio `UnixStream::connect`, `into_split`) | transport | **[D]** | fixed: `connect_transport` + `TransportStream::split`; mock tests gated `#[cfg(all(test, unix))]` |
| `autocomplete.rs`/`chrome.rs`/`bin/pa-tui-replay.rs` (`HOME` reads for `~` completion/splash/replay dirs) | dirs | **[P]** | fixed (lane `win-dirs`): `pa_types::platform::home_dir` (pa-tui depends on pa-types alone), per-site fallbacks preserved |

### Non-issues confirmed during the audit

- Line endings: the edit tool detects and preserves CRLF; bash output handling
  trims `\r` per line. No action.
- Path separators: all paths are built with `Path::join`/`PathBuf`; no
  hardcoded `\` or split-on-`/` in product code.
- Signal constants: no remaining `libc::SIG*` outside `pa-core::platform`.
- `unsafe`: workspace-level `unsafe_code = "forbid"` is relaxed only where
  `libc` calls require it; after this lane all `libc::` calls in product code
  live in `pa-core/src/platform/*` and `pa-types` has none.

## How the TS product walls these (reference citations)

- `utils/shell.ts` - `getShellConfig` / `resolveKernelBashShell`: Unix
  `/bin/bash` -> PATH -> `sh`; win32 Git-Bash canonical install paths, never
  PATH. `killProcessTree`: win32 `taskkill /F /T` (absolute System32 path),
  POSIX process-group SIGKILL with bare-pid fallback.
- `utils/child-process.ts` - `spawnHidden` (`windowsHide: true` for every
  non-interactive spawn), `isZombieProcess` (win32: not a zombie), process
  group liveness (`processGroupExists`: win32 false).
- `core/session-lease.ts` - `getProcessStartId`: win32 native path, `/proc`
  fast path, `ps -o lstart=` fallback (locale pinned); win32 transient
  EBUSY/EPERM/EACCES retries on rename.
- `utils/atomic-file.ts` - `renameOntoSync` retries EPERM/EACCES/EBUSY up to
  5x with sleep (Windows antivirus/indexer holds the destination).
- `utils/daemon-socket-path.ts` + `modes/daemon/daemon-socket.ts` - win32
  socket path normalization is case-insensitive, `defaultDaemonSocketPath` is
  `\\.\pipe\prime-agent-daemon`, the proper-lockfile lease is Unix-only
  (win32 returns undefined), `prepareDaemonSocketPath` returns early on win32.
- `modes/daemon/daemon-supervisor.ts` - `workerSocketPath`:
  `\\.\pipe\prime-agent-worker-<key>-<id12>` on win32 vs
  `<tmpdir>/prime-agent-<uid>/worker-<key>-<id12>.sock` elsewhere.
- `core/orphan-process-journal.ts` - `killOrphanProcess` mirrors
  `killProcessTree` (System32 taskkill vs group SIGKILL).
- `core/keybindings.ts` - win32 default keybindings differ (ctrl+z only on
  Unix, alt+v vs ctrl+v paste).

## Windows implementation checklist (follow-up lane)

1. `pa-types::platform::transport`: DONE (lane `windows`) - tokio named-pipe
   server (`\\.\pipe\`) implementing `TransportListener`/`TransportStream`
   plus a blocking client (`platform/windows_pipe.rs`); verified by
   `cargo check`/`clippy -p pa-types --target x86_64-pc-windows-gnu
   --all-targets` (green; the Windows-only round-trip tests compile there
   and run on a real Windows runner).
2. `pa-daemon::platform`: pipe-name endpoints exist already (this lane);
   verify the TS win32 naming exactly, drop the uid suffix there.
3. `pa-core::platform::process` + `pa-types::platform::process`: DONE
   (lane `windows`) - handle-probe liveness/identity (`OpenProcess`,
   `GetProcessTimes`, `STILL_ACTIVE`), `TerminateProcess` for single-pid
   signals, absolute-System32 `taskkill /F /T` for tree kills (TS
   precedent; Job objects not needed for parity), and the Node
   `detached`/`windowsHide` creation-flag pair (`set_new_process_group`
   now sets the detached+hidden flags on Windows; new `set_no_window`
   backs the TS `spawnHidden` spawns: bash tool, kernel bootstrap/REPL,
   daemon worker, taskkill itself). Windows-only tests compile in the
   cross-check and run on a real Windows runner.
4. `pa-core::platform::lock_dir`: DONE (lane `windows`) - the mkdir/rmdir
   protocol was already portable; the mtime probe now writes through
   `CreateFileW(FILE_FLAG_BACKUP_SEMANTICS)` + `SetFileTime` on the lock
   directory, so the staleness judgment is exact on NTFS too. The
   `LockFileEx` variant was NOT needed: the TS product's proper-lockfile
   protocol (directory presence + mtime) is the byte-compatibility
   contract, and it works on Windows as-is.
5. `pa-core::platform::perms`: DECIDED (lane `windows`) - TS parity is
   inherited ACLs, no explicit-ACL helper. The TS product performs no
   chmod-equivalent on win32 (its socket/lock chmod helpers return early);
   product state lives under the agent dir inside the user profile, whose
   ACLs are user-scoped by the OS default, which is the same protection
   0o600/0o700 buys on Unix. The no-op restriction helpers and the
   open-probe readability checks stay; tightening later would be an
   explicit-ACL helper behind `restrict_file`, not a new abstraction.
6. `pa-core::platform::shell`: TS Git-Bash candidate order; kernel `bash()`
   resolution via canonical install paths only.
7. `Dirs` helper: `HOME` vs `USERPROFILE` resolution for agent dir (both in
   `pa-daemon/src/paths.rs` and `pa-core/src/tools/shell_utils.rs`
   `get_agent_dir`). DONE (lane `win-dirs`): `pa-types::platform::dirs::home_dir`
   resolves `HOME` first (TS package-manager `process.env.HOME || homedir()`),
   then `USERPROFILE`, then `HOMEDRIVE`+`HOMEPATH`; every production
   home-dir read routes through it (pa-ai bedrock/ADC/team-id, pa-core
   skills/packages/resources/settings/bootstrap/venv/path-tools, pa-cli
   config, pa-tui autocomplete/chrome/replay, pa-daemon paths), tilde
   expansion gains the win32 `~\\` arm, `path.win32.join` semantics back
   `expand_path` on Windows, and the daemon's unresolvable home is an
   explicit error. Same lane: `get_shell_env` PATH split/join via
   `std::env::split_paths`/`join_paths` (Node `path.delimiter`), PATHEXT
   candidate resolution in the kernel bootstrap `find_executable`
   (+ `uv.exe` fallback), and `!command` config values spawn the configured
   shell with a `ComSpec` fallback on win32 (TS
   `executeWithConfiguredShell` + `execSync`).
8. Atomic writes: DONE (lane `win-rename`; follow-up lane `persist-rename`
   routed the remaining sites) - the TS `renameOntoSync`
   EPERM/EACCES/EBUSY retry lives in `pa-telemetry`'s `rename_onto`
   (re-exported as pa-core `platform::rename_onto`; 5 total attempts,
   `10ms * attempt` backoff, win32-only; the access-denied family via
   `PermissionDenied` plus raw `ERROR_SHARING_VIOLATION`/
   `ERROR_LOCK_VIOLATION` as libuv EBUSY) and backs every durable
   temp+rename persist whose TS counterpart goes through
   `writeFileAtomicSync`: pa-core `settings::storage::atomic_write` (auth
   storage, cron, refinement, package installs/updates) and the session
   manager's `atomic_write` (rewrite + crash repair), pa-daemon's worker
   descriptor/supervisor-config writes (`descriptor::write_file_atomic`),
   the update-flow manifest artifacts, the RLM display files, the session
   store rewrite, the command journal's compaction, and pa-telemetry's
   install-id replacement. Deliberately NOT routed (TS-matched bare
   renames): the worker recovery journal's compaction (TS
   `worker-recovery-journal.ts` `renameSync`), the update-flow status and
   intent files (TS `writeJsonAtomically` `renameSync`), log rotations,
   lock/lease/aside renames, and the sessions-archive move.
9. Session-lease / orphan-journal rename semantics: DONE (lane
   `win-rename`) - `std::fs::rename` on Windows calls `MoveFileExW` with
   `MOVEFILE_REPLACE_EXISTING` (std `sys/pal/windows/fs.rs`), so durable
   writes replace an existing destination exactly like Unix; the
   cross-platform `rename_onto_replaces_destination` test covers the
   replace-existing invariant (orphan-journal persists are plain
   temp-onto-path renames like TS `worker-recovery-journal.ts`). For the
   directory renames the TS lease adds win32 arms the port now carries:
   `is_rename_target_contention` (EEXIST/ENOTEMPTY always; EPERM/EACCES on
   win32 only when the lease directory exists, EBUSY never) and the
   stale-reclaim transient retry (win32-only, 8 total attempts, `10ms *
   attempt`, EPERM/EACCES/EBUSY) in `pa-daemon` `lease.rs`.
10. Gate the remaining test-only `/proc` and UnixSocket usages with
    `#[cfg(unix)]` where they assert Linux behavior.

## Verification status

- Linux gates: `cargo fmt --all --check`,
  `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo test -j4 --workspace` all green on this lane branch, including the
  supervisor e2e (drives the real pa-daemon binary over the refactored
  transport) and the CLI daemon-command e2e (blocking transport client).
- Windows cross-check: `cargo check --target x86_64-pc-windows-gnu
  --workspace --all-targets` is green on this lane (mingw-w64 toolchain
  installed in the sandbox; this compiled every crate including native ring).
  The `x86_64-pc-windows-msvc` std target is installed too, but its check
  stops at ring's `lib.exe` requirement (no MSVC tools in this sandbox);
  pa-types and pa-tui (the crates without native deps) check clean against
  it. The check found and fixed real cfg leaks during this lane (ungated Unix
  trait impls in the transport module, a dead `access_readable` helper that
  was actually live, test modules importing `std::os::unix`).
- Lane `windows` upgrade: the per-PR cfg-hygiene verifier is now
  `make windows-cross` - the same cross-target check plus
  `clippy --target x86_64-pc-windows-gnu --all-targets -- -D warnings`
  (it caught the lock_dir dead-code and a clippy::err_expect in the
  Windows-only tests). The staged ci.yml carries the matching
  `windows-cross` job and a real `windows` job (`windows-latest` runner)
  that runs the portable tests plus every Windows-only platform test;
  promotion happens with the rest of ci/workflows/ once the token gains
  `workflow` scope.
