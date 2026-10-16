import io
import json
import os
import shutil
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from inputs import extract, prepare, main
from provenance import file_sha256

SHA = 'a' * 40


def archive_bytes(members):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as archive:
        for member, payload in members:
            archive.addfile(member, io.BytesIO(payload) if member.isfile() else None)
    return output.getvalue()


def member(name, payload=b'fixture'):
    record = tarfile.TarInfo(name)
    record.size = len(payload)
    return record, payload


class InputTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def extract_members(self, members, **limits):
        destination = self.root / 'extracted'
        destination.mkdir()
        with tarfile.open(fileobj=io.BytesIO(archive_bytes(members)), mode='r:gz') as archive:
            extract(archive, destination, **limits)
        return destination

    def test_regular_files_extract_without_executing_candidate(self):
        with (patch('subprocess.run', side_effect=AssertionError('controller executed candidate')),
              patch('subprocess.check_output', side_effect=AssertionError('controller executed candidate'))):
            destination = self.extract_members([member('prime-agent'), member('skills/a.py', b'content')])
        self.assertEqual((destination / 'skills/a.py').read_bytes(), b'content')
        self.assertEqual((destination / 'prime-agent').stat().st_mode & 0o777, 0o755)
        self.assertEqual((destination / 'skills/a.py').stat().st_mode & 0o777, 0o644)

    def test_links_devices_and_traversal_rejected(self):
        for name, kind in (('../escape', tarfile.REGTYPE), ('/escape', tarfile.REGTYPE),
                           ('link', tarfile.SYMTYPE), ('hard', tarfile.LNKTYPE),
                           ('device', tarfile.CHRTYPE), ('block', tarfile.BLKTYPE),
                           ('fifo', tarfile.FIFOTYPE)):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                record = tarfile.TarInfo(name)
                record.type = kind
                record.linkname = '/tmp/escape'
                with tarfile.open(fileobj=io.BytesIO(archive_bytes([(record, b'')])), mode='r:gz') as archive:
                    with self.assertRaises(ValueError):
                        extract(archive, Path(directory))

    def test_duplicate_and_size_limits_rejected(self):
        cases = [([member('same'), member('./same')], {}),
                 ([member('large', b'12345')], {'max_file': 4}),
                 ([member('a', b'123'), member('b', b'456')], {'max_total': 5})]
        for members, limits in cases:
            with self.subTest(limits=limits), tempfile.TemporaryDirectory() as directory:
                with tarfile.open(fileobj=io.BytesIO(archive_bytes(members)), mode='r:gz') as archive:
                    with self.assertRaises(ValueError):
                        extract(archive, Path(directory), **limits)

    def test_windows_path_syntax_and_devices_are_rejected_on_every_host(self):
        for name in ('..\\..\\outside', 'C:/Windows/evil', 'C:relative',
                     '\\\\server\\share\\outside', 'dir/.. /outside', 'dir/trailing./file',
                     'NUL', 'CON.txt', 'dir/file:stream'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                with tarfile.open(fileobj=io.BytesIO(archive_bytes([member(name)])), mode='r:gz') as archive:
                    with self.assertRaises(ValueError):
                        extract(archive, Path(directory))

    def artifact(self):
        artifact = self.root / 'artifact'
        artifact.mkdir()
        binary = artifact / 'binary-fixture'
        binary.write_bytes(b'not an executable; never run')
        archive = artifact / 'release.tar.gz'
        archive.write_bytes(archive_bytes([member('prime-agent', binary.read_bytes())]))
        binary_hash = file_sha256(binary)
        binary.unlink()
        manifest = {'commit': SHA, 'binaries': [{'target': 'x86_64-unknown-linux-gnu',
                     'file': archive.name, 'executableSha256': binary_hash}]}
        (artifact / 'manifest.json').write_text(json.dumps(manifest))
        (artifact / 'runtime-wheels.tar.gz').write_bytes(archive_bytes([
            member('fixture-0.1-py3-none-any.whl', b'wheel fixture, never executed')]))
        receipt = {'repository': 'PrimeIntellect-ai/prime-agent', 'source_sha': SHA,
                   'run_id': 123, 'run_attempt': 2, 'payloads': {}}
        for name in ('manifest.json', archive.name, 'runtime-wheels.tar.gz'):
            payload = artifact / name
            receipt['payloads'][name] = {'bytes': payload.stat().st_size, 'sha256': file_sha256(payload)}
        (artifact / 'receipt.json').write_text(json.dumps(receipt))
        return artifact, receipt

    def test_valid_release_manifest_key_and_no_controller_execution(self):
        artifact, receipt = self.artifact()
        with (patch('subprocess.run', side_effect=AssertionError('candidate executed')),
              patch('subprocess.check_output', side_effect=AssertionError('candidate executed'))):
            self.assertEqual(prepare(artifact, self.root / 'payload', SHA, 123, 2), receipt)
        self.assertEqual((self.root / 'payload/prime-agent').read_bytes(), b'not an executable; never run')

    def test_preparation_unpacks_wheels_and_is_readable_under_private_umask(self):
        artifact, receipt = self.artifact()
        head = self.root / 'head-artifact'
        shutil.copytree(artifact, head)
        for side, path in (('base', artifact), ('head', head)):
            row = {**receipt, 'side': side, 'pr': 8, 'base_sha': SHA, 'head_sha': SHA,
                   'builder_sha': 'b' * 40, 'workflow_ref': 'reviewed-fixture',
                   'source_repository': 'PrimeIntellect-ai/prime-agent'}
            (path / 'receipt.json').write_text(json.dumps(row))
        out = self.root / 'prepared'
        arguments = ['inputs.py', '--base-artifact', str(artifact), '--head-artifact', str(head),
                     '--out', str(out), '--base-sha', SHA, '--head-sha', SHA, '--event-head-sha', SHA,
                     '--builder-sha', 'b' * 40, '--workflow-ref', 'reviewed-fixture',
                     '--source-repository', 'PrimeIntellect-ai/prime-agent',
                     '--run-id', '123', '--run-attempt', '2', '--pr', '8']
        previous = os.umask(0o077)
        try:
            with patch('sys.argv', arguments):
                main()
        finally:
            os.umask(previous)
        for path in (out, out / 'base', out / 'base/runtime-wheels'):
            self.assertEqual(path.stat().st_mode & 0o777, 0o755)
        wheel = out / 'head/runtime-wheels/fixture-0.1-py3-none-any.whl'
        self.assertEqual(wheel.read_bytes(), b'wheel fixture, never executed')
        self.assertEqual(wheel.stat().st_mode & 0o777, 0o644)

    def test_receipt_identity_and_hashes_rejected(self):
        artifact, receipt = self.artifact()
        original = json.loads(json.dumps(receipt))
        for key, value in (('repository', 'attacker/repo'), ('source_sha', 'b' * 40),
                           ('run_id', 124), ('run_attempt', 3)):
            receipt = {**original, key: value}
            (artifact / 'receipt.json').write_text(json.dumps(receipt))
            with self.subTest(key=key), self.assertRaises(ValueError):
                prepare(artifact, self.root / 'payload', SHA, 123, 2)
        (artifact / 'receipt.json').write_text(json.dumps(original))
        (artifact / 'release.tar.gz').write_bytes(b'tampered')
        with self.assertRaises(ValueError):
            prepare(artifact, self.root / 'payload', SHA, 123, 2)

    def test_expected_builder_side_and_event_head_must_match(self):
        artifact, receipt = self.artifact()
        receipt.update(side='base', builder_sha='b' * 40, head_sha=SHA)
        (artifact / 'receipt.json').write_text(json.dumps(receipt))
        for expected in ({'side': 'head'}, {'builder_sha': 'c' * 40}, {'head_sha': 'd' * 40}):
            with self.subTest(expected=expected), self.assertRaises(ValueError):
                prepare(artifact, self.root / 'payload', SHA, 123, 2, expected=expected)

    def test_valid_but_oversized_manifest_is_rejected_before_json_parse(self):
        artifact, receipt = self.artifact()
        manifest = artifact / 'manifest.json'
        manifest.write_text(manifest.read_text() + ' ' * 1024 ** 2)
        receipt['payloads']['manifest.json'] = {'bytes': manifest.stat().st_size,
                                               'sha256': file_sha256(manifest)}
        (artifact / 'receipt.json').write_text(json.dumps(receipt))
        with self.assertRaises(ValueError):
            prepare(artifact, self.root / 'payload', SHA, 123, 2)

    def test_unsafe_payload_path_and_link_rejected(self):
        artifact, receipt = self.artifact()
        receipt['payloads']['../outside'] = {'bytes': 1, 'sha256': '0' * 64}
        (artifact / 'receipt.json').write_text(json.dumps(receipt))
        with self.assertRaises(ValueError):
            prepare(artifact, self.root / 'payload', SHA, 123, 2)
        del receipt['payloads']['../outside']
        (artifact / 'receipt.json').write_text(json.dumps(receipt))
        manifest = artifact / 'manifest.json'
        manifest.rename(artifact / 'original-manifest')
        manifest.symlink_to(artifact / 'original-manifest')
        with self.assertRaises(ValueError):
            prepare(artifact, self.root / 'payload', SHA, 123, 2)

    def test_windows_payload_names_are_rejected_before_filesystem_access(self):
        artifact, receipt = self.artifact()
        original_is_file = Path.is_file
        for name in ('extra:stream', 'CON.txt', 'trailing.'):
            row = json.loads(json.dumps(receipt))
            row['payloads'][name] = {'bytes': 1, 'sha256': '0' * 64}
            (artifact / 'receipt.json').write_text(json.dumps(row))
            def checked(path):
                if path.name == name:
                    raise AssertionError('unsafe payload reached filesystem inspection')
                return original_is_file(path)
            with self.subTest(name=name), patch.object(Path, 'is_file', checked):
                with self.assertRaises(ValueError):
                    prepare(artifact, self.root / 'payload', SHA, 123, 2)


if __name__ == '__main__':
    unittest.main()
