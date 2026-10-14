#!/usr/bin/env python3
"""Owned real TS/Rust shutdown fixtures; root scoping is an intentional safety delta."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import threading
import time

from review_agent_bounce_parity import Client, Provider, LIMIT
from review_draft_disconnect_parity import digest, env_for, stop, TS_ARCHIVE_SHA256


def process_identity(pid):
    try:
        fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        return fields[19] if fields[0] != 'Z' else None
    except (FileNotFoundError, ProcessLookupError):
        return None


def owned_identity(pid, root):
    expected = ('PRIME_AGENT_CODING_AGENT_DIR=' + str(root / 'agent')).encode()
    try:
        if expected not in Path(f'/proc/{pid}/environ').read_bytes().split(b'\0'):
            return None
        return process_identity(pid)
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        return None


def owned_processes(root):
    return {int(path.name): identity for path in Path('/proc').iterdir()
            if path.name.isdigit()
            and (identity := owned_identity(int(path.name), root)) is not None}


def survivors(original, root):
    return {pid: identity for pid, identity in original.items()
            if owned_identity(pid, root) == identity}


def wait_stopped(process):
    process.wait(timeout=LIMIT)


def finish_tree(tree, observed):
    process, client, root = tree['process'], tree.get('client'), tree['root']
    error = None
    if process.poll() is None:
        try:
            assert client is not None, 'no owned shutdown client'
            observed['cleanup_shutdown_response'] = client.call('shutdown', force=True)
            wait_stopped(process)
        except Exception as caught:
            error = caught
    stop(process)
    deadline = time.monotonic() + LIMIT
    while owned_processes(root) and time.monotonic() < deadline:
        threading.Event().wait(0.025)
    remaining = owned_processes(root)
    observed['remaining_owned_processes'] = remaining
    if remaining:
        # Fallback touches only this fixture's exact environment and captured
        # start identity; PID reuse or unrelated processes are never targets.
        for sig in (signal.SIGTERM, signal.SIGKILL):
            for pid, identity in remaining.items():
                if owned_identity(pid, root) == identity:
                    try:
                        os.kill(pid, sig)
                    except ProcessLookupError:
                        pass
        error = error or RuntimeError('detached fixture processes survived: ' + str(remaining))
    if client:
        observed['wire'] = client.wire
        client.close()
    tree['log'].close()
    observed['daemon_log'] = (root / 'daemon.log').read_text(errors='replace')[-6000:]
    if error:
        raise RuntimeError('owned cleanup failed: ' + str(error)) from error


def launch(binary, kind, root, socket_path, shared_tmp, provider, trees):
    env = env_for(root, kind)
    env['TMPDIR'] = str(shared_tmp)
    env['PRIME_AGENT_DAEMON_SOCKET'] = str(socket_path)
    env['PRIME_AGENT_INTERNAL_WORKER_SUPERVISOR_LOST_EXIT_MS'] = '15000'
    (root / 'agent/models.json').write_text(json.dumps({'providers': {'parity-local': {
        'api': 'openai-completions', 'apiKey': 'fixture-only',
        'baseUrl': f'http://127.0.0.1:{provider.server_port}/v1',
        'models': [{'id': 'parity-1', 'name': 'Parity 1', 'reasoning': False,
                    'contextWindow': 128000, 'maxTokens': 4096}]}}}))
    (root / 'agent/settings.json').write_text(json.dumps({'prewarmPythonKernel': False,
        'defaultProvider': 'parity-local', 'defaultModel': 'parity-1',
        'onboardingCompleted': True, 'telemetry': {'noticeShown': True}}))
    log = open(root / 'daemon.log', 'wb')
    process = subprocess.Popen([str(binary), '--mode', 'daemon', '--daemon-socket', str(socket_path)],
        cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    tree = {'root': root, 'env': env, 'process': process, 'log': log, 'socket': socket_path}
    trees.append(tree)
    client = tree['client'] = Client(socket_path, process)
    created = client.call('create', config={'cwd': str(root), 'agentDir': str(root / 'agent'),
        'provider': 'parity-local', 'model': 'parity-1', 'noExtensions': True,
        'noSkills': True, 'noTools': True, 'noContextFiles': True, 'telemetryDisabled': True})
    active = created.get('activeSessionId') or created.get('id')
    assert active, created
    marker = 'SHUTDOWN_SCOPE_BUSY_' + root.name
    client.call('prompt', activeSessionId=active, message=marker)
    provider.wait_for(marker)
    original = tree['original_processes'] = owned_processes(root)
    assert process.pid in original and len(original) >= 2, 'live supervisor and worker not observed'
    return tree


def invoke(binary, args, tree):
    result = subprocess.run([str(binary), *args], cwd=tree['root'], env=tree['env'],
                            capture_output=True, text=True, timeout=LIMIT, check=False)
    return {'returncode': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}


def run_case(binary, kind, root, mode, observed):
    shared_tmp = root / 'shared-tmp'
    shared_tmp.mkdir(parents=True)
    default_socket = shared_tmp / f'prime-agent-{os.getuid()}' / 'daemon.sock'
    default_socket.parent.mkdir()
    pins = root / 'pins'
    pins.mkdir()
    provider = Provider()
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    trees = []
    try:
        foreign = launch(binary, kind, root / 'foreign', default_socket, shared_tmp, provider, trees)
        own = launch(binary, kind, root / 'own', pins / 'own.sock', shared_tmp, provider, trees)
        observed['original_processes'] = {name: tree['original_processes']
            for name, tree in [('own', own), ('foreign', foreign)]}
        if mode == 'exact_socket':
            provider.release.set()
            observed['action_response'] = own['client'].call('shutdown', force=True)
            wait_stopped(own['process'])
            kept = survivors(foreign['original_processes'], foreign['root'])
            assert kept == foreign['original_processes'], 'exact socket shutdown harmed foreign tree'
            observed['foreign_original_processes_after'] = kept
        else:
            status = observed['status_cli'] = invoke(binary, ['status', '--json'], own)
            assert status['returncode'] == 0, status
            services = observed['discovered_services'] = json.loads(status['stdout'])
            paths = [service['socketPath'] for service in services]
            if kind == 'rust':
                assert paths == [str(own['socket'])], paths
            else:
                assert str(foreign['socket']) in paths, 'TS shared default tree was not discovered'
            provider.release.set()
            shutdown = observed['shutdown_cli'] = invoke(binary, ['shutdown', '--force', '--json'], own)
            assert shutdown['returncode'] == 0, shutdown
            kept = survivors(foreign['original_processes'], foreign['root'])
            observed['foreign_original_processes_after'] = kept
            observed['own_supervisor_stopped'] = own['process'].poll() is not None
            if kind == 'rust':
                wait_stopped(own['process'])
                observed['own_supervisor_stopped'] = True
                assert kept == foreign['original_processes'], 'pinned root shutdown harmed foreign tree'
            else:
                wait_stopped(foreign['process'])
                deadline = time.monotonic() + LIMIT
                while survivors(foreign['original_processes'], foreign['root']) and time.monotonic() < deadline:
                    threading.Event().wait(0.025)
                assert not survivors(foreign['original_processes'], foreign['root']), 'TS global root did not stop default tree'
        observed['provider_requests'] = provider.requests
    finally:
        provider.release.set()
        errors = []
        for index, tree in enumerate(trees):
            cleanup = observed.setdefault('cleanup', {})[str(index)] = {}
            try:
                finish_tree(tree, cleanup)
            except Exception as error:
                errors.append(str(error))
        provider.shutdown()
        provider.server_close()
        if errors:
            observed['cleanup_errors'] = errors
            raise RuntimeError('; '.join(errors))
    observed['verified'] = True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--receipt', required=True, type=Path)
    args = parser.parse_args()
    receipt = {'scenario': 'shutdown_scope', 'verified': False, 'cases': {},
        'scope': 'real supervisor and busy worker identities, exact-socket shutdown baseline, pinned-root status and shutdown',
        'intentional_difference': 'TS 0.9.8 discovers/stops the shared default tree; Rust pinned root discovers/stops only its own supervisor tree',
        'not_covered': 'doctor output, inherited worker environment routing, overlapping agent-dir regression (separate Rust hosted red/green test)'}
    try:
        archive = Path(os.environ['PA_TS_ARCHIVE'])
        assert digest(archive) == TS_ARCHIVE_SHA256, 'TS archive digest mismatch'
        receipt['ts_archive_sha256'] = digest(archive)
        with tempfile.TemporaryDirectory(prefix='pa-shutdown-scope-', dir='/tmp') as folder:
            for kind in ('ts', 'rust'):
                binary = Path(os.environ['PA_' + kind.upper() + '_BINARY']).resolve()
                receipt[kind + '_binary_sha256'] = digest(binary)
                for mode in ('exact_socket', 'pinned_root'):
                    observed = receipt['cases'][kind + '_' + mode] = {}
                    run_case(binary, kind, Path(folder) / (kind + '_' + mode), mode, observed)
        assert receipt['cases']['ts_exact_socket']['action_response'] == receipt['cases']['rust_exact_socket']['action_response'], 'exact-socket shutdown response data differs'
        receipt['verified'] = True
    except Exception as error:
        receipt['error'] = str(error)
        raise
    finally:
        args.receipt.parent.mkdir(parents=True, exist_ok=True)
        args.receipt.write_text(json.dumps(receipt, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
