import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from runtime import bundled_skills, inventory


def fake_venv(directory: str) -> tuple[Path, Path]:
    root = Path(directory) / 'venv'
    site = root / 'lib/python3.12/site-packages'
    site.mkdir(parents=True)
    (site / 'rlm_skill.py').write_text('fixture')
    (site / 'rlm_skill.pyc').write_bytes(b'ignored bytecode')
    executable = root / 'bin/python'
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b'fixture interpreter, never run')
    return root, executable


def fake_skills(directory: str) -> Path:
    skills = Path(directory) / 'skills'
    (skills / 'agent-message/src/agent_message').mkdir(parents=True)
    (skills / 'agent-message/pyproject.toml').write_text('[project]\nname = "agent-message"\n')
    (skills / 'agent-message/src/agent_message/__init__.py').write_text('skill source fixture')
    (skills / 'mcp').mkdir(parents=True)
    (skills / 'mcp/SKILL.md').write_text('markdown skill fixture')
    (skills / 'broken').mkdir(parents=True)
    (skills / 'broken/pyproject.toml').write_text('[project]\n')
    return skills


class BundledSkillTests(unittest.TestCase):
    def test_derives_imports_from_pyproject_by_product_rule(self):
        with tempfile.TemporaryDirectory() as directory:
            skills = fake_skills(directory)
            self.assertEqual(bundled_skills(skills),
                             [('agent_message', (skills / 'agent-message').resolve())])

    def test_rejects_release_without_python_skills(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                bundled_skills(Path(directory))


class InventoryTests(unittest.TestCase):
    def inventory_data(self, root: Path, executable: Path, skills: Path | None) -> dict:
        # The child probe resolves module paths before reporting them.
        return {'prefix': str(root), 'executable': str(executable),
                'modules': {'rlm': str((root / 'lib/python3.12/site-packages/rlm/__init__.py').resolve()),
                            'agent_message': str((skills / 'agent-message/src/agent_message/__init__.py').resolve())},
                'packages': [('prime-agent-runtime', '0.1.0')],
                'distribution_roots': [('prime-agent-runtime', str(root / 'lib/python3.12/site-packages'))]}

    def test_probes_rlm_and_derived_skills_and_inventories_both_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            root, executable = fake_venv(directory)
            skills = fake_skills(directory)
            data = self.inventory_data(root, executable, skills)
            with patch('runtime.subprocess.run', return_value=Mock(stdout=json.dumps(data))) as run:
                result = inventory(executable, skills)
            self.assertEqual(list(result['installed_files']),
                             ['lib/python3.12/site-packages/rlm_skill.py'])
            self.assertEqual(list(result['declared_skill_files']),
                             ['agent_message/pyproject.toml',
                              'agent_message/src/agent_message/__init__.py'])
            self.assertEqual(len(result['interpreter_sha256']), 64)
            code = run.call_args.args[0][-1]
            self.assertIn('rlm', code)
            self.assertIn('agent_message', code)

    def test_rejects_interpreter_outside_its_reported_venv(self):
        with tempfile.TemporaryDirectory() as directory:
            root, executable = fake_venv(directory)
            data = {'prefix': str(root), 'executable': str(Path(directory) / 'python'),
                    'modules': {}, 'packages': []}
            with patch('runtime.subprocess.run', return_value=Mock(stdout=json.dumps(data))):
                with self.assertRaises(ValueError):
                    inventory(executable)

    def test_rejects_runtime_installed_outside_the_venv(self):
        with tempfile.TemporaryDirectory() as directory:
            root, executable = fake_venv(directory)
            skills = fake_skills(directory)
            data = self.inventory_data(root, executable, skills)
            data['modules']['rlm'] = str(skills / 'agent-message/src/rlm/__init__.py')
            with patch('runtime.subprocess.run', return_value=Mock(stdout=json.dumps(data))):
                with self.assertRaises(ValueError):
                    inventory(executable, skills)

    def test_rejects_modules_resolving_into_foreign_environments(self):
        with tempfile.TemporaryDirectory() as directory:
            root, executable = fake_venv(directory)
            skills = fake_skills(directory)
            data = self.inventory_data(root, executable, skills)
            data['modules']['agent_message'] = str(Path(directory) / 'harness/site-packages/agent_message/__init__.py')
            with patch('runtime.subprocess.run', return_value=Mock(stdout=json.dumps(data))):
                with self.assertRaises(ValueError):
                    inventory(executable, skills)

    def test_propagates_child_probe_failure_without_swallowing(self):
        with tempfile.TemporaryDirectory() as directory:
            _, executable = fake_venv(directory)
            failure = subprocess.CalledProcessError(1, str(executable))
            with patch('runtime.subprocess.run', side_effect=failure):
                with self.assertRaises(subprocess.CalledProcessError):
                    inventory(executable)

    def test_editable_pth_may_only_reference_declared_skill_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            root, executable = fake_venv(directory)
            skills = fake_skills(directory)
            site = root / 'lib/python3.12/site-packages'
            data = self.inventory_data(root, executable, skills)
            (site / '__editable__.agent_message.pth').write_text(
                str(skills / 'agent-message/src') + '\n')
            with patch('runtime.subprocess.run', return_value=Mock(stdout=json.dumps(data))):
                inventory(executable, skills)
            (site / '__editable__.agent_message.pth').write_text(
                str(Path(directory) / 'harness/site-packages') + '\n')
            with patch('runtime.subprocess.run', return_value=Mock(stdout=json.dumps(data))):
                with self.assertRaises(ValueError):
                    inventory(executable, skills)

    def test_relative_pth_entries_resolve_against_site_packages(self):
        with tempfile.TemporaryDirectory() as directory:
            root, executable = fake_venv(directory)
            skills = fake_skills(directory)
            site = root / 'lib/python3.12/site-packages'
            data = self.inventory_data(root, executable, skills)
            (site / 'relative.pth').write_text('extra-packages\n')
            with patch('runtime.subprocess.run', return_value=Mock(stdout=json.dumps(data))):
                inventory(executable, skills)
            (site / 'relative.pth').write_text('../../../../harness/site-packages\n')
            with patch('runtime.subprocess.run', return_value=Mock(stdout=json.dumps(data))):
                with self.assertRaises(ValueError):
                    inventory(executable, skills)
            # A path named like an import must not bypass the check.
            (site / 'relative.pth').write_text('imports/../../../../../harness/site-packages\n')
            with patch('runtime.subprocess.run', return_value=Mock(stdout=json.dumps(data))):
                with self.assertRaises(ValueError):
                    inventory(executable, skills)

    def test_rejects_linked_packages(self):
        with tempfile.TemporaryDirectory() as directory:
            root, executable = fake_venv(directory)
            site = root / 'lib/python3.12/site-packages'
            (site / 'escape.py').symlink_to(executable)
            data = {'prefix': str(root), 'executable': str(executable),
                    'modules': {'rlm': str((root / 'lib/python3.12/site-packages/rlm/__init__.py').resolve())},
                    'packages': [], 'distribution_roots': []}
            with patch('runtime.subprocess.run', return_value=Mock(stdout=json.dumps(data))):
                with self.assertRaises(ValueError):
                    inventory(executable)

    def test_rejects_symlinked_package_directories(self):
        with tempfile.TemporaryDirectory() as directory:
            root, executable = fake_venv(directory)
            site = root / 'lib/python3.12/site-packages'
            shared = Path(directory) / 'shared-packages'
            (shared / 'pandas').mkdir(parents=True)
            (shared / 'pandas/__init__.py').write_text('foreign package fixture')
            (site / 'pandas').symlink_to(shared / 'pandas', target_is_directory=True)
            data = {'prefix': str(root), 'executable': str(executable),
                    'modules': {'rlm': str((root / 'lib/python3.12/site-packages/rlm/__init__.py').resolve())},
                    'packages': [], 'distribution_roots': []}
            with patch('runtime.subprocess.run', return_value=Mock(stdout=json.dumps(data))):
                with self.assertRaises(ValueError):
                    inventory(executable)

    def test_rejects_distributions_outside_the_venv(self):
        with tempfile.TemporaryDirectory() as directory:
            root, executable = fake_venv(directory)
            data = {'prefix': str(root), 'executable': str(executable),
                    'modules': {'rlm': str((root / 'lib/python3.12/site-packages/rlm/__init__.py').resolve())},
                    'packages': [('pandas', '2.0.0')],
                    'distribution_roots': [('pandas', str(Path(directory) / 'system/site-packages'))]}
            with patch('runtime.subprocess.run', return_value=Mock(stdout=json.dumps(data))):
                with self.assertRaises(ValueError):
                    inventory(executable)


if __name__ == '__main__':
    unittest.main()
