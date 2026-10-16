#!/usr/bin/env python3
"""Fixture and decision regressions; these never launch either product binary."""
import copy
import json
import pathlib
import socket
import tempfile
import unittest

from review_draft_disconnect_parity import Supervisor, classify_validation


def completed_observations():
    accepted = ["sentinel", "probe"]
    scenarios = {}
    for name in ("queued_close", "refusal", "rebind_close"):
        scenarios[name] = {"executed": True, "invariant_passed": True,
                           "fixture_errors": [], "prompts": accepted[:],
                           "accepted_logical_messages": accepted[:],
                           "wire_prompt_messages": accepted[:]}
    scenarios["refusal"]["prompts"] = ["sentinel", "sentinel", "probe"]
    scenarios["refusal"]["wire_prompt_messages"] = ["sentinel", "sentinel", "probe"]
    rust = {"scenarios": scenarios}
    ts = copy.deepcopy(rust)
    ts["scenarios"]["queued_close"]["wire_prompt_messages"] = ["sentinel", "sentinel", "probe"]
    ts["scenarios"]["rebind_close"] = {
        "executed": False, "invariant_passed": False, "fixture_errors": [],
        "error": "TimeoutError: reconnected attach and visible reconnect result",
        "prompts": ["sentinel"], "accepted_logical_messages": ["sentinel"],
        "wire_prompt_messages": ["sentinel"]}
    return {"results": {"ts": ts, "rust": rust}}


class SupervisorReconnectTests(unittest.TestCase):
    def test_reconnect_reads_settled_history_without_readmitting_the_prompt(self):
        with tempfile.TemporaryDirectory(prefix="draft-fixture-", dir="/tmp") as directory:
            root = pathlib.Path(directory)
            path = root / "supervisor.sock"
            supervisor = Supervisor(path, {"type": "hello", "protocol": 1}, "queued_close", root)
            try:
                with socket.socket(socket.AF_UNIX) as sock:
                    sock.settimeout(2)
                    sock.connect(str(path))
                    with sock.makefile("rb") as stream:
                        self.assertEqual(json.loads(stream.readline())["type"], "hello")
                        prompt = {"type": "prompt", "activeSessionId": "s1", "message": "sentinel"}
                        sock.sendall((json.dumps({"id": "p1", "clientId": "client", "command": prompt}) + "\n").encode())
                        self.assertEqual(stream.readline(), b"", "completed admission loses its reply")
                expected_messages = [
                    {"role": "user", "content": [{"type": "text", "text": "sentinel"}],
                     "timestamp": 1750000000000},
                    {"role": "assistant", "stopReason": "stop", "api": "openai-completions",
                     "provider": "parity-local", "model": "parity-1", "timestamp": 1750000000000,
                     "usage": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0,
                               "totalTokens": 0, "cost": {"input": 0, "output": 0,
                               "cacheRead": 0, "cacheWrite": 0, "total": 0}},
                     "content": [{"type": "text", "text": "Fixture settled 1"}]},
                ]
                with socket.socket(socket.AF_UNIX) as sock:
                    sock.settimeout(2)
                    sock.connect(str(path))
                    with sock.makefile("rb") as stream:
                        json.loads(stream.readline())
                        for name, data in (
                            ("get_messages", {"messages": expected_messages}),
                            ("get_session_context", {"context": {"messages": expected_messages,
                                "thinkingLevel": "off", "serviceTier": "default", "model": None}}),
                        ):
                            with self.subTest(command=name):
                                sock.sendall((json.dumps({"id": name, "clientId": "client",
                                    "command": {"type": name, "activeSessionId": "s1"}}) + "\n").encode())
                                self.assertEqual(json.loads(stream.readline()), {
                                    "type": "response", "id": name, "command": name,
                                    "success": True, "data": data})
                self.assertEqual(supervisor.errors, [])
                self.assertEqual(supervisor.prompts, [prompt])
                self.assertEqual(supervisor.accepted_prompts, [
                    {"id": "p1", "clientId": "client", "command": prompt}])
            finally:
                supervisor.close()


class ValidationDecisionTests(unittest.TestCase):
    def test_complete_shared_contracts_and_rust_extension_validate_without_full_parity(self):
        receipt = completed_observations()
        before = copy.deepcopy(receipt["results"])
        self.assertTrue(classify_validation(receipt))
        self.assertTrue(receipt["shared_contract_parity"])
        self.assertFalse(receipt["parity"])
        self.assertEqual(receipt["comparisons"]["rebind_close"]["status"], "not_comparable")
        self.assertFalse(receipt["comparisons"]["queued_close"]["same_wire_prompt_observations"])
        self.assertEqual(receipt["results"], before)

    def test_incomplete_shared_execution_fails_on_either_side(self):
        for kind in ("ts", "rust"):
            for name in ("queued_close", "refusal"):
                with self.subTest(kind=kind, name=name):
                    receipt = completed_observations()
                    receipt["results"][kind]["scenarios"][name]["executed"] = False
                    self.assertFalse(classify_validation(receipt))

    def test_changed_logical_acceptance_fails(self):
        receipt = completed_observations()
        receipt["results"]["ts"]["scenarios"]["queued_close"]["accepted_logical_messages"].append("sentinel")
        self.assertFalse(classify_validation(receipt))

    def test_shared_invariant_or_prompt_difference_fails(self):
        for kind in ("ts", "rust"):
            for name in ("queued_close", "refusal"):
                for field, value in (("invariant_passed", False), ("prompts", ["different"])):
                    with self.subTest(kind=kind, name=name, field=field):
                        receipt = completed_observations()
                        receipt["results"][kind]["scenarios"][name][field] = value
                        self.assertFalse(classify_validation(receipt))

    def test_missing_observations_fail_even_when_both_sides_omit_them(self):
        for name in ("queued_close", "refusal", "rebind_close"):
            for field in ("prompts", "accepted_logical_messages", "wire_prompt_messages"):
                with self.subTest(name=name, field=field):
                    receipt = completed_observations()
                    for kind in ("ts", "rust"):
                        del receipt["results"][kind]["scenarios"][name][field]
                    self.assertFalse(classify_validation(receipt))

    def test_unsupported_case_requires_the_exact_recorded_failure(self):
        for field, value in (("error", None), ("executed", True), ("invariant_passed", True)):
            with self.subTest(field=field):
                receipt = completed_observations()
                receipt["results"]["ts"]["scenarios"]["rebind_close"][field] = value
                self.assertFalse(classify_validation(receipt))

    def test_rust_rebind_must_execute_and_pass(self):
        for field in ("executed", "invariant_passed"):
            with self.subTest(field=field):
                receipt = completed_observations()
                receipt["results"]["rust"]["scenarios"]["rebind_close"][field] = False
                self.assertFalse(classify_validation(receipt))

    def test_unexpected_scenario_errors_fail_even_if_other_flags_are_green(self):
        for kind in ("ts", "rust"):
            for name in ("queued_close", "refusal", "rebind_close"):
                with self.subTest(kind=kind, name=name):
                    receipt = completed_observations()
                    receipt["results"][kind]["scenarios"][name]["error"] = "unexpected protocol failure"
                    self.assertFalse(classify_validation(receipt))

    def test_fixture_and_cleanup_errors_fail_on_every_scenario(self):
        for kind in ("ts", "rust"):
            for name in ("queued_close", "refusal", "rebind_close"):
                for field in ("fixture_errors", "cleanup_errors"):
                    with self.subTest(kind=kind, name=name, field=field):
                        receipt = completed_observations()
                        receipt["results"][kind]["scenarios"][name][field] = ["failed"]
                        self.assertFalse(classify_validation(receipt))

    def test_missing_results_fail(self):
        for kind in ("ts", "rust"):
            for name in ("queued_close", "refusal", "rebind_close"):
                with self.subTest(kind=kind, name=name):
                    receipt = completed_observations()
                    del receipt["results"][kind]["scenarios"][name]
                    self.assertFalse(classify_validation(receipt))
            receipt = completed_observations()
            del receipt["results"][kind]
            self.assertFalse(classify_validation(receipt))
        self.assertFalse(classify_validation({}))

    def test_preflight_or_binary_setup_errors_fail(self):
        receipt = completed_observations()
        receipt["preflight_error"] = "archive checksum mismatch"
        self.assertFalse(classify_validation(receipt))
        for kind in ("ts", "rust"):
            receipt = completed_observations()
            receipt["results"][kind]["error"] = "could not launch binary"
            self.assertFalse(classify_validation(receipt))


if __name__ == "__main__":
    unittest.main()
