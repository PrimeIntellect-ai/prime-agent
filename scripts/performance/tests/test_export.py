import json
from pathlib import Path
import sys
import tempfile
import tarfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from export import TARGET, elf_requirements, pack_test, payload_inventory, test_executable, validate_identity


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.source = Path(self.temporary.name).resolve()
        self.deps = self.source / 'target' / TARGET / 'release' / 'deps'
        self.deps.mkdir(parents=True)
        self.binary = self.deps / 'pa_core-test'
        self.binary.write_bytes(b'fixture, never executed')
        self.records = self.source / 'cargo.jsonl'
        self.metadata = self.source / 'metadata.json'
        self.metadata.write_text(json.dumps({'packages': [{'name': 'pa-core', 'id': 'pa-core-id',
            'manifest_path': str(self.source / 'crates/pa-core/Cargo.toml')}]}))
        self.row = {'reason': 'compiler-artifact', 'package_id': 'pa-core-id',
                    'target': {'name': 'pa_core', 'kind': ['lib']},
                    'profile': {'test': True}, 'executable': str(self.binary)}

    def select(self, rows):
        self.records.write_text('\n'.join(json.dumps(row) for row in rows))
        return test_executable(self.records, self.metadata, self.source)

    def test_selects_only_the_expected_package_library_test(self):
        unrelated = {**self.row, 'package_id': 'other-package'}
        self.assertEqual(self.select([unrelated, self.row]), self.binary)
        for rows in ([], [unrelated], [self.row, self.row], [{**self.row, 'profile': {'test': False}}]):
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                self.select(rows)

    def test_rejects_escaped_and_linked_executables(self):
        outside = self.source / 'outside'
        outside.write_bytes(b'never executed')
        with self.assertRaises(ValueError):
            self.select([{**self.row, 'executable': str(outside)}])
        self.binary.unlink()
        self.binary.symlink_to(outside)
        with self.assertRaises(ValueError):
            self.select([self.row])

    def test_rejects_linked_build_directory_even_when_inside_source(self):
        self.binary.unlink()
        self.deps.rmdir()
        alternate = self.source / 'alternate'
        alternate.mkdir()
        (alternate / self.binary.name).write_bytes(b'never executed')
        self.deps.symlink_to(alternate, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.select([self.row])

    def test_rejects_empty_binary_and_duplicate_metadata(self):
        self.binary.write_bytes(b'')
        with self.assertRaises(ValueError):
            self.select([self.row])
        data = json.loads(self.metadata.read_text())
        data['packages'] *= 2
        self.metadata.write_text(json.dumps(data))
        with self.assertRaises(ValueError):
            self.select([self.row])

    def test_glibc_gate_inspects_without_executing_binary(self):
        with patch('export.subprocess.check_output', side_effect=[
                'GLIBC_2.4 GLIBC_2.35', '(NEEDED) Shared library: [libc.so.6]']) as command:
            self.assertEqual(elf_requirements(self.binary), {'max_glibc': '2.35', 'needed': ['libc.so.6']})
            self.assertEqual([call.args[0][0] for call in command.call_args_list], ['objdump', 'readelf'])
        for symbols in ('GLIBC_2.36', 'not inspectable'):
            with patch('export.subprocess.check_output', return_value=symbols), self.assertRaises(ValueError):
                elf_requirements(self.binary)

    def test_source_identity_must_match_full_requested_side(self):
        for values in (('a' * 40, 'b' * 40, 'c' * 40, 'd' * 40, 'head'),
                       ('d' * 9, 'b' * 40, 'c' * 40, 'd' * 40, 'head')):
            with self.subTest(values=values), self.assertRaises(ValueError):
                validate_identity(*values)

    def test_test_payload_has_reproducible_metadata_and_bytes(self):
        first, second = self.source / 'first.tar.gz', self.source / 'second.tar.gz'
        pack_test(self.binary, first)
        self.binary.touch()
        pack_test(self.binary, second)
        self.assertEqual(first.read_bytes(), second.read_bytes())
        with tarfile.open(first) as archive:
            member, = archive.getmembers()
            self.assertEqual((member.name, member.uid, member.gid, member.mtime, member.mode),
                             ('pa-core-tests', 0, 0, 0, 0o755))

    def test_upload_inventory_rejects_oversized_files_total_and_links(self):
        with patch('export.MAX_BINARY_BYTES', 1), self.assertRaises(ValueError):
            payload_inventory(self.deps)
        with patch('export.MAX_EXPORT_BYTES', 1), self.assertRaises(ValueError):
            payload_inventory(self.deps)
        self.binary.unlink()
        self.binary.symlink_to(self.records)
        with self.assertRaises(ValueError):
            payload_inventory(self.deps)


if __name__ == '__main__':
    unittest.main()
