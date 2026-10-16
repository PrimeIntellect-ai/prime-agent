"""Untimed offline environment preparation; run only inside workload confinement."""
from __future__ import annotations
import errno
import json
from pathlib import Path
import socket
import subprocess
import sys
import time
from provenance import file_sha256

SKILLS = ('agent-message', 'agent-observe', 'attach-image', 'compact', 'edit',
          'goal', 'refine', 'rlm-heartbeat', 'websearch')
MODULES = ('rlm', 'agent_message', 'agent_observe', 'attach_image', 'compact', 'edit',
           'goal', 'refine', 'rlm_heartbeat', 'websearch')


def wait_listener(path: str, process, seconds: float = 30) -> None:
    deadline = time.perf_counter() + seconds
    while time.perf_counter() < deadline:
        if process.poll() is not None:
            raise RuntimeError('benchmark daemon exited before listening')
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(.1)
            try:
                connection.connect(path)
                return
            except OSError as error:
                if error.errno not in (errno.ENOENT, errno.ECONNREFUSED):
                    raise
        time.sleep(.005)
    raise TimeoutError('benchmark daemon did not listen')


def install(payload: Path, environment: Path, log: Path) -> Path:
    subprocess.run([sys.executable, '-m', 'venv', str(environment)], check=True, timeout=30)
    site = environment / f'lib/python{sys.version_info.major}.{sys.version_info.minor}/site-packages'
    dependency_site = Path(sys.prefix) / f'lib/python{sys.version_info.major}.{sys.version_info.minor}/site-packages'
    (site / 'benchmark-dependencies.pth').write_text(str(dependency_site) + '\n')
    python = environment / 'bin/python'
    packages = sorted((payload / 'runtime-wheels').glob('*.whl'))
    if len(packages) != len(SKILLS) + 1 or any(not p.name.endswith('-py3-none-any.whl') for p in packages):
        raise ValueError('release lacks the prebuilt bundled runtime wheels')
    with log.open('wb') as stream:
        subprocess.run([str(python), '-m', 'pip', 'install', '--no-index', '--no-cache-dir',
                        '--no-deps', *(str(path) for path in packages)],
                       stdout=stream, stderr=subprocess.STDOUT, check=True, timeout=180)
        subprocess.run([str(python), '-m', 'pip', 'check'], stdout=stream,
                       stderr=subprocess.STDOUT, check=True, timeout=30)
    return python


def inventory(python: Path) -> dict:
    code = '''import importlib, importlib.metadata, json, sys
from pathlib import Path
paths = {}
for name in %r:
    path = Path(importlib.import_module(name).__file__).resolve()
    path.relative_to(Path(sys.prefix).resolve())
    paths[name] = str(path)
print(json.dumps({'python': sys.version, 'prefix': sys.prefix, 'executable': sys.executable,
 'modules': paths, 'packages': sorted((d.metadata['Name'], d.version) for d in importlib.metadata.distributions())}))
''' % (MODULES,)
    result = subprocess.run([str(python), '-c', code], capture_output=True, text=True,
                            check=True, timeout=30)
    if len(result.stdout) > 1024 ** 2:
        raise ValueError('oversized runtime inventory')
    data = json.loads(result.stdout)
    root = Path(data['prefix']).resolve()
    files = [p for p in root.rglob('*') if p.is_file() and p.suffix != '.pyc']
    if len(files) > 20000 or sum(p.stat().st_size for p in files) > 256 * 1024 ** 2:
        raise ValueError('oversized installed runtime')
    package_files = [p for p in files if 'site-packages' in p.parts]
    if any(p.is_symlink() or not p.resolve().is_relative_to(root) for p in package_files):
        raise ValueError('runtime package escapes its environment')
    data['installed_files'] = {str(p.relative_to(root)): file_sha256(p) for p in sorted(package_files)}
    dependency_site = Path(sys.prefix) / f'lib/python{sys.version_info.major}.{sys.version_info.minor}/site-packages'
    dependencies = [p for p in dependency_site.rglob('*') if p.is_file() and not p.is_symlink() and p.suffix != '.pyc']
    if len(dependencies) > 30000 or sum(p.stat().st_size for p in dependencies) > 512 * 1024 ** 2:
        raise ValueError('oversized shared dependencies')
    data['dependency_files'] = {str(p.relative_to(dependency_site)): file_sha256(p) for p in sorted(dependencies)}
    data['dependency_lock_sha256'] = file_sha256(Path(__file__).with_name('requirements.lock'))
    data['interpreter_sha256'] = file_sha256(Path(data['executable']).resolve())
    return data
