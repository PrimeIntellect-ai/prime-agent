#!/bin/sh
# The install-rust.sh takeover sandbox test.
#
# Runs the REAL installer in a sandboxed HOME with a faked TypeScript
# product on disk (its native install tree, its public bin symlink, its
# npm package, a live mock TS daemon speaking the real hello protocol on
# the TS socket) and asserts the takeover contract:
#   (a) the launcher lands at $PREFIX/bin/prime-agent,
#   (b) ~/.prime/agent (the shared session store) is byte-identical,
#   (c) the TS daemon was stopped cleanly via the schema-id stop-when-idle
#       path (a `shutdown` request with force:false — never a kill), and a
#       BUSY TS daemon is left running untouched,
#   (d) an existing share/prime-agent-rust install migrates to the new name
#       with a .old rollback, and the TS native tree is preserved under
#       share/prime-agent-legacy,
#   (e) the TS npm package is uninstalled via npm (exact package),
#   (f) the guard: PRIME_AGENT_RUST_PREFIX pointing into ~/.prime/agent
#       aborts the install before anything is written,
#   (g) --update re-runs idempotently (one .old generation, same result).
#
# Everything is offline: a mock `gh` serves a fixture artifact, a mock `npm`
# records the uninstall, and the mock daemon speaks the daemon wire protocol
# (daemon_hello with the TS schemaId, `list`, `shutdown`) exactly like the
# TypeScript product.
set -u

TEST_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd)"
INSTALLER="${REPO_ROOT}/install-rust.sh"

# The installer reads these; keep the sandbox hermetic regardless of the
# environment this test itself runs under.
unset PRIME_AGENT_RUST_REPO PRIME_AGENT_RUST_RUN PRIME_AGENT_RUST_PREFIX
unset GITHUB_TOKEN

REAL_UID="$(id -u)"

failures=0
passed=0
fail() { echo "FAIL: $1" >&2; failures=$((failures + 1)); }
ok() { echo "ok:   $1"; passed=$((passed + 1)); }
assert_eq() { # label expected actual
  if [ "$2" = "$3" ]; then ok "$1"; else fail "$1: expected [$2], got [$3]"; fi
}
assert_contains() { # label haystack-file needle
  if grep -q -- "$3" "$2" 2>/dev/null; then ok "$1"; else fail "$1: [$(basename "$2")] does not contain: $3"; fi
}
assert_not_contains() { # label haystack-file needle
  if grep -q -- "$3" "$2" 2>/dev/null; then fail "$1: [$(basename "$2")] unexpectedly contains: $3"; else ok "$1"; fi
}

MOCK_PIDS=""
cleanup() {
  for pid in $MOCK_PIDS; do
    kill "$pid" 2>/dev/null || true
  done
  [ -n "${SANDBOX:-}" ] && rm -rf "$SANDBOX"
}
trap cleanup EXIT INT TERM

# --- the mock TS daemon (the real wire shapes from daemon-supervisor.ts) ------
write_daemon_mock() { # path
  cat > "$1" <<'PY'
import json, os, socket, sys, time

socket_path, log_path, ready_path, active_count = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
count = int(active_count) if active_count.isdigit() else 0

os.makedirs(os.path.dirname(socket_path), exist_ok=True)
if os.path.exists(socket_path):
    os.unlink(socket_path)
srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
srv.bind(socket_path)
srv.listen(4)
with open(ready_path, "w") as ready:
    ready.write("ready")
log = open(log_path, "a", buffering=1)
log.write("LISTENING sessions=%d\n" % count)
while True:
    try:
        conn, _ = srv.accept()
    except OSError:
        break
    hello = {
        "type": "daemon_hello",
        "socketPath": socket_path,
        "protocol": {"name": "prime-agent-daemon", "version": 7},
        "schemaId": "protocol-7-schema-29-a5c9d20f8b13",
        "appVersion": "9.9.9",
        "supervisorPid": os.getpid(),
    }
    conn.sendall((json.dumps(hello) + "\n").encode())
    conn.settimeout(2.0)
    shutting_down = False
    buf = b""
    try:
        while True:
            data = conn.recv(4096)
            if not data:
                break
            buf += data
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                log.write("RECV " + line.decode("utf-8", "replace") + "\n")
                try:
                    command = json.loads(line)
                except ValueError:
                    continue
                if command.get("type") == "list":
                    response = {
                        "type": "response",
                        "id": command.get("id"),
                        "success": True,
                        "data": {"sessions": [
                            {"activeSessionId": "sess-active-%d" % i}
                            for i in range(count)
                        ]},
                    }
                    conn.sendall((json.dumps(response) + "\n").encode())
                elif command.get("type") == "shutdown":
                    response = {
                        "type": "response",
                        "id": command.get("id"),
                        "success": True,
                        "data": "shutdown",
                    }
                    conn.sendall((json.dumps(response) + "\n").encode())
                    shutting_down = True
    except OSError:
        pass
    conn.close()
    if shutting_down:
        log.write("SHUTDOWN\n")
        break
srv.close()
try:
    os.unlink(socket_path)
except OSError:
    pass
log.write("EXIT\n")
PY
}

# --- the mock gh (offline artifact serving) -----------------------------------
write_gh_mock() { # path
  cat > "$1" <<'MOCK'
#!/bin/sh
# mock gh for the installer sandbox test: run list -> a fake run id;
# run download -> copy the fixture artifact into the requested --dir.
case "$1 $2" in
  "run list") echo "424242" ;;
  "run download")
    dir=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --dir) dir="$2"; shift ;;
      esac
      shift
    done
    if [ -z "$dir" ]; then
      echo "mock gh: run download without --dir" >&2
      exit 1
    fi
    mkdir -p "$dir"
    cp "$GH_FIXTURE_DIR/SHA256SUMS" "$GH_FIXTURE_DIR/manifest.json" "$dir/"
    cp "$GH_FIXTURE_DIR"/*.tar.gz "$dir/"
    ;;
  *) echo "mock gh: unexpected call: $*" >&2; exit 1 ;;
esac
MOCK
  chmod 0755 "$1"
}

# --- the mock npm (records the uninstall) --------------------------------------
write_npm_mock() { # path
  cat > "$1" <<'MOCK'
#!/bin/sh
# mock npm for the installer sandbox test: root -g -> the fake global root;
# uninstall -g prime-agent -> remove the package and record the call.
echo "npm $*" >> "$NPM_MOCK_LOG"
case "$1 $2" in
  "root -g") echo "$NPM_MOCK_ROOT" ;;
  "uninstall -g")
    if [ "$3" = "prime-agent" ]; then
      rm -rf "$NPM_MOCK_ROOT/prime-agent"
    fi
    ;;
esac
MOCK
  chmod 0755 "$1"
}

# --- the fixture artifact -------------------------------------------------------
build_fixture() { # sandbox-dir target-triple
  fixture="$1/fixture"
  mkdir -p "$fixture/payload/docs"
  cat > "$fixture/payload/prime-agent" <<'BIN'
#!/bin/sh
# fake payload binary for the installer sandbox test
printf '0.1.2-continuous.0000042\n'
BIN
  chmod 0755 "$fixture/payload/prime-agent"
  printf '{"name":"prime-agent","version":"0.1.2-continuous.0000042"}\n' \
    > "$fixture/payload/package.json"
  printf '# quickstart stub\n' > "$fixture/payload/docs/RUST_QUICKSTART.md"
  printf 'LICENSE stub\n' > "$fixture/payload/LICENSE"
  tarball="prime-agent-0.1.2-$2.tar.gz"
  tar -czf "$fixture/$tarball" -C "$fixture/payload" .
  ( cd "$fixture" && sha256sum "$tarball" > SHA256SUMS )
  printf '{"commit":"0000042000420042000420042000420042000420"}\n' > "$fixture/manifest.json"
}

# --- one sandboxed machine -----------------------------------------------------
new_machine() { # name
  base="$(mktemp -d "${TMPDIR:-/tmp}/installtest-home.XXXXXX")"
  mach="$base/$1"
  mkdir -p "$mach/home" "$mach/tmp" "$mach/mocks" "$mach/npm-global/prime-agent" \
           "$mach/logs"
  echo "$mach"
}

seed_ts_native() { # mach  — the TS product's own install.sh layout
  home="$1/home"
  root="$home/.local/share/prime-agent"
  release="9.9.9-linux-x64-0000000000000000000000000000000000000000000000000000000000000000"
  mkdir -p "$root/releases/$release" "$root/bin" "$home/.local/bin"
  printf 'prime-agent-native-v1\n' > "$root/.managed"
  printf '#!/bin/sh\necho ts-binary\n' > "$root/releases/$release/prime-agent"
  chmod 0755 "$root/releases/$release/prime-agent"
  ln -s "../releases/$release/prime-agent" "$root/bin/prime-agent"
  ln -s "$root/bin/prime-agent" "$home/.local/bin/prime-agent"
  printf '{"name":"prime-agent","version":"9.9.9"}\n' \
    > "$1/npm-global/prime-agent/package.json"
}

seed_store() { # mach  — ~/.prime/agent with one session file
  sessions="$1/home/.prime/agent/sessions"
  mkdir -p "$sessions"
  printf '{"type":"session_info","name":"sandbox session"}\n{"type":"message"}\n' \
    > "$sessions/sess-0001.jsonl"
}

# assert that a user-made lookalike in the rollback namespace survives
seed_old_rust_layout() { # mach  — a pre-takeover install-rust.sh machine
  home="$1/home"
  old="$home/.local/share/prime-agent-rust"
  mkdir -p "$old/prime-agent-runtime" "$home/.local/bin"
  printf '#!/bin/sh\necho old-rust-binary\n' > "$old/prime-agent"
  chmod 0755 "$old/prime-agent"
  printf 'runtime stub\n' > "$old/prime-agent-runtime/pyproject.toml"
  printf 'old tree marker\n' > "$old/old-tree-marker.txt"
  cat > "$home/.local/bin/prime-agent-rust" <<'LAUNCHER'
#!/bin/sh
# prime-agent-rust — launcher written by install-rust.sh.
exec "$(dirname "$0")/../share/prime-agent-rust/prime-agent" "$@"
LAUNCHER
  chmod 0755 "$home/.local/bin/prime-agent-rust"
}

store_snapshot() { # mach -> "file-list-hash:content-hash"
  store="$1/home/.prime/agent"
  listing="$(cd "$store" && find . | LC_ALL=C sort)"
  content="$(cd "$store" && find . -type f | LC_ALL=C sort | xargs sha256sum | sha256sum)"
  echo "${listing}|${content}"
}

start_daemon() { # mach active-session-count  — boots the mock TS daemon on the TS socket
  mach="$1"; count="$2"
  sockdir="$mach/tmp/prime-agent-${REAL_UID}"
  mkdir -p "$sockdir"
  python3 "$mach/ts-daemon-mock.py" \
    "$sockdir/daemon.sock" "$mach/logs/daemon-mock.log" "$mach/logs/daemon-ready" \
    "$count" &
  pid=$!
  MOCK_PIDS="$MOCK_PIDS $pid"
  i=0
  while [ ! -f "$mach/logs/daemon-ready" ] && [ $i -lt 100 ]; do
    i=$((i + 1))
    sleep 0.05
  done
  [ -f "$mach/logs/daemon-ready" ] || fail "mock TS daemon never became ready"
}

run_installer() { # mach extra-args...  -> runs the installer, returns its exit code
  mach="$1"; shift
  HOME="$mach/home" TMPDIR="$mach/tmp" \
  GH_FIXTURE_DIR="$mach/fixture" NPM_MOCK_LOG="$mach/logs/npm-mock.log" \
  NPM_MOCK_ROOT="$mach/npm-global" \
  PATH="$mach/mocks:$(dirname "$(command -v python3)"):/usr/bin:/bin" \
    sh "$INSTALLER" "$@" > "$mach/install.log" 2>&1
}

echo "== fixture =="
FIXTURE_TRIPLE=x86_64-unknown-linux-gnu
[ "$(uname -m)" = "aarch64" ] && FIXTURE_TRIPLE=aarch64-unknown-linux-gnu

# ==============================================================================
echo "== case 1: the full takeover (idle TS daemon, TS native tree, npm TS, old rust layout) =="
mach="$(new_machine main)"
write_daemon_mock "$mach/ts-daemon-mock.py"
write_gh_mock "$mach/mocks/gh"
write_npm_mock "$mach/mocks/npm" "$mach/npm-global" "$mach/logs/npm-mock.log"
build_fixture "$mach" "$FIXTURE_TRIPLE"
seed_ts_native "$mach"
seed_store "$mach"
seed_old_rust_layout "$mach"
start_daemon "$mach" 0
store_before="$(store_snapshot "$mach")"
session_hash_before="$(sha256sum "$mach/home/.prime/agent/sessions/sess-0001.jsonl" | cut -d' ' -f1)"

run_installer "$mach"
rc=$?
assert_eq "case 1 installer exits 0" 0 "$rc"
assert_contains "case 1 install log mentions the clean TS daemon stop" "$mach/install.log" "stopped cleanly (idle; no signal sent)"

# (a) the launcher lands at bin/prime-agent and is ours
assert_eq "case 1 (a) launcher at bin/prime-agent" "yes" \
  "$([ -f "$mach/home/.local/bin/prime-agent" ] && [ ! -L "$mach/home/.local/bin/prime-agent" ] && echo yes || echo no)"
assert_contains "case 1 (a) launcher is this installer's shim" "$mach/home/.local/bin/prime-agent" "launcher written by install-rust.sh"
assert_contains "case 1 (a) launcher execs the new share dir" "$mach/home/.local/bin/prime-agent" "share/prime-agent/prime-agent"

# (b) the shared store is byte-identical
store_after="$(store_snapshot "$mach")"
assert_eq "case 1 (b) ~/.prime/agent untouched (tree+bytes)" "$store_before" "$store_after"
session_hash_after="$(sha256sum "$mach/home/.prime/agent/sessions/sess-0001.jsonl" | cut -d' ' -f1)"
assert_eq "case 1 (b) session file byte-identical" "$session_hash_before" "$session_hash_after"

# (c) the TS daemon was stopped cleanly, via the schema-id stop-when-idle path
assert_contains "case 1 (c) idle probe sent a list request" "$mach/logs/daemon-mock.log" '"type":"list"'
assert_contains "case 1 (c) clean shutdown requested (force:false)" "$mach/logs/daemon-mock.log" '"type":"shutdown","force":false'
assert_contains "case 1 (c) mock daemon shut itself down" "$mach/logs/daemon-mock.log" "SHUTDOWN"
assert_contains "case 1 (c) mock daemon exited on its own (never killed)" "$mach/logs/daemon-mock.log" "EXIT"
assert_not_contains "case 1 (c) no force-kill request" "$mach/logs/daemon-mock.log" '"force":true'

# (d) migration + rollback + legacy preservation
assert_eq "case 1 (d) old share dir migrated away" "gone" \
  "$([ -e "$mach/home/.local/share/prime-agent-rust" ] && echo here || echo gone)"
old_count=0
for d in "$mach"/home/.local/share/prime-agent.old.*; do
  [ -e "$d" ] && old_count=$((old_count + 1))
done
assert_eq "case 1 (d) exactly one .old rollback generation" 1 "$old_count"
for d in "$mach"/home/.local/share/prime-agent.old.*; do
  [ -e "$d/old-tree-marker.txt" ] && ok "case 1 (d) .old rollback holds the old install" \
    || fail "case 1 (d) .old rollback lost the old install tree"
done
assert_eq "case 1 (d) new payload published" "yes" \
  "$([ -x "$mach/home/.local/share/prime-agent/prime-agent" ] && echo yes || echo no)"
assert_contains "case 1 (d) payload is the fixture binary" "$mach/home/.local/share/prime-agent/package.json" "0.1.2-continuous.0000042"
assert_eq "case 1 (d) payload carries the ownership marker" "yes" \
  "$([ -f "$mach/home/.local/share/prime-agent/.prime-agent-install" ] && echo yes || echo no)"
assert_eq "case 1 (d) TS native tree preserved under legacy name" "yes" \
  "$([ -f "$mach/home/.local/share/prime-agent-legacy/.managed" ] && echo yes || echo no)"
assert_contains "case 1 (d) legacy tree keeps the TS marker" "$mach/home/.local/share/prime-agent-legacy/.managed" "prime-agent-native-v1"
legacy_release=no
for legacy_bin in "$mach"/home/.local/share/prime-agent-legacy/releases/*/prime-agent; do
  [ -x "$legacy_bin" ] && legacy_release=yes
done
assert_eq "case 1 (d) legacy tree keeps the TS release binary" "yes" "$legacy_release"
assert_eq "case 1 (d) old prime-agent-rust launcher retired" "gone" \
  "$([ -e "$mach/home/.local/bin/prime-agent-rust" ] && echo here || echo gone)"

# (e) the TS npm package was uninstalled via npm
assert_contains "case 1 (e) npm uninstall -g prime-agent was called" "$mach/logs/npm-mock.log" "uninstall -g prime-agent"
assert_eq "case 1 (e) npm global package removed" "gone" \
  "$([ -f "$mach/npm-global/prime-agent/package.json" ] && echo here || echo gone)"

# the publication lock is cleaned up
assert_eq "case 1 lock released" "gone" \
  "$([ -e "$mach/home/.local/share/.prime-agent-install.lock" ] && echo here || echo gone)"
assert_contains "case 1 install log names the source commit" "$mach/install.log" "0000042"

# A user-made lookalike in the rollback namespace must SURVIVE the sweep
# (only marker-carrying generations are swept).
mkdir -p "$mach/home/.local/share/prime-agent.old.backup"
printf 'user backup, hands off\n' > "$mach/home/.local/share/prime-agent.old.backup/keep-me.txt"

# (g) idempotent re-run via --update
store_before2="$(store_snapshot "$mach")"
run_installer "$mach" --update
rc2=$?
assert_eq "case 1 (g) --update re-run exits 0" 0 "$rc2"
store_after2="$(store_snapshot "$mach")"
assert_eq "case 1 (g) ~/.prime/agent still untouched" "$store_before2" "$store_after2"
# After the --update re-run: the marker-stamped payload generation from
# run 1 was swept by run 2; the UNSTAMPED migrated old-layout slot and the
# user-made .old.backup lookalike are both preserved (never auto-deleted).
old_count2=0
for d in "$mach"/home/.local/share/prime-agent.old.*; do
  case "$d" in *.backup) continue ;; esac
  [ -e "$d" ] && old_count2=$((old_count2 + 1))
done
assert_eq "case 1 (g) two real .old slots remain (migrated + fresh generation)" 2 "$old_count2"
migrated_kept=0
for d in "$mach"/home/.local/share/prime-agent.old.*; do
  [ -e "$d/old-tree-marker.txt" ] && migrated_kept=$((migrated_kept + 1))
done
assert_eq "case 1 (g) the migrated old-layout slot is preserved, never swept" 1 "$migrated_kept"
fresh_stamped=0
for d in "$mach"/home/.local/share/prime-agent.old.*; do
  case "$d" in *.backup) continue ;; esac
  [ -f "$d/.prime-agent-install" ] && [ -x "$d/prime-agent" ] && fresh_stamped=$((fresh_stamped + 1))
done
assert_eq "case 1 (g) the fresh payload slot is the one stamped generation" 1 "$fresh_stamped"
assert_eq "case 1 (g) launcher still ours after --update" "yes" \
  "$([ -f "$mach/home/.local/bin/prime-agent" ] && [ ! -L "$mach/home/.local/bin/prime-agent" ] && echo yes || echo no)"
uninstalls=$(grep -c "uninstall -g prime-agent" "$mach/logs/npm-mock.log" || true)
assert_eq "case 1 (g) exactly one npm uninstall across both runs" 1 "$uninstalls"
assert_eq "case 1 (g) the user-made .old.backup survived the sweep" "yes" \
  "$([ -f "$mach/home/.local/share/prime-agent.old.backup/keep-me.txt" ] && echo yes || echo no)"


# ==============================================================================
echo "== case 2: a BUSY TS daemon is left running (stop-when-idle, never a kill) =="
mach2="$(new_machine busy)"
write_daemon_mock "$mach2/ts-daemon-mock.py"
write_gh_mock "$mach2/mocks/gh"
write_npm_mock "$mach2/mocks/npm" "$mach2/npm-global" "$mach2/logs/npm-mock.log"
build_fixture "$mach2" "$FIXTURE_TRIPLE"
seed_store "$mach2"
start_daemon "$mach2" 1
store_before_b="$(store_snapshot "$mach2")"
run_installer "$mach2"
rcb=$?
assert_eq "case 2 installer still exits 0" 0 "$rcb"
assert_contains "case 2 installer reports the busy daemon was left running" "$mach2/install.log" "left running (never killed)"
assert_not_contains "case 2 no shutdown request to the busy daemon" "$mach2/logs/daemon-mock.log" '"type":"shutdown"'
assert_not_contains "case 2 busy mock daemon was not stopped" "$mach2/logs/daemon-mock.log" "SHUTDOWN"
assert_eq "case 2 launcher installed anyway" "yes" \
  "$([ -f "$mach2/home/.local/bin/prime-agent" ] && echo yes || echo no)"
assert_eq "case 2 ~/.prime/agent untouched" "$store_before_b" "$(store_snapshot "$mach2")"

# ==============================================================================
echo "== case 3: the guard refuses PRIME_AGENT_RUST_PREFIX inside the shared store =="
mach3="$(new_machine guard)"
write_daemon_mock "$mach3/ts-daemon-mock.py"
write_gh_mock "$mach3/mocks/gh"
write_npm_mock "$mach3/mocks/npm"
build_fixture "$mach3" "$FIXTURE_TRIPLE"
seed_store "$mach3"
HOME="$mach3/home" TMPDIR="$mach3/tmp" GH_FIXTURE_DIR="$mach3/fixture" \
PRIME_AGENT_RUST_PREFIX="$mach3/home/.prime/agent" \
PATH="$mach3/mocks:$(dirname "$(command -v python3)"):/usr/bin:/bin" \
  sh "$INSTALLER" > "$mach3/install.log" 2>&1
rcg=$?
# Same store reached through a SYMLINKED spelling: the resolved guard must
# abort before mkdir -p creates anything under the store.
ln -s "$mach3/home/.prime/agent" "$mach3/home/linked-store"
HOME="$mach3/home" TMPDIR="$mach3/tmp" GH_FIXTURE_DIR="$mach3/fixture" \
PRIME_AGENT_RUST_PREFIX="$mach3/home/linked-store" \
PATH="$mach3/mocks:$(dirname "$(command -v python3)"):/usr/bin:/bin" \
  sh "$INSTALLER" > "$mach3/install-linked.log" 2>&1
rcl=$?
assert_eq "case 3 symlinked-store spelling aborts" 1 "$rcl"
assert_contains "case 3 symlinked refusal names the shared store" "$mach3/install-linked.log" "refusing to touch"
assert_eq "case 3 installer aborts" 1 "$rcg"
assert_contains "case 3 refusal names the shared store" "$mach3/install.log" "refusing to touch"
assert_contains "case 3 refusal explains the invariant" "$mach3/install.log" "must never be created, migrated, or deleted"
assert_eq "case 3 nothing was written under the store" "yes" \
  "$([ ! -e "$mach3/home/.prime/agent/share" ] && [ ! -e "$mach3/home/.prime/agent/bin" ] && echo yes || echo no)"
assert_eq "case 3 session file intact" "$(sha256sum "$mach3/home/.prime/agent/sessions/sess-0001.jsonl" | cut -d' ' -f1)" \
  "$(sha256sum "$mach3/home/.prime/agent/sessions/sess-0001.jsonl" | cut -d' ' -f1)"

# ==============================================================================
echo "== case 4: an unowned share dir is refused (never adopted, never swept) =="
mach4="$(new_machine unowned)"
write_daemon_mock "$mach4/ts-daemon-mock.py"
write_gh_mock "$mach4/mocks/gh"
write_npm_mock "$mach4/mocks/npm"
build_fixture "$mach4" "$FIXTURE_TRIPLE"
seed_store "$mach4"
mkdir -p "$mach4/home/.local/share/prime-agent"
printf 'unowned file
' > "$mach4/home/.local/share/prime-agent/prime-agent"
printf 'unowned other
' > "$mach4/home/.local/share/prime-agent/README.txt"
store_before_u="$(store_snapshot "$mach4")"
run_installer "$mach4"
rcu=$?
assert_eq "case 4 installer aborts on the unowned tree" 1 "$rcu"
assert_contains "case 4 refusal names the marker contract" "$mach4/install.log" "neither this"
assert_contains "case 4 refusal tells the user to move it aside" "$mach4/install.log" "move it aside and re-run"
assert_eq "case 4 the unowned tree was NOT moved or deleted" "yes" \
  "$([ -f "$mach4/home/.local/share/prime-agent/README.txt" ] && echo yes || echo no)"
assert_eq "case 4 no .old slot swallowed the tree" "none" \
  "$(for d in "$mach4"/home/.local/share/prime-agent.old.*; do [ -e "$d" ] && echo some; done; echo none | head -1)"
assert_eq "case 4 the store is untouched by the refusal" "$store_before_u" "$(store_snapshot "$mach4")"

# ==============================================================================
echo "== case 5: an unowned regular file at bin/prime-agent is preserved, not destroyed =="
mach5="$(new_machine unowned-bin)"
write_gh_mock "$mach5/mocks/gh"
write_npm_mock "$mach5/mocks/npm"
build_fixture "$mach5" "$FIXTURE_TRIPLE"
seed_store "$mach5"
mkdir -p "$mach5/home/.local/bin"
printf '#!/bin/sh\necho my own tool\n' > "$mach5/home/.local/bin/prime-agent"
chmod 0755 "$mach5/home/.local/bin/prime-agent"
store_before_p="$(store_snapshot "$mach5")"
run_installer "$mach5"
rcp=$?
assert_eq "case 5 installer proceeds (the keyword is ours; the file is kept)" 0 "$rcp"
assert_contains "case 5 the takeover notes the preserved file" "$mach5/install.log" "preserved at"
preserved_count=0
for preserved in "$mach5"/home/.local/bin/prime-agent.pre-takeover.*; do
  [ -f "$preserved" ] && preserved_count=$((preserved_count + 1))
done
assert_eq "case 5 exactly one preserved unowned launcher" 1 "$preserved_count"
preserved_path="$(printf '%s\n' "$mach5"/home/.local/bin/prime-agent.pre-takeover.* | head -n1)"
assert_contains "case 5 the preserved file is the user's own" "$preserved_path" "my own tool"
assert_eq "case 5 our launcher took the keyword" "yes" \
  "$([ -f "$mach5/home/.local/bin/prime-agent" ] && [ ! -L "$mach5/home/.local/bin/prime-agent" ] && echo yes || echo no)"
assert_contains "case 5 our launcher is the installed shim" "$mach5/home/.local/bin/prime-agent" "launcher written by install-rust.sh"
assert_eq "case 5 the store is untouched" "$store_before_p" "$(store_snapshot "$mach5")"
assert_not_contains "case 5 no npm uninstall fired" "$mach5/logs/npm-mock.log" "uninstall -g prime-agent"

# ==============================================================================
echo "== case 6: a post-displacement failure restores the displaced TS tree and its command link =="
mach6="$(new_machine restore)"
write_daemon_mock "$mach6/ts-daemon-mock.py"
write_gh_mock "$mach6/mocks/gh"
write_npm_mock "$mach6/mocks/npm"
build_fixture "$mach6" "$FIXTURE_TRIPLE"
seed_ts_native "$mach6"
seed_store "$mach6"
store_before_r="$(store_snapshot "$mach6")"
# A read-only bin dir kills the launcher write AFTER the publish (mktemp in
# bin fails) while the share tree stays writable — the exact window in which
# the displaced TS tree must go home.
chmod 0555 "$mach6/home/.local/bin"
run_installer "$mach6"
rcr=$?
chmod 0755 "$mach6/home/.local/bin"
assert_eq "case 6 the failed install exits nonzero" 0 "$([ "$rcr" -ne 0 ] && echo 0 || echo 1)"
assert_contains "case 6 the exit notes the TS restore" "$mach6/install.log" "restored to"
assert_eq "case 6 the TS tree is back at the share path" "yes" \
  "$([ -f "$mach6/home/.local/share/prime-agent/.managed" ] && echo yes || echo no)"
assert_eq "case 6 the TS command link resolves again" "yes" \
  "$([ -e "$mach6/home/.local/bin/prime-agent" ] && echo yes || echo no)"
assert_eq "case 6 no half-installed payload remains" "gone" \
  "$([ -e "$mach6/home/.local/share/prime-agent/package.json" ] && echo here || echo gone)"
assert_eq "case 6 no legacy slot remains" "gone" \
  "$([ -e "$mach6/home/.local/share/prime-agent-legacy" ] && echo here || echo gone)"
assert_eq "case 6 the store is untouched" "$store_before_r" "$(store_snapshot "$mach6")"

# ==============================================================================
echo "== case 7: a pre-launcher failure never displaces the user's unowned command =="
mach7="$(new_machine no-displace)"
write_gh_mock "$mach7/mocks/gh"
write_npm_mock "$mach7/mocks/npm"
build_fixture "$mach7" "$FIXTURE_TRIPLE"
seed_store "$mach7"
mkdir -p "$mach7/home/.local/bin"
printf '#!/bin/sh\necho my own tool\n' > "$mach7/home/.local/bin/prime-agent"
chmod 0755 "$mach7/home/.local/bin/prime-agent"
# A read-only share dir kills the install at the staging step — long before
# the launcher section: the user's command file must not even be displaced.
mkdir -p "$mach7/home/.local/share"
chmod 0555 "$mach7/home/.local/share"
run_installer "$mach7"
rcs=$?
chmod 0755 "$mach7/home/.local/share"
assert_eq "case 7 the early failure exits nonzero" 0 "$([ "$rcs" -ne 0 ] && echo 0 || echo 1)"
assert_contains "case 7 the user's command file is untouched" "$mach7/home/.local/bin/prime-agent" "my own tool"
assert_eq "case 7 no pre-takeover aside file exists" "gone" \
  "$(for f in "$mach7"/home/.local/bin/prime-agent.pre-takeover.*; do [ -e "$f" ] && echo here; done; echo gone | head -1)"
assert_eq "case 7 our launcher never landed" "gone" \
  "$([ -f "$mach7/home/.local/share/prime-agent/.prime-agent-install" ] && echo here || echo gone)"

# ==============================================================================
echo "== case 8: a FIFO at bin/prime-agent is never opened - preserved aside =="
mach8="$(new_machine fifo)"
write_gh_mock "$mach8/mocks/gh"
write_npm_mock "$mach8/mocks/npm"
build_fixture "$mach8" "$FIXTURE_TRIPLE"
seed_store "$mach8"
mkdir -p "$mach8/home/.local/bin"
mkfifo "$mach8/home/.local/bin/prime-agent"
store_before_f="$(store_snapshot "$mach8")"
run_installer "$mach8"
rcf=$?
assert_eq "case 8 the installer did not hang on the FIFO and completed" 0 "$rcf"
assert_eq "case 8 our launcher took the keyword" "yes" \
  "$([ -f "$mach8/home/.local/bin/prime-agent" ] && [ ! -L "$mach8/home/.local/bin/prime-agent" ] && echo yes || echo no)"
fifo_preserved=0
for preserved in "$mach8"/home/.local/bin/prime-agent.pre-takeover.*; do
  [ -p "$preserved" ] && fifo_preserved=$((fifo_preserved + 1))
done
assert_eq "case 8 the FIFO was preserved as a FIFO, not read" 1 "$fifo_preserved"
assert_eq "case 8 the store is untouched" "$store_before_f" "$(store_snapshot "$mach8")"

# ==============================================================================
echo "== case 9: slot collisions take the next free suffix; unowned leftovers stay ==="
mach9="$(new_machine collisions)"
write_gh_mock "$mach9/mocks/gh"
write_npm_mock "$mach9/mocks/npm"
build_fixture "$mach9" "$FIXTURE_TRIPLE"
seed_ts_native "$mach9"
seed_store "$mach9"
# Occupy both legacy slot names: the TS tree must go to the next free suffix.
mkdir -p "$mach9/home/.local/share/prime-agent-legacy"
mkdir -p "$mach9/home/.local/share/prime-agent-legacy.$$"
store_before_c="$(store_snapshot "$mach9")"
run_installer "$mach9"
rcc=$?
assert_eq "case 9 the installer completed despite occupied legacy slots" 0 "$rcc"
legacy_slots=0
for d in "$mach9"/home/.local/share/prime-agent-legacy*; do
  [ -e "$d/.managed" ] && legacy_slots=$((legacy_slots + 1))
done
assert_eq "case 9 the TS tree landed in a fresh legacy slot" 1 "$legacy_slots"
# The two pre-occupied names are untouched (still empty dirs): the TS tree
# went to a fresh suffix, nothing was overwritten or nested into them.
assert_eq "case 9 no occupied slot was overwritten or nested" "yes" \
  "$([ -d "$mach9/home/.local/share/prime-agent-legacy" ] \
      && [ -d "$mach9/home/.local/share/prime-agent-legacy.$$" ] \
      && [ -z "$(ls -A "$mach9/home/.local/share/prime-agent-legacy.$$")" ] \
      && [ -z "$(ls -A "$mach9/home/.local/share/prime-agent-legacy")" ] \
      && echo yes || echo no)"
# An old-layout tree the migration/sweep would refuse (no prime-agent-runtime)
# is left in place, never deleted.
mkdir -p "$mach9/home/.local/share/prime-agent-rust"
printf '#!/bin/sh\necho not-ours\n' > "$mach9/home/.local/share/prime-agent-rust/prime-agent"
chmod 0755 "$mach9/home/.local/share/prime-agent-rust/prime-agent"
printf 'leave me\n' > "$mach9/home/.local/share/prime-agent-rust/keep.txt"
run_installer "$mach9" --update
rcd=$?
assert_eq "case 9 the --update re-run completed with the leftover present" 0 "$rcd"
assert_eq "case 9 the unowned old-layout tree was left in place" "yes" \
  "$([ -f "$mach9/home/.local/share/prime-agent-rust/keep.txt" ] && echo yes || echo no)"
assert_contains "case 9 the install notes the refused leftover" "$mach9/install.log" "left in place"
# Every rollback slot keeps the payload at its ROOT (no mv-nesting).
for d in "$mach9"/home/.local/share/prime-agent.old.*; do
  if [ -d "$d" ] && [ ! -f "$d/prime-agent" ] && [ -d "$d/prime-agent" ]; then
    fail "case 9 a rollback slot nested the tree: $d"
  fi
done
ok "case 9 no rollback slot nested a tree"
assert_eq "case 9 the store is untouched" "$store_before_c" "$(store_snapshot "$mach9")"

echo
echo "passed: $passed  failed: $failures"
[ "$failures" -eq 0 ] || exit 1
exit 0
