// The Python "kernel forkserver": a long-lived template process that pays the
// ~1.2s IPython/ipykernel/rlm import cost once, then forks a ready-to-run kernel
// per request in ~ms. Children inherit the imported module objects via
// copy-on-write, bypassing the (slow, virtiofs-backed) per-file import path.
//
// Embedded as a string rather than shipped as a package asset so it can never be
// missing from a release layout (see the built-in-skills packaging gap). Run via
// `python -c <this> <control-socket-path> [<history-bound>]`.
//
// Protocol (newline-delimited JSON over the unix socket, forkserver is the client):
//   -> { "id": <n>, "connectionPath": "<abs path>" }   spawn request from Node
//   -> { "id": <n>, "kill": <fork-id>, "signal": "TERM"|"KILL" }  kill a forked child
//   -> { "id": <n>, "alive": <fork-id> }               liveness query for a child
//   <- { "type": "ready" }                             once, after imports finish
//   <- { "id": <n>, "pid": <pid> }                     fork succeeded
//   <- { "id": <n>, "error": "<message>" }             fork failed
//   <- { "id": <n>, "outcome": "signaled"|"already-exited"|"unknown-pid" }  kill reply
//   <- { "id": <n>, "alive": true|false }              alive reply
//
// Kill/alive are keyed by the never-reused fork request id, so a handle can only
// name the one child incarnation it forked (a recycled pid can't alias), and the
// forkserver signals only its own un-reaped children — POSIX-race-free.
export const FORK_SERVER_SCRIPT = String.raw`
import gc
import json
import os
import signal
import socket
import sys
import threading
import time

# fork id -> [pid, alive]; _pid_to_id holds un-reaped, un-evicted children only.
# Only the main thread mutates these (the SIGCHLD handler runs between its bytecodes).
_children = {}
_pid_to_id = {}
# FIFO history bound; kill/alive for an evicted id fail closed.
_history_bound = 4096


def _reap_children(*_args):
    # Reap every exited child so disposed kernels never linger as zombies. Wired to
    # SIGCHLD so reaping happens on child exit, not only when the next request wakes
    # the accept loop. Safe under PEP 475: the interrupted socket read auto-retries.
    try:
        while True:
            pid, _status = os.waitpid(-1, os.WNOHANG)
            if pid == 0:
                break
            child_id = _pid_to_id.pop(pid, None)
            if child_id is not None:
                _children[child_id][1] = False
    except ChildProcessError:
        pass


def _watch_parent(original_ppid):
    # A SIGKILLed owner can't close our socket while a forked child still holds the
    # fd; poll ppid so the forkserver dies with its owner regardless.
    while True:
        if os.getppid() != original_ppid:
            os._exit(1)
        time.sleep(1.0)


def _import_template():
    # Everything a kernel touches at import time. Paid once; shared COW by children.
    import IPython  # noqa: F401
    import ipykernel  # noqa: F401
    import ipykernel.kernelapp  # noqa: F401
    import jupyter_client  # noqa: F401
    import nest_asyncio  # noqa: F401
    try:
        import rlm  # noqa: F401
    except Exception:
        # rlm may not import cleanly outside a live kernel namespace; the Node-side
        # bootstrap cell wires it up per-child regardless. Preloading is a best-effort
        # speedup, not a correctness requirement.
        pass


def _run_child(connection_path, cwd, env):
    # We are the forked child; become the ipykernel server on the given connection.
    from ipykernel.kernelapp import IPKernelApp

    # Drop the inherited SIGCHLD reaper so it can't interfere with ipykernel's own
    # child/signal handling.
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)

    # cwd/env are per-kernel and applied here (not at template import), so all
    # kernels can share one warm template regardless of their working dir / env.
    if env:
        os.environ.update(env)
    if cwd:
        # Don't swallow a bad cwd: direct spawn fails fast on ENOENT, so match that
        # (the OSError propagates, the child exits non-zero, Node falls back).
        os.chdir(cwd)

    # Drop any singleton the template happened to build so the child owns a fresh
    # instance (and, critically, a jupyter_client Session created in *this* pid;
    # a Session inherited from the template silently drops messages via check_pid).
    IPKernelApp.clear_instance()
    # Watch our real parent (the forkserver): ipykernel distrusts a handle that
    # differs from getppid(), and its pid-1 fallback breaks under subreapers.
    app = IPKernelApp.instance(
        connection_file=connection_path,
        parent_handle=os.getppid(),
    )
    # initialize() binds the 5 ZMQ ports, writes the resolved ports back into
    # connection.json, and starts the heartbeat thread + ioloop — all post-fork,
    # so no thread/loop/socket is ever inherited across the fork boundary.
    app.initialize([])
    app.start()


def _serve(control_path):
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(control_path)
    control_fd = sock.fileno()

    # Block SIGCHLD before spawning the watcher so it inherits the blocked mask;
    # otherwise the kernel could deliver SIGCHLD there while the main thread is masked.
    signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGCHLD})

    # Compare against the original ppid (not ==1) so this holds under subreapers.
    # Threads aren't inherited across fork, so children never carry this watcher.
    threading.Thread(target=_watch_parent, args=(os.getppid(),), daemon=True).start()

    # Reap forked kernels as they exit, independent of the request loop.
    signal.signal(signal.SIGCHLD, _reap_children)
    # Unblock after handler install; the main thread's mask is now authoritative.
    signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGCHLD})

    _import_template()
    # Freeze the heap so the cyclic GC doesn't write to (and thus COW-copy) the
    # shared module pages, keeping memory genuinely shared across children.
    gc.freeze()

    f = sock.makefile("rwb", buffering=0)
    f.write(json.dumps({"type": "ready"}).encode() + b"\n")
    f.flush()

    while True:
        # Belt-and-suspenders: the SIGCHLD handler is the primary reaper, but sweep
        # again each turn in case a signal was missed (coalesced) while handling one.
        _reap_children()

        line = f.readline()
        if not line:
            break
        try:
            req = json.loads(line)
        except ValueError:
            continue
        req_id = req.get("id")

        kill_id = req.get("kill")
        if kill_id is not None:
            # Blocked across check+kill: an alive entry then means an un-reaped
            # own child (zombie-pinned pid), so os.kill is race-free.
            signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGCHLD})
            try:
                entry = _children.get(kill_id)
                if entry is None:
                        outcome = "unknown-pid"
                elif not entry[1]:
                    outcome = "already-exited"
                else:
                    sig = signal.SIGKILL if req.get("signal") == "KILL" else signal.SIGTERM
                    try:
                        os.kill(entry[0], sig)
                        outcome = "signaled"
                    except ProcessLookupError:
                        outcome = "already-exited"
            finally:
                signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGCHLD})
            f.write(json.dumps({"id": req_id, "outcome": outcome}).encode() + b"\n")
            f.flush()
            continue

        alive_id = req.get("alive")
        if alive_id is not None:
            entry = _children.get(alive_id)
            f.write(json.dumps({"id": req_id, "alive": bool(entry and entry[1])}).encode() + b"\n")
            f.flush()
            continue

        connection_path = req.get("connectionPath")
        cwd = req.get("cwd")
        env = req.get("env")

        # Blocked across fork+bookkeeping: a fast-exiting child could otherwise
        # be reaped before its registry entry exists, recording a stale pid as alive.
        signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGCHLD})
        try:
            pid = os.fork()
        except OSError as exc:
            signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGCHLD})
            f.write(json.dumps({"id": req_id, "error": str(exc)}).encode() + b"\n")
            f.flush()
            continue

        if pid == 0:
            # The child inherits the blocked mask; the kernel needs SIGCHLD.
            signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGCHLD})
            # Shed every inherited fd tied to the control channel, then run.
            try:
                sock.close()
                f.close()
            except Exception:
                pass
            try:
                os.close(control_fd)
            except OSError:
                pass
            try:
                _run_child(connection_path, cwd, env)
            except BaseException as exc:  # never return to the accept loop
                sys.stderr.write("forked kernel failed: %r\n" % (exc,))
                os._exit(1)
            os._exit(0)

        # Parent: stay pristine (no loop/threads/ZMQ ever) so the next fork is clean.
        _children[req_id] = [pid, True]
        _pid_to_id[pid] = req_id
        # FIFO-evict only exited entries: dropping a live child would make its
        # liveness read false and its kill unroutable — the exact leak this
        # forkserver exists to prevent. Live entries are bounded by real kernels.
        if len(_children) > _history_bound:
            for evicted_id in [i for i, e in _children.items() if not e[1]]:
                if len(_children) <= _history_bound:
                    break
                _children.pop(evicted_id)
        signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGCHLD})
        f.write(json.dumps({"id": req_id, "pid": pid}).encode() + b"\n")
        f.flush()


if __name__ == "__main__":
    if len(sys.argv) > 2:
        _history_bound = int(sys.argv[2])
    _serve(sys.argv[1])
`;
