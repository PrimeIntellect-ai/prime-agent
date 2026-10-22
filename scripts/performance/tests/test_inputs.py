import gzip
import hashlib
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
BINARY = b'not an executable; never run'


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

    def artifact(self):
        artifact = self.root / 'artifact'
        artifact.mkdir()
        archive = artifact / 'release.tar.gz'
        archive.write_bytes(archive_bytes([member('prime-agent', BINARY)]))
        manifest = {'commit': SHA, 'binaries': [{'target': 'x86_64-unknown-linux-gnu',
                     'file': archive.name, 'sha256': file_sha256(archive),
                     'executableSha256': hashlib.sha256(BINARY).hexdigest()}]}
        (artifact / 'manifest.json').write_text(json.dumps(manifest))
        return artifact

    def test_valid_release_manifest_unpacks_payload_without_candidate_execution(self):
        artifact = self.artifact()
        with (patch('subprocess.run', side_effect=AssertionError('candidate executed')),
              patch('subprocess.check_output', side_effect=AssertionError('candidate executed'))):
            prepare(artifact, self.root / 'payload', SHA)
        binary = self.root / 'payload/prime-agent'
        self.assertEqual(binary.read_bytes(), BINARY)
        self.assertEqual(binary.stat().st_mode & 0o777, 0o755)

    def test_cli_prepares_both_sides_readable_under_private_umask(self):
        head = self.root / 'head-artifact'
        shutil.copytree(self.artifact(), head)
        out = self.root / 'prepared'
        arguments = ['inputs.py', '--base-artifact', str(self.root / 'artifact'),
                     '--head-artifact', str(head), '--out', str(out),
                     '--base-sha', SHA, '--head-sha', SHA]
        previous = os.umask(0o077)
        try:
            with patch('sys.argv', arguments):
                main()
        finally:
            os.umask(previous)
        self.assertEqual(out.stat().st_mode & 0o777, 0o755)
        for side in ('base', 'head'):
            binary = out / side / 'prime-agent'
            self.assertEqual(binary.read_bytes(), BINARY)
            self.assertEqual(binary.stat().st_mode & 0o777, 0o755)

    def test_cli_requires_full_commit_shas(self):
        arguments = ['inputs.py', '--base-artifact', str(self.root / 'artifact'),
                     '--head-artifact', str(self.root / 'artifact'),
                     '--out', str(self.root / 'prepared'),
                     '--base-sha', 'short', '--head-sha', SHA]
        with patch('sys.argv', arguments), self.assertRaises(SystemExit):
            main()
        self.assertFalse((self.root / 'prepared').exists())

    def test_manifest_commit_must_match_requested_sha(self):
        artifact = self.artifact()
        with self.assertRaises(ValueError):
            prepare(artifact, self.root / 'payload', 'c' * 40)

    def test_tampered_payload_and_executable_hashes_rejected(self):
        artifact = self.artifact()
        for damage in ('payload', 'executable'):
            with self.subTest(damage=damage), tempfile.TemporaryDirectory() as directory:
                damaged = shutil.copytree(artifact, Path(directory) / 'artifact')
                manifest_path = damaged / 'manifest.json'
                if damage == 'payload':
                    (damaged / 'release.tar.gz').write_bytes(b'tampered')
                else:
                    manifest = json.loads(manifest_path.read_text())
                    manifest['binaries'][0]['executableSha256'] = '0' * 64
                    manifest_path.write_text(json.dumps(manifest))
                with self.assertRaises(ValueError):
                    prepare(damaged, Path(directory) / 'payload', SHA)

    def pax_bomb_artifact(self):
        """A checksum-valid release whose tar opens with a PAX extension
        header declaring far more data than the archive holds: tarfile
        reads an extension header of its declared size in one call."""
        artifact = self.artifact()
        payload = artifact / 'release.tar.gz'
        record = tarfile.TarInfo('pax-bomb')
        record.type = tarfile.XHDTYPE
        record.size = 1024 ** 3
        buffer = io.BytesIO()
        with gzip.GzipFile(fileobj=buffer, mode='wb') as stream:
            stream.write(record.tobuf(tarfile.GNU_FORMAT))
            stream.write(b'\0' * 8192)
        payload.write_bytes(buffer.getvalue())
        manifest_path = artifact / 'manifest.json'
        manifest = json.loads(manifest_path.read_text())
        manifest['binaries'][0]['sha256'] = file_sha256(payload)
        manifest_path.write_text(json.dumps(manifest))
        return artifact

    def test_expansion_beyond_the_total_cap_rejects_before_parsing(self):
        artifact = self.pax_bomb_artifact()
        with patch('inputs.MAX_TOTAL', 4096), patch('tarfile.open') as opened:
            with self.assertRaises(ValueError):
                prepare(artifact, self.root / 'payload', SHA)
        opened.assert_not_called()

    def test_declared_metadata_cannot_read_past_the_bounded_stream(self):
        artifact = self.pax_bomb_artifact()
        with patch('inputs.MAX_TOTAL', 1024 * 1024):
            with self.assertRaises(ValueError):
                prepare(artifact, self.root / 'payload', SHA)

    def test_manifest_shape_and_symlink_rejected(self):
        artifact = self.artifact()
        manifest_path = artifact / 'manifest.json'
        for text in ('{}', json.dumps({'commit': SHA, 'binaries': []}),
                     json.dumps({'commit': SHA, 'binaries': [
                         {'target': 'x86_64-unknown-linux-gnu', 'file': 'release.tar.gz'},
                         {'target': 'x86_64-unknown-linux-gnu', 'file': 'other.tar.gz'}]})):
            with self.subTest(text=text[:40]):
                manifest_path.write_text(text)
                with self.assertRaises(ValueError):
                    prepare(artifact, self.root / 'payload', SHA)
        manifest_path.write_text(json.dumps({'commit': SHA, 'binaries': [
            {'target': 'x86_64-unknown-linux-gnu', 'file': 'release.tar.gz',
             'sha256': file_sha256(artifact / 'release.tar.gz'),
             'executableSha256': hashlib.sha256(BINARY).hexdigest()}]}))
        for damage in ('missing', 'symlink', 'oversized'):
            with self.subTest(damage=damage), tempfile.TemporaryDirectory() as directory:
                damaged = shutil.copytree(artifact, Path(directory) / 'artifact')
                target = damaged / 'manifest.json'
                if damage == 'missing':
                    target.unlink()
                elif damage == 'symlink':
                    target.rename(damaged / 'original-manifest')
                    target.symlink_to(damaged / 'original-manifest')
                else:
                    target.write_text(target.read_text() + ' ' * 1024 ** 2)
                with self.assertRaises(ValueError):
                    prepare(damaged, Path(directory) / 'payload', SHA)

    def test_payload_identity_rejected_before_filesystem_access(self):
        artifact = self.artifact()
        manifest_path = artifact / 'manifest.json'
        original_is_file = Path.is_file
        for name in ('../outside', 'nested/release.tar.gz'):
            with self.subTest(name=name):
                manifest = json.loads(manifest_path.read_text())
                manifest['binaries'][0]['file'] = name
                manifest_path.write_text(json.dumps(manifest))
                def checked(path):
                    if path.name != 'manifest.json':
                        raise AssertionError('unsafe payload reached filesystem inspection')
                    return original_is_file(path)
                with patch.object(Path, 'is_file', checked):
                    with self.assertRaises(ValueError):
                        prepare(artifact, self.root / 'payload', SHA)

    def test_payload_link_rejected(self):
        artifact = self.artifact()
        archive = artifact / 'release.tar.gz'
        archive.rename(artifact / 'backing.tar.gz')
        archive.symlink_to(artifact / 'backing.tar.gz')
        with self.assertRaises(ValueError):
            prepare(artifact, self.root / 'payload', SHA)


if __name__ == '__main__':
    unittest.main()
