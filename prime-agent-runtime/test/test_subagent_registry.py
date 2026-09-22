from __future__ import annotations

import asyncio
import importlib
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch


rlm_module = importlib.import_module("rlm")


class RlmSubagentRegistryTest(unittest.TestCase):
    def test_lists_parent_scoped_subagents_from_host(self) -> None:
        host_request = AsyncMock(
            return_value={
                "subagents": [
                    {
                        "rlm_child_id": "sub-a1b2c3d4",
                        "active_session_id": "active-child",
                        "session_id": "session-child",
                        "session_name": "subagent-check-api-a1b2c3d4",
                        "session_dir": "/tmp/parent/sub-a1b2c3d4",
                        "status": "completed",
                    }
                ]
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            subagents = asyncio.run(rlm_module.rlm.list_subagents())

        self.assertEqual(len(subagents), 1)
        self.assertEqual(subagents[0].rlm_child_id, "sub-a1b2c3d4")
        self.assertEqual(subagents[0].active_session_id, "active-child")
        self.assertEqual(subagents[0].session_id, "session-child")
        self.assertEqual(subagents[0].session_name, "subagent-check-api-a1b2c3d4")
        self.assertEqual(subagents[0].session_dir, Path("/tmp/parent/sub-a1b2c3d4"))
        self.assertEqual(subagents[0].status, "completed")
        host_request.assert_awaited_once_with("rlm.list_subagents")


    def test_lists_failed_subagents_from_host(self) -> None:
        host_request = AsyncMock(
            return_value={
                "subagents": [
                    {
                        "rlm_child_id": "sub-failed",
                        "active_session_id": None,
                        "session_id": None,
                        "session_name": "failed-worker",
                        "session_dir": "/tmp/parent/sub-failed",
                        "status": "error",
                    }
                ]
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            subagents = asyncio.run(rlm_module.rlm.list_subagents())

        self.assertEqual(subagents[0].status, "error")

    def test_forwards_orchestrator_chosen_name_and_model_to_host(self) -> None:
        host_request = AsyncMock(
            return_value={
                "rlm_child_id": "sub-a1b2c3d4",
                "name": "api-reviewer",
                "session_dir": "/tmp/parent/sub-a1b2c3d4",
                "model": "deepseek/deepseek-v4-flash",
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            result = asyncio.run(
                rlm_module.rlm.spawn(
                    "check the API",
                    name="api-reviewer",
                    model="deepseek/deepseek-v4-flash",
                )
            )

        host_request.assert_awaited_once_with(
            "rlm.run",
            {
                "prompt": "check the API",
                "kwargs": {
                    "name": "api-reviewer",
                    "model": "deepseek/deepseek-v4-flash",
                },
            },
        )
        self.assertEqual(result.rlm_child_id, "sub-a1b2c3d4")
        self.assertEqual(result.name, "api-reviewer")
        self.assertEqual(result.model, "deepseek/deepseek-v4-flash")

    def test_requires_an_explicit_child_name(self) -> None:
        host_request = AsyncMock()
        with patch.object(rlm_module, "host_request", host_request):
            with self.assertRaisesRegex(TypeError, r"missing 1 required keyword-only argument: 'name'"):
                asyncio.run(rlm_module.rlm.spawn("check the API"))
        host_request.assert_not_awaited()

    def test_rejects_calling_rlm_directly_with_spawn_guidance(self) -> None:
        for target in (rlm_module.rlm, rlm_module):
            with self.assertRaisesRegex(TypeError, r"not callable; spawn a child with: handle = await rlm\.spawn\("):
                target("check the API")
        for target in (rlm_module, rlm_module.rlm):
            with self.assertRaisesRegex(AttributeError, r"rlm\.run was renamed; spawn a child with: handle = await rlm\.spawn\("):
                target.run
            self.assertFalse(hasattr(target, "run"))

    def test_finds_authenticated_models_through_host(self) -> None:
        host_request = AsyncMock(
            return_value={
                "models": [
                    {
                        "provider": "anthropic",
                        "id": "claude-opus-4-7",
                        "name": "Claude Opus 4.7",
                        "selector": "anthropic/claude-opus-4-7",
                    }
                ]
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            models = asyncio.run(rlm_module.rlm.find_models("opus", limit=3))

        self.assertEqual(models[0].provider, "anthropic")
        self.assertEqual(models[0].id, "claude-opus-4-7")
        self.assertEqual(models[0].name, "Claude Opus 4.7")
        self.assertEqual(models[0].selector, "anthropic/claude-opus-4-7")
        host_request.assert_awaited_once_with(
            "rlm.find_models",
            {"query": "opus", "limit": 3},
        )

    def test_rejects_invalid_model_search_input_and_response(self) -> None:
        with self.assertRaisesRegex(TypeError, "query must be str"):
            asyncio.run(rlm_module.find_models(123))
        with self.assertRaisesRegex(TypeError, "limit must be int"):
            asyncio.run(rlm_module.find_models("opus", limit="3"))

        host_request = AsyncMock(return_value={"models": [{"provider": "anthropic"}]})
        with patch.object(rlm_module, "host_request", host_request):
            with self.assertRaisesRegex(RuntimeError, "invalid model entry"):
                asyncio.run(rlm_module.find_models("opus"))

    def test_deletes_subagent_by_name_through_host(self) -> None:
        deleted_payload = {
            "rlm_child_id": "sub-a1b2c3d4",
            "active_session_id": "active-child",
            "session_id": "session-child",
            "session_name": "api-reviewer",
            "session_dir": "/tmp/parent/sub-a1b2c3d4",
            "status": "completed",
        }
        host_request = AsyncMock(return_value={"subagent": deleted_payload})

        with patch.object(rlm_module, "host_request", host_request):
            deleted = asyncio.run(rlm_module.rlm.delete_subagent("  api-reviewer  "))

        self.assertEqual(deleted.rlm_child_id, "sub-a1b2c3d4")
        self.assertEqual(deleted.session_name, "api-reviewer")
        host_request.assert_awaited_once_with(
            "rlm.delete_subagent",
            {"target": "api-reviewer"},
        )

    def test_deletes_subagent_object_by_child_id(self) -> None:
        subagent = rlm_module.RLMSubagent(
            rlm_child_id="sub-a1b2c3d4",
            active_session_id=None,
            session_id="session-child",
            session_name="api-reviewer",
            session_dir=Path("/tmp/parent/sub-a1b2c3d4"),
            status="running",
        )
        host_request = AsyncMock(
            return_value={
                "subagent": {
                    "rlm_child_id": subagent.rlm_child_id,
                    "active_session_id": subagent.active_session_id,
                    "session_id": subagent.session_id,
                    "session_name": subagent.session_name,
                    "session_dir": str(subagent.session_dir),
                    "status": subagent.status,
                }
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            asyncio.run(rlm_module.delete_subagent(subagent))

        host_request.assert_awaited_once_with(
            "rlm.delete_subagent",
            {"target": "sub-a1b2c3d4"},
        )

    def test_deletes_subagent_by_spawn_handle(self) -> None:
        handle = rlm_module.RLMSpawnHandle(
            rlm_child_id="sub-a1b2c3d4",
            name="api-reviewer",
            session_dir=Path("/tmp/parent/sub-a1b2c3d4"),
            model="deepseek/deepseek-v4-flash",
        )
        deleted_payload = {
            "rlm_child_id": handle.rlm_child_id,
            "active_session_id": None,
            "session_id": None,
            "session_name": handle.name,
            "session_dir": str(handle.session_dir),
            "status": "completed",
        }
        host_request = AsyncMock(return_value={"subagent": deleted_payload})

        with patch.object(rlm_module, "host_request", host_request):
            deleted = asyncio.run(rlm_module.rlm.delete_subagent(handle))

        self.assertEqual(deleted.rlm_child_id, handle.rlm_child_id)
        self.assertEqual(deleted.session_name, handle.name)
        host_request.assert_awaited_once_with(
            "rlm.delete_subagent",
            {"target": "sub-a1b2c3d4"},
        )

    def test_rejects_invalid_delete_response_and_target(self) -> None:
        host_request = AsyncMock(return_value={"subagent": {"status": "completed"}})

        with patch.object(rlm_module, "host_request", host_request):
            with self.assertRaisesRegex(RuntimeError, "rlm.delete_subagent entry is missing rlm_child_id"):
                asyncio.run(rlm_module.delete_subagent("api-reviewer"))

        with self.assertRaisesRegex(ValueError, "target must not be empty"):
            asyncio.run(rlm_module.delete_subagent("   "))
        with self.assertRaisesRegex(TypeError, "target must be RLMSpawnHandle, RLMSubagent, or str"):
            asyncio.run(rlm_module.delete_subagent(123))

    def test_rejects_invalid_registry_payload(self) -> None:
        host_request = AsyncMock(return_value={"subagents": [{"status": "completed"}]})

        with patch.object(rlm_module, "host_request", host_request):
            with self.assertRaisesRegex(RuntimeError, "missing rlm_child_id"):
                asyncio.run(rlm_module.list_subagents())

    def test_requires_a_default_session_name(self) -> None:
        host_request = AsyncMock(
            return_value={
                "subagents": [
                    {
                        "rlm_child_id": "sub-a1b2c3d4",
                        "active_session_id": None,
                        "session_id": "session-child",
                        "session_dir": "/tmp/parent/sub-a1b2c3d4",
                        "status": "running",
                    }
                ]
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            with self.assertRaisesRegex(RuntimeError, "missing session_name"):
                asyncio.run(rlm_module.list_subagents())


class RlmProgressNoteTest(unittest.TestCase):
    def test_progress_note_round_trips_an_accepted_note(self) -> None:
        host_request = AsyncMock(return_value={"accepted": True})

        with patch.object(rlm_module, "host_request", host_request):
            result = asyncio.run(rlm_module.rlm.progress_note("building tests"))

        self.assertTrue(result.accepted)
        self.assertIsNone(result.retry_after_ms)
        host_request.assert_awaited_once_with("rlm.progress.note", {"message": "building tests"})

    def test_progress_note_returns_the_throttle_hint(self) -> None:
        host_request = AsyncMock(return_value={"accepted": False, "retry_after_ms": 7000})

        with patch.object(rlm_module, "host_request", host_request):
            result = asyncio.run(rlm_module.rlm.progress_note("second note"))

        self.assertFalse(result.accepted)
        self.assertEqual(result.retry_after_ms, 7000)

    def test_progress_note_validates_the_message(self) -> None:
        with self.assertRaisesRegex(TypeError, "message must be str"):
            asyncio.run(rlm_module.rlm.progress_note(42))
        with self.assertRaisesRegex(ValueError, "empty"):
            asyncio.run(rlm_module.rlm.progress_note("   "))
        with self.assertRaisesRegex(ValueError, "at most 512"):
            asyncio.run(rlm_module.rlm.progress_note("x" * 513))
        # At the bound the message is accepted.
        host_request = AsyncMock(return_value={"accepted": True})
        with patch.object(rlm_module, "host_request", host_request):
            result = asyncio.run(rlm_module.rlm.progress_note("x" * 512))
        self.assertTrue(result.accepted)

    def test_progress_note_measures_utf16_length_at_the_boundary(self) -> None:
        # 512 astral characters are 1024 UTF-16 code units under the host's
        # message.length measure, so they must fail validation before the call.
        with self.assertRaisesRegex(ValueError, "at most 512"):
            asyncio.run(rlm_module.rlm.progress_note("🎉" * 512))
        # A BMP character plus one astral character crosses the same bound.
        with self.assertRaisesRegex(ValueError, "at most 512"):
            asyncio.run(rlm_module.rlm.progress_note("a" * 511 + "🎉"))

        # 256 astral characters are exactly 512 UTF-16 code units: accepted.
        host_request = AsyncMock(return_value={"accepted": True})
        with patch.object(rlm_module, "host_request", host_request):
            result = asyncio.run(rlm_module.rlm.progress_note("🎉" * 256))

        self.assertTrue(result.accepted)
        host_request.assert_awaited_once_with("rlm.progress.note", {"message": "🎉" * 256})

        # Lone surrogates are valid Python strings that json.dumps escapes and
        # the host accepts, so each must count as one UTF-16 code unit, not raise.
        host_request = AsyncMock(return_value={"accepted": True})
        with patch.object(rlm_module, "host_request", host_request):
            result = asyncio.run(rlm_module.rlm.progress_note("\ud800"))
        self.assertTrue(result.accepted)
        host_request.assert_awaited_once_with("rlm.progress.note", {"message": "\ud800"})
        with self.assertRaisesRegex(ValueError, "at most 512"):
            asyncio.run(rlm_module.rlm.progress_note("\ud800" * 513))

    def test_progress_note_rejects_invalid_payloads(self) -> None:
        host_request = AsyncMock(return_value={"retry_after_ms": 1000})
        with patch.object(rlm_module, "host_request", host_request):
            with self.assertRaisesRegex(RuntimeError, "accepted"):
                asyncio.run(rlm_module.rlm.progress_note("note"))

        host_request = AsyncMock(return_value={"accepted": True, "retry_after_ms": "soon"})
        with patch.object(rlm_module, "host_request", host_request):
            with self.assertRaisesRegex(RuntimeError, "retry_after_ms"):
                asyncio.run(rlm_module.rlm.progress_note("note"))


class RlmSubagentExtrasTest(unittest.TestCase):
    def test_lists_live_state_extras_from_host(self) -> None:
        host_request = AsyncMock(
            return_value={
                "subagents": [
                    {
                        "rlm_child_id": "sub-a1b2c3d4",
                        "active_session_id": None,
                        "session_id": "session-child",
                        "session_name": "worker-a",
                        "session_dir": "/tmp/parent/sub-a1b2c3d4",
                        "status": "running",
                        "activity": {"kind": "executing", "tool_name": "ipython"},
                        "tool_use_count": 3,
                        "duration_ms": 4321,
                        "answer_preview": "task finished cleanly",
                        "replied_since_task": False,
                        "progress_note": "halfway done",
                        "label": "slow task",
                        "last_activity_at": 1757700000000,
                        "activity_stale_ms": None,
                    }
                ]
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            subagents = asyncio.run(rlm_module.list_subagents())

        self.assertEqual(len(subagents), 1)
        entry = subagents[0]
        self.assertEqual(entry.activity.kind, "executing")
        self.assertEqual(entry.activity.tool_name, "ipython")
        self.assertEqual(entry.tool_use_count, 3)
        self.assertEqual(entry.duration_ms, 4321)
        self.assertEqual(entry.answer_preview, "task finished cleanly")
        self.assertFalse(entry.replied_since_task)
        self.assertEqual(entry.progress_note, "halfway done")
        self.assertEqual(entry.label, "slow task")
        self.assertEqual(entry.last_activity_at, 1757700000000)
        self.assertIsNone(entry.activity_stale_ms)

    def test_accepts_entries_missing_optional_extras(self) -> None:
        host_request = AsyncMock(
            return_value={
                "subagents": [
                    {
                        "rlm_child_id": "sub-old",
                        "active_session_id": None,
                        "session_id": None,
                        "session_name": "worker-old",
                        "session_dir": "/tmp/parent/sub-old",
                        "status": "completed",
                    }
                ]
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            subagents = asyncio.run(rlm_module.list_subagents())

        entry = subagents[0]
        self.assertIsNone(entry.activity)
        self.assertIsNone(entry.tool_use_count)
        self.assertIsNone(entry.duration_ms)
        self.assertIsNone(entry.answer_preview)
        self.assertIsNone(entry.replied_since_task)
        self.assertIsNone(entry.progress_note)
        self.assertIsNone(entry.label)
        self.assertIsNone(entry.last_activity_at)
        self.assertIsNone(entry.activity_stale_ms)

    def test_rejects_invalid_extras(self) -> None:
        base_entry = {
            "rlm_child_id": "sub-x",
            "active_session_id": None,
            "session_id": None,
            "session_name": "worker-x",
            "session_dir": "/tmp/parent/sub-x",
            "status": "running",
        }
        for extras, pattern in (
            ({"activity": {"kind": "nonsense"}}, "invalid activity kind"),
            ({"activity": {"kind": "executing", "tool_name": 7}}, "invalid activity tool_name"),
            ({"tool_use_count": "three"}, "invalid tool_use_count"),
            ({"replied_since_task": "no"}, "invalid replied_since_task"),
            ({"progress_note": 42}, "invalid progress_note"),
            ({"last_activity_at": "soon"}, "invalid last_activity_at"),
        ):
            with self.subTest(extras=extras):
                host_request = AsyncMock(return_value={"subagents": [{**base_entry, **extras}]})
                with patch.object(rlm_module, "host_request", host_request):
                    with self.assertRaisesRegex(RuntimeError, pattern):
                        asyncio.run(rlm_module.list_subagents())


if __name__ == "__main__":
    unittest.main()

class RlmCollectTest(unittest.TestCase):
    def test_collect_all_children_returns_typed_results(self) -> None:
        host_request = AsyncMock(
            return_value={
                "results": [
                    {
                        "rlm_child_id": "sub-a1b2c3d4",
                        "session_name": "worker-a",
                        "session_dir": "/tmp/parent/sub-a1b2c3d4",
                        "status": "done",
                        "settled": True,
                        "answer_preview": "task finished cleanly",
                        "error": None,
                        "duration_ms": 4321,
                        "tool_use_count": 3,
                        "replied_since_task": False,
                    },
                    {
                        "rlm_child_id": "sub-b2c3d4e5",
                        "session_name": "worker-b",
                        "session_dir": "/tmp/parent/sub-b2c3d4e5",
                        "status": "running",
                        "settled": False,
                        "answer_preview": None,
                        "error": None,
                        "duration_ms": None,
                        "tool_use_count": None,
                        "replied_since_task": None,
                    },
                ]
            }
        )

        with patch.object(rlm_module, "host_request", host_request):
            results = asyncio.run(rlm_module.rlm.collect())

        self.assertEqual(len(results), 2)
        done = results[0]
        self.assertEqual(done.rlm_child_id, "sub-a1b2c3d4")
        self.assertEqual(done.session_name, "worker-a")
        self.assertEqual(done.session_dir, Path("/tmp/parent/sub-a1b2c3d4"))
        self.assertEqual(done.status, "done")
        self.assertTrue(done.settled)
        self.assertEqual(done.answer_preview, "task finished cleanly")
        self.assertIsNone(done.error)
        self.assertEqual(done.duration_ms, 4321)
        self.assertEqual(done.tool_use_count, 3)
        self.assertFalse(done.replied_since_task)
        running = results[1]
        self.assertEqual(running.status, "running")
        self.assertFalse(running.settled)
        self.assertIsNone(running.answer_preview)
        host_request.assert_awaited_once_with("rlm.collect", {"targets": [], "timeout_ms": 0})

    def test_collect_normalizes_spawn_handles_and_names(self) -> None:
        host_request = AsyncMock(return_value={"results": []})
        handle = rlm_module.RLMSpawnHandle(
            rlm_child_id="sub-h1",
            name="worker-h",
            session_dir=Path("/tmp/parent/sub-h1"),
            model="anthropic/claude-sonnet-4-5",
        )

        with patch.object(rlm_module, "host_request", host_request):
            results = asyncio.run(rlm_module.rlm.collect([handle, "worker-b"], timeout_ms=250))

        self.assertEqual(results, [])
        host_request.assert_awaited_once_with(
            "rlm.collect", {"targets": ["sub-h1", "worker-b"], "timeout_ms": 250}
        )

    def test_collect_accepts_single_spawn_handle_and_subagent_row(self) -> None:
        handle = rlm_module.RLMSpawnHandle(
            rlm_child_id="sub-h1",
            name="worker-h",
            session_dir=Path("/tmp/parent/sub-h1"),
            model="anthropic/claude-sonnet-4-5",
        )
        subagent = rlm_module.RLMSubagent(
            rlm_child_id="sub-r1",
            active_session_id=None,
            session_id="session-child",
            session_name="worker-r",
            session_dir=Path("/tmp/parent/sub-r1"),
            status="running",
        )

        for target, expected_selector in ((handle, "sub-h1"), (subagent, "sub-r1")):
            host_request = AsyncMock(return_value={"results": []})
            with patch.object(rlm_module, "host_request", host_request):
                results = asyncio.run(rlm_module.rlm.collect(target))

            self.assertEqual(results, [])
            host_request.assert_awaited_once_with(
                "rlm.collect", {"targets": [expected_selector], "timeout_ms": 0}
            )

    def test_collect_validates_arguments(self) -> None:
        with self.assertRaisesRegex(TypeError, "timeout_ms"):
            asyncio.run(rlm_module.rlm.collect(timeout_ms=-1))
        with self.assertRaisesRegex(TypeError, "timeout_ms"):
            asyncio.run(rlm_module.rlm.collect(timeout_ms="soon"))
        with self.assertRaisesRegex(TypeError, "targets must be"):
            asyncio.run(rlm_module.rlm.collect(42))
        with self.assertRaisesRegex(TypeError, "collect target"):
            asyncio.run(rlm_module.rlm.collect(["ok", ""]))

    def test_collect_rejects_invalid_payloads(self) -> None:
        host_request = AsyncMock(return_value={"results": [{"rlm_child_id": "sub-x", "status": "nonsense"}]})

        with patch.object(rlm_module, "host_request", host_request):
            with self.assertRaisesRegex(RuntimeError, "invalid status"):
                asyncio.run(rlm_module.rlm.collect())
