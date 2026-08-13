// The Python "kernel forkserver": a long-lived template process that pays the
// ~1.2s IPython/ipykernel/rlm import cost once, then forks a ready-to-run kernel
// per request in ~ms. Children inherit the imported module objects via
// copy-on-write, bypassing the (slow, virtiofs-backed) per-file import path.
//
// Embedded as a string rather than shipped as a package asset so it can never be
// missing from a release layout (see the built-in-skills packaging gap). Run via
// `python -c <this> <control-socket-path>`.
//
// Protocol (newline-delimited JSON over the unix socket, forkserver is the client):
//   -> { "id": <n>, "connectionPath": "<abs path>" }   spawn request from Node
//   <- { "type": "ready" }                             once, after imports finish
//   <- { "id": <n>, "pid": <pid> }                     fork succeeded
//   <- { "id": <n>, "error": "<message>" }             fork failed
export const FORK_SERVER_SCRIPT = String.raw`
import atexit
import gc
import json
import os
import signal
import socket
import sys


# PIDs of kernels this forkserver has forked and not yet reaped. The forkserver kills
# them on its own teardown (see _kill_forked): a forked kernel runs IPKernelApp, which
# does not reliably tie its own lifetime to a parent, so the forkserver must reap them.
_forked_pids = set()


def _reap_children(*_args):
    # Reap every exited child so disposed kernels never linger as zombies. Wired to
    # SIGCHLD so reaping happens on child exit, not only when the next request wakes
    # the accept loop. Safe under PEP 475: the interrupted socket read auto-retries.
    try:
        while True:
            pid, _status = os.waitpid(-1, os.WNOHANG)
            if pid == 0:
                break
            _forked_pids.discard(pid)
    except ChildProcessError:
        pass


def _kill_forked(*_args):
    # SIGKILL every kernel we forked and have not reaped. Runs when the forkserver is
    # torn down, so no kernel is left to reparent to init/systemd and leak its memory:
    #   - Node dies (SIGKILL/crash/terminal close): the control socket EOFs, the accept
    #     loop returns, and this runs via atexit.
    #   - Node's dispose() sends SIGTERM: this runs via the _terminate handler below.
    for pid in list(_forked_pids):
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass


def _terminate(*_args):
    _kill_forked()
    os._exit(0)


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

    # Shed the forkserver's signal handling and child-tracking state we inherited: this
    # process is becoming a kernel, not a forkserver, and ipykernel installs its own
    # handlers from here.
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
    signal.signal(signal.SIGINT, signal.SIG_DFL)
    signal.signal(signal.SIGHUP, signal.SIG_DFL)
    _forked_pids.clear()

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
    app = IPKernelApp.instance(connection_file=connection_path)
    # Backstop for the rare case where the forkserver itself is SIGKILLed (so it cannot
    # run _kill_forked): ipykernel's ParentPollerUnix makes the kernel exit when its
    # parent goes away. getppid() is the forkserver and is never 1 here, which the
    # poller requires. The forkserver's own reaping remains the primary, race-free path.
    app.parent_handle = os.getppid()
    # initialize() binds the 5 ZMQ ports, writes the resolved ports back into
    # connection.json, and starts the heartbeat thread + ioloop — all post-fork,
    # so no thread/loop/socket is ever inherited across the fork boundary.
    app.initialize([])
    app.start()


def _serve(control_path):
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(control_path)
    control_fd = sock.fileno()

    # Reap forked kernels as they exit, independent of the request loop.
    signal.signal(signal.SIGCHLD, _reap_children)
    # Kill any kernels we forked before this forkserver exits, so they cannot outlive
    # their session as orphans: _terminate covers Node's dispose() SIGTERM (a signal
    # bypasses atexit), atexit covers the accept loop returning on control-socket EOF
    # when Node dies uncleanly.
    signal.signal(signal.SIGTERM, _terminate)
    signal.signal(signal.SIGINT, _terminate)
    signal.signal(signal.SIGHUP, _terminate)
    atexit.register(_kill_forked)

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
        connection_path = req.get("connectionPath")
        cwd = req.get("cwd")
        env = req.get("env")

        try:
            pid = os.fork()
        except OSError as exc:
            f.write(json.dumps({"id": req_id, "error": str(exc)}).encode() + b"\n")
            f.flush()
            continue

        if pid == 0:
            # Child: shed every inherited fd tied to the control channel, then run.
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
        _forked_pids.add(pid)
        f.write(json.dumps({"id": req_id, "pid": pid}).encode() + b"\n")
        f.flush()


if __name__ == "__main__":
    _serve(sys.argv[1])
`;
