#!/usr/bin/env python3
"""Prove stale tool text cannot satisfy a current kernel probe and cell quoting works."""
import ast
import asyncio
from types import SimpleNamespace
import unittest
from unittest.mock import patch, MagicMock
from review_kernel_env_parity import current_probe, CODE, MARKER, owned_kernel, invoke_clean


def requests(content=None):
    messages = [{'role': 'tool', 'tool_call_id': 'kernel_old', 'content': MARKER + '{"old":true}'}]
    if content is not None:
        messages.append({'role': 'tool', 'tool_call_id': 'kernel_new', 'content': content})
    return [{}, {'messages': messages}]


class ProbeTests(unittest.TestCase):
    def test_only_current_result_counts(self):
        self.assertEqual(current_probe(requests(MARKER + '{"new":true}'), 'new'), {'new': True})

    def test_old_probe_cannot_hide_failed_cell(self):
        with self.assertRaisesRegex(AssertionError, 'current kernel probe'):
            current_probe(requests('Traceback: failed current cell'), 'new')

    def test_old_probe_cannot_hide_missing_result(self):
        with self.assertRaisesRegex(AssertionError, 'current tool result'):
            current_probe(requests(), 'new')

    def test_duplicate_probe_is_failure(self):
        with self.assertRaisesRegex(AssertionError, 'current kernel probe'):
            current_probe(requests(MARKER + '{}\n' + MARKER + '{}'), 'new')

    def test_cell_passes_the_intended_bash_command(self):
        commands = []
        async def bash(command):
            commands.append(command)
            return SimpleNamespace(output='ABSENT', exit_code=0)
        compiled = compile(CODE, '<fixture-cell>', 'exec', flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
        asyncio.run(eval(compiled, {'bash': bash, 'print': lambda *_args: None}))
        self.assertEqual(commands, ['printf \'%s\' "${PA_PREFIX_SENTINEL:-ABSENT}"'])

    def test_foreign_fixture_kernel_is_not_owned(self):
        env = b'PRIME_AGENT_KERNEL_OWNER_PID=123\0PA_KERNEL_ENV_FIXTURE_ID=/other-fixture\0'
        with patch('review_kernel_env_parity.proc_identity', return_value=('proc:456', 'S')), \
                patch('pathlib.Path.read_bytes', return_value=env):
            self.assertIsNone(owned_kernel(789, 123, '/fixture'))

    def test_wrong_kernel_owner_is_not_owned(self):
        env = b'PRIME_AGENT_KERNEL_OWNER_PID=999\0PA_KERNEL_ENV_FIXTURE_ID=/fixture\0'
        with patch('review_kernel_env_parity.proc_identity', return_value=('proc:456', 'S')), \
                patch('pathlib.Path.read_bytes', return_value=env):
            self.assertIsNone(owned_kernel(789, 123, '/fixture'))

    def test_recycled_kernel_pid_is_not_owned(self):
        with patch('review_kernel_env_parity.proc_identity', return_value=('proc:new', 'S')):
            self.assertIsNone(owned_kernel(789, 123, '/fixture', 'proc:old'))

    def test_matching_kernel_owner_fixture_and_start_identity(self):
        env = b'PRIME_AGENT_KERNEL_OWNER_PID=123\0PA_KERNEL_ENV_FIXTURE_ID=/fixture\0'
        with patch('review_kernel_env_parity.proc_identity', return_value=('proc:456', 'S')), \
                patch('pathlib.Path.read_bytes', side_effect=[env, b'/fixture/python3\0-m\0rlm.kernel\0']):
            self.assertEqual(owned_kernel(789, 123, '/fixture', 'proc:456'), 'proc:456')

    def test_successful_process_without_kernel_ownership_is_not_verified(self):
        process = MagicMock(pid=123, returncode=0)
        process.communicate.return_value = ('fixture output', '')
        with patch('review_kernel_env_parity.subprocess.Popen', return_value=process), \
                patch('pathlib.Path.iterdir', return_value=[]), patch('review_kernel_env_parity.stop'):
            with self.assertRaisesRegex(AssertionError, 'capture kernel ownership'):
                invoke_clean(['/fixture/binary'], '/fixture', {'PA_KERNEL_ENV_FIXTURE_ID': '/fixture'}, {})


if __name__ == '__main__':
    unittest.main()
