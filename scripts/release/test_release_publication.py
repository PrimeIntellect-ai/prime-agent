#!/usr/bin/env python3
"""Execute release workflow shell with local gh/aws fakes; never publish anything."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]
WORKFLOW = REPO / '.github/workflows/release.yml'


def step_script(name):
    step = WORKFLOW.read_text().split(f'      - name: {name}\n', 1)[1]
    step = step.split('      - name:', 1)[0].split('        run: |\n', 1)[1]
    lines = []
    for line in step.splitlines():
        if line.strip() and not line.startswith('          '):
            break
        lines.append(line[10:])
    return '\n'.join(lines)


FAKE_GH = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
mode = os.environ.get('MODE', 'existing')
with open('calls.jsonl', 'a') as f:
    f.write(json.dumps(args) + '\n')
if args[:2] == ['release', 'view']:
    if mode in ('absent', 'api-error', 'view-error'):
        sys.exit(1)
    response = {'assets': [{'name': 'beta.json'}]}
    if mode == 'empty': response = {'assets': []}
    if mode == 'malformed': response = {'assets': [{'other': 'beta.json'}]}
    if mode == 'wrong-shape': response = []
    if mode in ('no-beta-newer', 'no-beta-older', 'no-beta-unparsable'):
        served = '0.10.1-beta.11' if mode == 'no-beta-newer' else '0.10.1-beta.9'
        names = [f'prime-agent-{served}-linux-x64.tar.gz', 'prime-agent-0.9.9-beta.999.tgz',
                 'prime-agent-linux.debug.gz', 'SHA256SUMS', 'manifest.json']
        if mode == 'no-beta-unparsable': names = ['prime-agent-unversioned.tar.gz', 'SHA256SUMS']
        response = {'assets': [{'name': name} for name in names]}
    print(json.dumps(response))
elif args[:2] == ['release', 'download']:
    if mode == 'download-error': sys.exit(1)
    path = pathlib.Path(args[args.index('--dir') + 1]) / 'beta.json'
    path.write_text(json.dumps({'version': os.environ['CURRENT']}))
elif args[:2] in (['release', 'upload'], ['release', 'create']):
    for arg in args:
        if arg.startswith('release-out/'):
            assert pathlib.Path(arg).is_file(), arg
elif args[0] == 'api':
    if '--include' in args:
        status = '404 Not Found' if mode == 'absent' else '503 Service Unavailable'
        if mode == 'view-error': status = '200 OK'
        print('HTTP/2.0 ' + status + '\n\n{}')
        sys.exit(0 if mode == 'view-error' else 1)
    if '/git/ref/' in args[1]: print(json.dumps({'object': {'type': 'commit', 'sha': 'tag'}}))
    elif '/git/commits/' in args[1]: print('built')
    elif '/commits/main' in args[1]: print('newer')
    else: sys.exit(2)
else: sys.exit(2)
'''

FAKE_AWS = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
assert args[:2] == ['s3', 'cp'], args
assert pathlib.Path(args[2]).is_file(), args
with open('uploads.jsonl', 'a') as f: f.write(json.dumps(args) + '\n')
if os.environ.get('FAIL_ARCHIVE') == '1' and args[2].endswith('.debug.gz'): sys.exit(1)
'''


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        for name, script in [('gh', FAKE_GH), ('aws', FAKE_AWS), ('sleep', '#!/bin/sh\nexit 0\n')]:
            path = self.bin / name
            path.write_text(script)
            path.chmod(0o755)
        self.version = 'v0.10.1-beta.10'
        self.env = dict(os.environ, PATH=f'{self.bin}:{os.environ["PATH"]}',
                        RELEASE_VERSION=self.version, CURRENT='v0.10.1-beta.9',
                        GH_REPO='owner/repo', GITHUB_REPOSITORY='owner/repo',
                        GITHUB_REF_NAME=self.version, R2_BUCKET='bucket',
                        R2_ENDPOINT_URL='https://invalid.example',
                        R2_PUBLIC_BASE_URL='https://invalid.example')
        self.out = self.root / 'release-out'
        self.out.mkdir()
        names = [f'prime-agent-{self.version[1:]}-{p}.tar.gz' for p in
                 ('darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64')]
        names += [f'prime-agent-{self.version[1:]}.tgz', 'prime-agent-linux.debug.gz',
                  'manifest.json', 'beta.json', 'sbom-spdx-linux.json']
        for name in names:
            (self.out / name).write_text('{}')
        self.sums = ''.join(f'{hashlib.sha256(b"{}").hexdigest()}  {name}\n'
                            for name in names if name.endswith(('.gz', '.tgz')))
        (self.out / 'SHA256SUMS').write_text(self.sums)

    def run_step(self, name, **env):
        return subprocess.run(['bash', '-c', step_script(name)], cwd=self.root,
                              env=dict(self.env, **env), capture_output=True, text=True)

    def mutations(self):
        calls = self.root / 'calls.jsonl'
        return [a for a in map(json.loads, calls.read_text().splitlines())
                if a[:2] in (['release', 'upload'], ['release', 'create'])] if calls.exists() else []

    def refresh(self, **env):
        return self.run_step('Refresh the rolling nightly release', **env)

    def test_existing_release_preserves_complete_payload_and_checksums(self):
        result = self.refresh()
        self.assertEqual(result.returncode, 0, result.stderr)
        mutations = self.mutations()
        self.assertEqual(len(mutations), 1)
        self.assertEqual(mutations[0][:3], ['release', 'upload', 'nightly'])
        self.assertEqual({a for a in mutations[0] if a.startswith('release-out/')},
                         {f'release-out/{p.name}' for p in self.out.iterdir()})
        self.assertEqual((self.out / 'SHA256SUMS').read_text(), self.sums)

    def test_corrupt_payload_never_publishes(self):
        (self.out / "prime-agent-linux.debug.gz").write_text("corrupt")
        result = self.refresh()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.mutations(), [])

    def test_newer_release_blocks_stale_rerun(self):
        for current in ('v0.10.1-beta.11', 'v0.11.0-beta.1', 'v1.0.0-beta.1'):
            with self.subTest(current=current):
                result = self.refresh(CURRENT=current)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.mutations(), [])

    def test_same_version_rerun_and_new_numeric_base_can_publish(self):
        for current in (self.version, 'v0.9.9-beta.999'):
            with self.subTest(current=current):
                (self.root / 'calls.jsonl').write_text('')
                result = self.refresh(CURRENT=current)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(len(self.mutations()), 1)

    def test_unreadable_state_fails_closed(self):
        for mode in ('api-error', 'view-error', 'malformed', 'wrong-shape', 'download-error'):
            with self.subTest(mode=mode):
                result = self.refresh(MODE=mode)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.mutations(), [])

    def test_invalid_version_fails_closed(self):
        for current in ('', 'not-a-version', 'v0.10.1', 'v0.10.1-beta.9\nv9.0.0-beta.1'):
            with self.subTest(current=current):
                result = self.refresh(CURRENT=current)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.mutations(), [])

    def test_confirmed_absence_bootstraps_and_empty_release_heals(self):
        for mode, operation in (('absent', 'create'), ('empty', 'upload')):
            with self.subTest(mode=mode):
                (self.root / 'calls.jsonl').write_text('')
                result = self.refresh(MODE=mode)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.mutations()[0][:3], ['release', operation, 'nightly'])

    def test_witnessless_release_blocks_stale_rerun(self):
        result = self.refresh(MODE='no-beta-newer')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('already serves v0.10.1-beta.11', result.stdout)
        self.assertEqual(self.mutations(), [])

    def test_witnessless_release_heals_when_this_refresh_is_newest(self):
        result = self.refresh(MODE='no-beta-older')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.mutations()[0][:3], ['release', 'upload', 'nightly'])

    def test_witnessless_release_with_unreadable_asset_names_fails_closed(self):
        result = self.refresh(MODE='no-beta-unparsable')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.mutations(), [])

    def test_malformed_release_version_fails_closed_on_bootstrap_and_heal(self):
        for mode in ('absent', 'empty'):
            with self.subTest(mode=mode):
                result = self.refresh(MODE=mode, RELEASE_VERSION='v0.10.1-beta2')
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.mutations(), [])

    def test_superseded_beta_archives_every_file_without_advancing_pointers(self):
        result = self.run_step('Publish the R2 channel (the channel serves no GitHub URL)')
        self.assertEqual(result.returncode, 0, result.stderr)
        uploads = list(map(json.loads, (self.root / 'uploads.jsonl').read_text().splitlines()))
        self.assertEqual({a[3] for a in uploads},
                         {f's3://bucket/releases/{self.version}/{p.name}' for p in self.out.iterdir()})
        self.assertTrue(all(a[-1] == 'public, max-age=31536000, immutable' for a in uploads))

    def test_archive_failure_stops_promotion(self):
        result = self.run_step('Publish the R2 channel (the channel serves no GitHub URL)', FAIL_ARCHIVE='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'calls.jsonl').exists())


if __name__ == '__main__':
    unittest.main()
