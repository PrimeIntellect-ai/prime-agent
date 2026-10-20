#!/usr/bin/env python3
"""Real daemon check of preserved legacy sockets and the byte-length fallback.

A Darwin uname shim exercises the actual published launcher on Linux with the
exact CI-built payload. The daemon runs only in fixture-owned homes and socket
paths. No installer downloads occur.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time

from lifecycle_lib import digest, env_for, stop


def launch_daemon(command, expected, root, env):
    log_path = root / 'daemon.log'
    with log_path.open('wb') as log:
        process = subprocess.Popen(command + ['--mode', 'daemon'], cwd=root, env=env,
                                   stdout=log, stderr=log, start_new_session=True)
        try:
            deadline = time.monotonic() + 35
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError('daemon exited before bind: ' + log_path.read_text(errors='replace'))
                try:
                    with socket.socket(socket.AF_UNIX) as sock:
                        sock.settimeout(2)
                        sock.connect(str(expected))
                        with sock.makefile('rb') as stream:
                            hello = json.loads(stream.readline())
                    assert hello.get('type') == 'daemon_hello' and hello.get('schemaId'), hello
                    return {'bound_socket': str(expected), 'hello': hello,
                            'log': log_path.read_text(errors='replace')}
                except (FileNotFoundError, ConnectionRefusedError, socket.timeout):
                    threading.Event().wait(0.05)
            raise TimeoutError('daemon did not bind expected launcher socket: ' + str(expected))
        finally:
            stop(process)


def install_launcher(binary, root, env):
    prefix = root / 'prefix'
    payload = prefix / 'share/prime-agent'
    payload.mkdir(parents=True)
    (payload / 'prime-agent').symlink_to(binary)
    installer = Path(__file__).resolve().parents[1].joinpath('install-rust.sh').read_text()
    marker = '# --- the launcher (the takeover lives here)'
    section = marker + installer.split(marker, 1)[1]
    section = section.split('# The cmd/PowerShell launcher twin', 1)[0]
    script = '''PREFIX="$PRIME_AGENT_RUST_PREFIX"
bin_dir="$PREFIX/bin"
mkdir -p "$bin_dir"
launcher="$bin_dir/prime-agent"
WINDOWS=no
say() { :; }; note() { :; }; die() { echo "$*" >&2; exit 1; }
trap '[ -z "${launcher_tmp:-}" ] || rm -f "$launcher_tmp"' EXIT
''' + section
    installed = subprocess.run(['sh', '-eu'], input=script,
                               env={**env, 'PRIME_AGENT_RUST_PREFIX': str(prefix)},
                               cwd=root, text=True, capture_output=True, timeout=15)
    if installed.returncode:
        raise RuntimeError('launcher extraction failed: ' + installed.stderr)
    return prefix / 'bin/prime-agent'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    receipt = {'passed': False, 'scenario': 'socket_pin', 'runs': {},
               'scope': 'Actual installed launcher: legacy namespace with the npm-bridge marker, explicit override, UTF-8 byte fallback under Darwin uname shim, and the installer stop probe.'}
    fallback_dir = None
    try:
        binary = Path(os.environ['PA_RUST_BINARY']).resolve()
        receipt['binary_sha256'] = digest(binary)
        with tempfile.TemporaryDirectory(prefix='pa-pin-', dir='/tmp') as temp:
            owned = Path(temp) / 'rust'
            owned.mkdir()
            env = env_for(owned)
            tmp = owned / 'tmp'
            legacy = tmp / f'prime-agent-{os.getuid()}/daemon.sock'
            command = install_launcher(binary, owned, env)
            marker = owned / 'prefix/share/.prime-agent-npm-bridge/legacy-daemon-socket'
            marker.parent.mkdir()
            marker.write_text('fixture\n')
            receipt['runs']['legacy'] = launch_daemon([str(command)], legacy, owned, env)
            explicit = tmp / 'explicit.sock'
            receipt['runs']['override'] = launch_daemon([str(command), '--daemon-socket', str(explicit)], explicit, owned,
                {**env, 'PRIME_AGENT_DAEMON_SOCKET': str(explicit)})
            marker.unlink()
            shim = owned / 'shim'
            shim.mkdir()
            fixture_uid = str(500000000 + os.getpid())
            for name, text in (('uname', 'Darwin'), ('id', fixture_uid)):
                path = shim / name
                path.write_text(f'#!/bin/sh\nprintf "%s\\n" "{text}"\n')
                path.chmod(0o755)
            long_tmp = str(owned / ('é' * 25))
            long_pin = f'{long_tmp}/prime-agent-rust-{fixture_uid}/daemon.sock'
            assert len(long_pin) <= 103 and len(long_pin.encode()) > 103, long_pin
            candidate = Path(f'/tmp/prime-agent-rust-{fixture_uid}')
            # Atomic reservation: a collision never authorizes cleanup.
            candidate.mkdir(mode=0o700, exist_ok=False)
            fallback_dir = candidate
            fallback = fallback_dir / 'daemon.sock'
            long_env = {**env, 'TMPDIR': long_tmp,
                        'PATH': str(shim) + os.pathsep + env['PATH'], 'OS': 'Darwin',
                        'LC_ALL': 'C.UTF-8'}
            receipt['runs']['utf8_fallback'] = launch_daemon([str(command)], fallback, owned, long_env)
            source = Path(__file__).resolve().parents[1].joinpath('install-rust.sh').read_text()
            probe = 'rust_socket="${TMPDIR:-/tmp}' + source.split('rust_socket="${TMPDIR:-/tmp}', 1)[1].split('env_socket=', 1)[0]
            observed = subprocess.run(['sh', '-eu'], input=probe + '\nprintf "%s" "$rust_socket"',
                env=long_env, text=True, capture_output=True, timeout=10, check=True).stdout
            assert observed == str(fallback), (observed, fallback)
            receipt['stop_probe'] = observed
            receipt['utf8_pin'] = {'characters': len(long_pin), 'bytes': len(long_pin.encode()),
                                  'original_pin': long_pin}
            receipt['passed'] = True
    except Exception as error:
        receipt['error'] = f'{type(error).__name__}: {error}'
    finally:
        if fallback_dir is not None and fallback_dir.exists():
            shutil.rmtree(fallback_dir)
        args.receipt.parent.mkdir(parents=True, exist_ok=True)
        args.receipt.write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'passed': receipt['passed'], 'error': receipt.get('error')}))
    return 0 if receipt['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
