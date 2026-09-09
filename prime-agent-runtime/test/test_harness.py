from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from rlm import harness as package_harness
from rlm import rlm as callable_rlm
from rlm.harness import HarnessState, get_harness_state

PYTHON_REFERENCE = {
    "type": "python",
    "import": "agent_skills.example",
    "callable": "run",
    "call_pattern": "await run(...)",
}


class HarnessStateTest(unittest.TestCase):
    def test_crud_for_all_entry_kinds(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            created = {
                "prompt": state.create_memory(
                    "Prompt note",
                    "Prompt content",
                    id="prompt_entry",
                    topic="prompt/topic",
                    metadata={"kind": "prompt"},
                    kind="prompt",
                ),
                "memory": state.create_memory(
                    "Memory",
                    "Memory content",
                    id="memory_entry",
                    topic="memory/topic",
                    metadata={"kind": "memory"},
                ),
                "skill": state.create_memory(
                    "Skill",
                    "Skill content",
                    id="skill_entry",
                    topic="skill/topic",
                    reference=PYTHON_REFERENCE,
                    arguments={"target": {"type": "string", "required": True}},
                    metadata={"kind": "skill"},
                    kind="skill",
                ),
                "subagent": state.create_memory(
                    "Subagent",
                    "Subagent content",
                    id="subagent_entry",
                    topic="subagent/topic",
                    metadata={"kind": "subagent"},
                    kind="subagent",
                ),
            }

            for kind, entry in created.items():
                self.assertEqual(entry.kind, kind)
                self.assertIn("content", state.get(kind, entry.id).content.lower())
                self.assertIn(entry, state.list(kind))

            state.update_memory("prompt_entry", "Prompt note", "Prompt content updated", kind="prompt")
            state.update_memory("memory_entry", "Memory", "Memory content updated")
            state.update_memory(
                "skill_entry",
                "Skill",
                "Skill content updated",
                reference=PYTHON_REFERENCE,
                arguments={"target": {"type": "string", "required": True}, "mode": {"type": "string"}},
                kind="skill",
            )
            state.update_memory("subagent_entry", "Subagent", "Subagent content updated", kind="subagent")

            for kind in ("prompt", "memory", "skill", "subagent"):
                entry_id = f"{kind}_entry"
                self.assertEqual(state.get(kind, entry_id).version, 2)
                self.assertIn("updated", state.get(kind, entry_id).content)
                self.assertTrue(state.delete_memory(entry_id, kind=kind))
                self.assertIsNone(state.get(kind, entry_id))
                self.assertFalse(state.delete_memory(entry_id, kind=kind))

            self.assertEqual(state.list(), [])

    def test_create_defaults_and_skill_only_fields(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            default_entry = state.create_memory("Default", "No kind given.")
            self.assertEqual(default_entry.kind, "memory")
            self.assertEqual(default_entry.topic, "general")
            self.assertEqual(state.create_memory("Note", "Policy note.", kind="prompt").topic, "policy")

            for kind in ("memory", "prompt", "subagent"):
                with self.assertRaisesRegex(ValueError, "only accepted for kind='skill'"):
                    state.create_memory("Bad", "content", id=f"bad_{kind}", kind=kind, reference=PYTHON_REFERENCE)
                with self.assertRaisesRegex(ValueError, "only accepted for kind='skill'"):
                    state.create_memory("Bad", "content", id=f"bad_{kind}", kind=kind, arguments={})
                with self.assertRaisesRegex(ValueError, "only accepted for kind='skill'"):
                    state.update_memory(default_entry.id, "Bad", "content", kind=kind, arguments={})

            # An unknown kind is reported as such, not as a skill-only field error.
            with self.assertRaisesRegex(ValueError, "unknown harness kind 'tool'"):
                state.create_memory("Bad", "content", kind="tool", reference=PYTHON_REFERENCE)

    def test_the_common_old_call_form_still_works_and_path_names_its_replacement(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            entry = state.create_memory("Durable fact", "Unchanged call form.")
            self.assertEqual((entry.kind, entry.topic), ("memory", "general"))

            with self.assertRaisesRegex(TypeError, "path was renamed to topic"):
                state.create_memory("Grouped", "content", id="grouped", **{"path": "repo/testing"})

    def test_removed_harness_methods_name_their_replacement(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            for name, message in (
                (
                    "record_refinement",
                    "record_refinement was removed; refinement events are recorded automatically when refinements run",
                ),
                ("plan_refinement", "plan_refinement was removed; use await refine.run() to schedule a refinement"),
            ):
                with self.assertRaises(AttributeError) as caught:
                    getattr(state, name)
                self.assertEqual(str(caught.exception), message)

            for name, replacement in (
                ("update_skill", "update_memory(..., kind='skill')"),
                ("delete_prompt_note", "delete_memory(..., kind='prompt')"),
                ("create_subagent", "create_memory(..., kind='subagent')"),
            ):
                with self.assertRaises(AttributeError) as caught:
                    getattr(state, name)
                self.assertEqual(
                    str(caught.exception), f"{name} was removed; use rlm.harness.{replacement}"
                )

    def test_entries_that_store_the_grouping_as_path_load_and_resave_as_topic(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "harness_state.json"
            state_path.write_text(
                json.dumps(
                    {
                        "schema": 1,
                        "entries": {
                            "memory": {
                                "legacy": {
                                    "id": "legacy",
                                    "kind": "memory",
                                    "title": "Legacy",
                                    "content": "Stored with the older field name.",
                                    "path": "repo/testing",
                                }
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )

            state = HarnessState(state_path)
            self.assertEqual(state.get("memory", "legacy").topic, "repo/testing")

            state.update_memory("legacy", "Legacy", "Resaved by the current writer.")
            saved = json.loads(state_path.read_text(encoding="utf-8"))["entries"]["memory"]["legacy"]
            self.assertEqual(saved["topic"], "repo/testing")
            # The mirror keeps a pre-topic writer from resaving the entry ungrouped.
            self.assertEqual(saved["path"], "repo/testing")

    def test_grouping_survives_a_writer_that_only_knows_the_path_field(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "harness_state.json"
            HarnessState(state_path).create_memory("Grouped", "content", id="grouped", topic="repo/testing")

            # A pre-topic build rewrites the file and drops fields it does not know.
            saved = json.loads(state_path.read_text(encoding="utf-8"))
            entry = saved["entries"]["memory"]["grouped"]
            saved["entries"]["memory"]["grouped"] = {key: value for key, value in entry.items() if key != "topic"}
            state_path.write_text(json.dumps(saved), encoding="utf-8")

            self.assertEqual(HarnessState(state_path).get("memory", "grouped").topic, "repo/testing")

    def test_delete_and_update_name_the_kind_an_id_actually_has(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory("Policy note", "content", id="cadence", kind="prompt")

            for mutate in (
                lambda: state.delete_memory("cadence"),
                lambda: state.update_memory("cadence", "Policy note", "new content"),
            ):
                with self.assertRaisesRegex(ValueError, "entry 'cadence' is kind='prompt'; pass kind='prompt'"):
                    mutate()

            self.assertIsNotNone(state.get("prompt", "cadence"))
            # A plain miss still reports absence rather than a mismatch.
            self.assertFalse(state.delete_memory("absent"))

    def test_engine_recorded_refinements_survive_a_kernel_save(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "harness_state.json"
            kernel_state = HarnessState(state_path)
            kernel_state.create_memory("Kernel note", "Written before the refinement.", id="kernel")

            # The refinement engine rewrites the same file from the host process.
            engine_write = json.loads(state_path.read_text(encoding="utf-8"))
            engine_write["refinements"] = [
                {"id": "refine_1", "trigger": "engine pass", "changes": ["create memory:kernel"]}
            ]
            state_path.write_text(json.dumps(engine_write), encoding="utf-8")
            # Guarantee the mtime advances even on coarse-resolution filesystems.
            future = state_path.stat().st_mtime + 5
            os.utime(state_path, (future, future))

            kernel_state.create_memory("Later note", "Written after the refinement.", id="later")

            reloaded = HarnessState(state_path)
            self.assertEqual([event.id for event in reloaded.refinements], ["refine_1"])
            self.assertIsNotNone(reloaded.get("memory", "later"))
            self.assertIn("refinements: 1", reloaded.overview())

    def test_persists_entries(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            memory = state.create_memory(
                "Prefer focused patches",
                "Small harness updates are easier to validate than broad rewrites.",
                topic="engineering",
            )
            skill = state.create_memory(
                "Check failures first",
                "Inspect current failure evidence before editing code.",
                id="failure_first",
                reference=PYTHON_REFERENCE,
                arguments={"failure_log": {"type": "string", "description": "Current failure evidence."}},
                kind="skill",
            )
            subagent = state.create_memory(
                "Reviewer",
                "Review the proposed patch for regressions and missing tests.",
                metadata={"max_turns": 3},
                kind="subagent",
            )
            state.create_memory("Refinement cadence", "Refine only after repeated evidence.", kind="prompt")

            reloaded = HarnessState(state.file_path)

            self.assertEqual(reloaded.get("memory", memory.id).content, memory.content)
            self.assertEqual(reloaded.get("skill", skill.id).version, 1)
            self.assertEqual(reloaded.get("skill", skill.id).arguments["failure_log"]["type"], "string")
            self.assertEqual(reloaded.get("subagent", subagent.id).metadata["max_turns"], 3)
            self.assertIn("Prefer focused patches", reloaded.overview())
            self.assertIn(
                "Call contract: installed Python skills use await <skill_import>(...)",
                reloaded.overview(),
            )
            overview = reloaded.overview()
            self.assertIn("handle = await rlm('sub-task')", overview)
            self.assertIn("never the child's answer", overview)
            self.assertIn("receiver_role='parent'", overview)
            self.assertIn("await rlm.list_subagents()", overview)
            self.assertIn("receiver_role='child'", overview)
            self.assertIn("(engineering, v1)", overview)

    def test_save_failure_preserves_previous_state_on_disk(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory("Durable fact", "Written before the crash.")

            crashing = HarnessState(state.file_path)
            original_dump = json.dump

            def torn_dump(data: object, fh: object, **kwargs: object) -> None:
                fh.write('{"schema": 1, "entr')  # type: ignore[attr-defined]
                raise OSError("disk full")

            json.dump = torn_dump  # type: ignore[assignment]
            try:
                with self.assertRaises(OSError):
                    crashing.create_memory("Doomed fact", "Interrupted mid-write.")
            finally:
                json.dump = original_dump

            # The interrupted save must not have truncated the durable state.
            reloaded = HarnessState(state.file_path)
            titles = [entry.title for entry in reloaded.entries["memory"].values()]
            self.assertEqual(titles, ["Durable fact"])

    @unittest.skipIf(os.name == "nt", "POSIX mode bits and umask")
    def test_save_preserves_existing_mode_despite_umask(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory("First", "Creates the file.")
            os.chmod(state.file_path, 0o666)
            previous_umask = os.umask(0o022)
            try:
                state.create_memory("Second", "Replaces the file.")
            finally:
                os.umask(previous_umask)

            self.assertEqual(os.stat(state.file_path).st_mode & 0o777, 0o666)

    @unittest.skipIf(os.name == "nt", "POSIX mode bits and umask")
    def test_save_new_file_keeps_restrictive_umask(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            previous_umask = os.umask(0o777)
            try:
                state.create_memory("First", "Creates the file.")
            finally:
                os.umask(previous_umask)

            self.assertEqual(os.stat(state.file_path).st_mode & 0o777, 0)

    def test_save_preserves_restrictive_file_mode(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory("First", "Creates the file.")
            os.chmod(state.file_path, 0o600)

            state.create_memory("Second", "Replaces the file.")

            self.assertEqual(os.stat(state.file_path).st_mode & 0o777, 0o600)

    def test_save_temp_file_is_never_looser_than_the_destination(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory("First", "Creates the file.")
            os.chmod(state.file_path, 0o600)

            observed_modes: list[int] = []
            original_open = os.open

            def observing_open(path: object, flags: int, mode: int = 0o777, **kwargs: object) -> int:
                if str(path).endswith(".tmp"):
                    observed_modes.append(mode)
                return original_open(path, flags, mode, **kwargs)

            os.open = observing_open  # type: ignore[assignment]
            try:
                state.create_memory("Second", "Replaces the file.")
            finally:
                os.open = original_open

            self.assertEqual(observed_modes, [0o600])
            self.assertEqual(os.stat(state.file_path).st_mode & 0o777, 0o600)

    def test_save_writes_through_a_symlinked_state_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            real_path = Path(temp_dir) / "real_state.json"
            alias = Path(temp_dir) / "harness_state.json"
            HarnessState(real_path).create_memory("Seed", "Creates the real file.")
            alias.symlink_to(real_path)

            state = HarnessState(alias)
            state.create_memory("Through alias", "Must land in the real file.")

            self.assertTrue(alias.is_symlink())
            titles = [entry.title for entry in HarnessState(real_path).entries["memory"].values()]
            self.assertEqual(titles, ["Seed", "Through alias"])

    def test_load_ignores_unknown_json_keys(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "harness_state.json"
            state_path.write_text(
                json.dumps(
                    {
                        "schema": 1,
                        "entries": {
                            "memory": {
                                "known": {
                                    "id": "mismatched",
                                    "kind": "skill",
                                    "title": "Known memory",
                                    "content": "Loaded despite extra keys.",
                                    "path": 123,
                                    "source": None,
                                    "version": "2",
                                    "metadata": "not a dict",
                                    "unexpected": True,
                                },
                                "missing_content": {
                                    "title": "Missing content",
                                }
                            }
                        },
                        "refinements": [
                            {
                                "id": "refine_extra",
                                "trigger": "extra keys",
                                "changes": [1, "loaded"],
                                "ignored": "value",
                            },
                            {
                                "id": "refine_missing_changes",
                                "trigger": "missing changes",
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            state = HarnessState(state_path)

            self.assertEqual(state.get("memory", "known").content, "Loaded despite extra keys.")
            self.assertEqual(state.get("memory", "known").id, "known")
            self.assertEqual(state.get("memory", "known").kind, "memory")
            self.assertEqual(state.get("memory", "known").topic, "general")
            self.assertEqual(state.get("memory", "known").source, "agent")
            self.assertIsNone(state.get("memory", "mismatched"))
            self.assertEqual(state.get("memory", "known").version, 2)
            self.assertEqual(state.get("memory", "known").metadata, {})
            self.assertIsNone(state.get("memory", "missing_content"))
            self.assertEqual(state.refinements[0].id, "refine_extra")
            self.assertEqual(state.refinements[0].changes, ["1", "loaded"])
            self.assertEqual(len(state.refinements), 1)
            self.assertIn("1, loaded", state.overview())

            updated = state.update_memory("known", "Known memory", "Updated content.")
            self.assertEqual(updated.version, 3)

    def test_skill_arguments_are_first_class(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            created = state.create_memory(
                "Edit file",
                "Apply a targeted edit.",
                id="edit_file",
                reference={
                    "type": "python",
                    "import": "agent_skills.file_edit",
                    "callable": "file_edit",
                    "call_pattern": "await file_edit(path=..., find=..., replace=...)",
                },
                arguments={
                    "path": {"type": "string", "required": True},
                    "find": {"type": "string", "required": True},
                    "replace": {"type": "string", "required": True},
                },
                kind="skill",
            )
            updated = state.update_memory(
                "edit_file",
                "Edit file",
                "Apply a targeted edit after reading context.",
                reference={
                    "type": "python",
                    "import": "agent_skills.file_edit",
                    "callable": "file_edit",
                    "call_pattern": "await file_edit(path=..., find=..., replace=...)",
                },
                arguments={
                    "path": {"type": "string", "required": True},
                    "find": {"type": "string", "required": True},
                    "replace": {"type": "string", "required": True},
                    "validate": {"type": "boolean", "default": True},
                },
                kind="skill",
            )
            reloaded = HarnessState(state.file_path)

            self.assertEqual(created.arguments["path"]["required"], True)
            self.assertEqual(created.reference["type"], "python")
            self.assertEqual(updated.version, 2)
            self.assertEqual(reloaded.get("skill", "edit_file").arguments["validate"]["default"], True)
            self.assertEqual(reloaded.get("skill", "edit_file").reference["import"], "agent_skills.file_edit")
            self.assertIn('"path"', reloaded.overview())
            self.assertIn("agent_skills", reloaded.overview())

    def test_skill_references_must_be_python(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            with self.assertRaisesRegex(ValueError, "Python reference"):
                state.create_memory("No reference", "missing", arguments={}, kind="skill")
            with self.assertRaisesRegex(ValueError, "reference.type must be 'python'"):
                state.create_memory(
                    "Shell reference",
                    "bad",
                    reference={"type": "shell", "command": "edit"},
                    arguments={},
                    kind="skill",
                )
            with self.assertRaisesRegex(ValueError, "Python import"):
                state.create_memory("No import", "bad", reference={"type": "python", "callable": "run"}, arguments={}, kind="skill")
            with self.assertRaisesRegex(ValueError, "callable or call_pattern"):
                state.create_memory(
                    "No callable",
                    "bad",
                    reference={"type": "python", "import": "agent_skills.bad"},
                    arguments={},
                    kind="skill",
                )

    def test_load_tolerates_corrupt_or_non_object_state(self) -> None:
        for payload in ("not json at all", "null", "[]", '"a string"', "123"):
            with tempfile.TemporaryDirectory() as temp_dir:
                state_path = Path(temp_dir) / "harness_state.json"
                state_path.write_text(payload, encoding="utf-8")

                state = HarnessState(state_path)

                self.assertEqual(state.list(), [])
                self.assertEqual(state.refinements, [])
                # The store must remain usable and self-heal on the next write.
                created = state.create_memory("Recovered", "Works after corruption.", id="recovered")
                self.assertEqual(HarnessState(state_path).get("memory", "recovered").content, created.content)

    def test_update_skill_preserves_omitted_arguments(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory(
                "Edit file",
                "Apply an edit.",
                id="edit_file",
                reference=PYTHON_REFERENCE,
                arguments={"path": {"type": "string", "required": True}},
                kind="skill",
            )

            # Updating only title/content (arguments omitted) must keep the contract.
            state.update_memory("edit_file", "Edit file", "Apply an edit carefully.", reference=PYTHON_REFERENCE, kind="skill")
            self.assertEqual(state.get("skill", "edit_file").arguments, {"path": {"type": "string", "required": True}})

            # An explicit empty dict still clears it.
            state.update_memory(
                "edit_file", "Edit file", "Now argument-free.", reference=PYTHON_REFERENCE, arguments={}, kind="skill"
            )
            self.assertEqual(state.get("skill", "edit_file").arguments, {})

    def test_update_skill_without_reference_preserves_contract(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory(
                "Edit file",
                "Apply an edit.",
                id="edit_file",
                reference=PYTHON_REFERENCE,
                arguments={"path": {"type": "string", "required": True}},
                kind="skill",
            )

            # A title/content-only update must not require re-sending the reference,
            # and must preserve the existing reference and arguments.
            updated = state.update_memory("edit_file", "Edit file", "Apply an edit carefully.", kind="skill")

            self.assertEqual(updated.version, 2)
            self.assertEqual(updated.reference, PYTHON_REFERENCE)
            self.assertEqual(updated.arguments, {"path": {"type": "string", "required": True}})
            self.assertEqual(updated.content, "Apply an edit carefully.")

    def test_update_preserves_omitted_topic(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory("Grouped", "content", id="grouped", topic="repo/testing")

            # Updating without a topic keeps the custom grouping topic.
            state.update_memory("grouped", "Grouped", "new content")
            self.assertEqual(state.get("memory", "grouped").topic, "repo/testing")

            # An explicit topic still moves it.
            state.update_memory("grouped", "Grouped", "newer", topic="repo/other")
            self.assertEqual(state.get("memory", "grouped").topic, "repo/other")

    def test_in_memory_state_never_touches_disk(self) -> None:
        previous = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            os.environ["RLM_HARNESS_STATE_DIR"] = temp_dir
            os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
            try:
                state = HarnessState(in_memory=True)
                created = state.create_memory("Volatile", "in memory only", id="volatile")

                self.assertIsNone(state.file_path)
                self.assertEqual(created.content, "in memory only")
                self.assertEqual(state.get("memory", "volatile").content, "in memory only")
                # Local in-memory operations do not resolve or persist a path.
                self.assertEqual(list(Path(temp_dir).iterdir()), [])
            finally:
                if previous is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

    def test_in_memory_state_global_flag_uses_global_env_store(self) -> None:
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            global_dir = Path(temp_dir) / "global"
            os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = str(global_dir)
            try:
                state = HarnessState(in_memory=True)
                global_entry = state.create_memory("Global note", "persisted", id="global_note", global_=True)
            finally:
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

            self.assertIsNone(state.file_path)
            self.assertEqual(global_entry.scope, "global")
            self.assertEqual(global_entry.content, "persisted")
            self.assertIsNone(state.get("memory", "global_note"))
            self.assertEqual(
                HarnessState(global_dir / "harness_state.json", scope="global").get("memory", "global_note").content,
                "persisted",
            )

    def test_in_memory_state_global_flag_uses_default_global_store(self) -> None:
        previous_agent_dir = os.environ.get("PRIME_AGENT_CODING_AGENT_DIR")
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            agent_dir = Path(temp_dir) / "agent"
            os.environ["PRIME_AGENT_CODING_AGENT_DIR"] = str(agent_dir)
            os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
            try:
                state = HarnessState(in_memory=True)
                global_entry = state.create_memory("Default global", "persisted", id="default_global", global_=True)
            finally:
                if previous_agent_dir is None:
                    os.environ.pop("PRIME_AGENT_CODING_AGENT_DIR", None)
                else:
                    os.environ["PRIME_AGENT_CODING_AGENT_DIR"] = previous_agent_dir
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

            self.assertIsNone(state.file_path)
            self.assertEqual(global_entry.scope, "global")
            self.assertIsNone(state.get("memory", "default_global"))
            self.assertEqual(
                HarnessState(agent_dir / "harness" / "harness_state.json", scope="global")
                .get("memory", "default_global")
                .content,
                "persisted",
            )

    def test_reloads_external_writes_before_mutating(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "harness_state.json"
            kernel_state = HarnessState(state_path)
            kernel_state.create_memory("Kernel note", "Written from the kernel.", id="kernel")

            # Simulate the host /refine command rewriting the same file from another
            # process. A second instance loads the current file, adds an entry, saves.
            host_state = HarnessState(state_path)
            host_state.create_memory("Host note", "Written by /refine.", id="host")
            # Guarantee the mtime advances even on coarse-resolution filesystems.
            future = state_path.stat().st_mtime + 5
            os.utime(state_path, (future, future))

            # A read on the long-lived kernel state must observe the host write.
            self.assertEqual(kernel_state.get("memory", "host").content, "Written by /refine.")

            # A mutation must merge onto the host write instead of clobbering it.
            kernel_state.create_memory("Second kernel note", "Written later.", id="kernel_2")

            reloaded = HarnessState(state_path)
            self.assertIsNotNone(reloaded.get("memory", "kernel"))
            self.assertIsNotNone(reloaded.get("memory", "host"))
            self.assertIsNotNone(reloaded.get("memory", "kernel_2"))

    def test_create_detects_externally_written_entry(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "harness_state.json"
            state = HarnessState(state_path)

            # Another process creates the same entry on disk after our last load.
            other = HarnessState(state_path)
            other.create_memory("External", "Written elsewhere.", id="dup")
            future = state_path.stat().st_mtime + 5
            os.utime(state_path, (future, future))

            # create() must observe the external entry and honor create-or-fail.
            with self.assertRaisesRegex(ValueError, "already exists"):
                state.create_memory("Local", "Should not overwrite.", id="dup")
            self.assertEqual(state.get("memory", "dup").content, "Written elsewhere.")

    def test_explicit_create_and_update_enforce_entry_existence(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            first = state.create_memory("Triage", "old", id="triage", reference=PYTHON_REFERENCE, arguments={}, kind="skill")
            with self.assertRaisesRegex(ValueError, "already exists"):
                state.create_memory("Triage", "duplicate", id="triage", reference=PYTHON_REFERENCE, arguments={}, kind="skill")
            with self.assertRaisesRegex(ValueError, "does not exist"):
                state.update_memory("missing", "Missing", "missing", reference=PYTHON_REFERENCE, arguments={}, kind="skill")

            second = state.update_memory("triage", "Triage", "new", reference=PYTHON_REFERENCE, arguments={}, kind="skill")

            self.assertEqual(first.id, second.id)
            self.assertEqual(second.content, "new")
            self.assertEqual(second.version, 2)

    def test_explicit_state_dir_cache_uses_harness_state_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = get_harness_state(temp_dir)
            again = get_harness_state(temp_dir)

            self.assertIs(state, again)
            self.assertEqual(state.file_path, Path(temp_dir).resolve() / "harness_state.json")

    def test_explicit_state_dir_global_flag_uses_matching_state_file(self) -> None:
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            explicit_dir = Path(temp_dir) / "explicit"
            env_global_dir = Path(temp_dir) / "env-global"
            os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = str(env_global_dir)
            try:
                state = get_harness_state(explicit_dir)
                global_entry = state.create_memory("Scoped global", "custom dir", id="scoped_global", global_=True)
            finally:
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

            self.assertEqual(global_entry.scope, "global")
            self.assertIsNotNone(
                HarnessState(explicit_dir / "harness_state.json", scope="global").get("memory", "scoped_global")
            )
            self.assertFalse((env_global_dir / "harness_state.json").exists())

    def test_env_default_state_keeps_env_global_target_after_explicit_dir_cache_hit(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            local_dir = Path(temp_dir) / "local"
            env_global_dir = Path(temp_dir) / "env-global"
            os.environ["RLM_HARNESS_STATE_DIR"] = str(local_dir)
            os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = str(env_global_dir)
            try:
                cached_from_env = get_harness_state()
                # An explicit state_dir that aliases the env local dir must not
                # redirect the env-default singleton's global target.
                cached_from_explicit = get_harness_state(local_dir)
                global_entry = cached_from_env.create_memory(
                    "Env global",
                    "still targets the env global dir",
                    id="env_global_after_hit",
                    global_=True,
                )
            finally:
                if previous_local is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

            self.assertIs(cached_from_env, cached_from_explicit)
            self.assertEqual(global_entry.scope, "global")
            self.assertIsNotNone(
                HarnessState(env_global_dir / "harness_state.json", scope="global").get(
                    "memory", "env_global_after_hit"
                )
            )
            self.assertIsNone(
                HarnessState(local_dir / "harness_state.json").get("memory", "env_global_after_hit")
            )

    def test_local_state_requires_local_path(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_session = os.environ.get("RLM_SESSION_DIR")
        try:
            os.environ.pop("RLM_HARNESS_STATE_DIR", None)
            os.environ.pop("RLM_SESSION_DIR", None)
            with self.assertRaisesRegex(RuntimeError, "Local harness state requires"):
                HarnessState()
        finally:
            if previous_local is None:
                os.environ.pop("RLM_HARNESS_STATE_DIR", None)
            else:
                os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
            if previous_session is None:
                os.environ.pop("RLM_SESSION_DIR", None)
            else:
                os.environ["RLM_SESSION_DIR"] = previous_session

    def test_default_state_uses_global_harness_env_dir(self) -> None:
        previous = os.environ.get("RLM_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            os.environ["RLM_HARNESS_STATE_DIR"] = temp_dir
            try:
                state = HarnessState()
            finally:
                if previous is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous

            self.assertEqual(state.file_path, Path(temp_dir).resolve() / "harness_state.json")

    def test_global_scope_default_state_uses_global_harness_env_dir(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            local_dir = Path(temp_dir) / "local"
            global_dir = Path(temp_dir) / "global"
            os.environ["RLM_HARNESS_STATE_DIR"] = str(local_dir)
            os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = str(global_dir)
            try:
                state = HarnessState(scope="global")
            finally:
                if previous_local is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

            self.assertEqual(state.scope, "global")
            self.assertEqual(state.file_path, global_dir.resolve() / "harness_state.json")

    def test_default_state_is_local_and_global_flag_targets_global_store(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            local_dir = Path(temp_dir) / "local"
            global_dir = Path(temp_dir) / "global"
            os.environ["RLM_HARNESS_STATE_DIR"] = str(local_dir)
            os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = str(global_dir)
            try:
                state = get_harness_state()
                global_state = get_harness_state(global_=True)
                local_entry = state.create_memory("Local note", "Only this session.", id="local_note")
                global_entry = state.create_memory("Global note", "All sessions.", id="global_note", global_=True)
                kwargs_entry = state.create_memory(
                    "Kwargs global note",
                    "All sessions via kwargs.",
                    id="kwargs_global_note",
                    **{"global": True},
                )
            finally:
                if previous_local is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

            self.assertEqual(state.file_path, local_dir.resolve() / "harness_state.json")
            self.assertEqual(global_state.file_path, global_dir.resolve() / "harness_state.json")
            self.assertEqual(local_entry.scope, "local")
            self.assertEqual(global_entry.scope, "global")
            self.assertEqual(kwargs_entry.scope, "global")
            self.assertIsNotNone(HarnessState(local_dir / "harness_state.json").get("memory", "local_note"))
            self.assertIsNone(HarnessState(local_dir / "harness_state.json").get("memory", "global_note"))
            self.assertIsNotNone(HarnessState(global_dir / "harness_state.json", scope="global").get("memory", "global_note"))
            self.assertIsNotNone(
                HarnessState(global_dir / "harness_state.json", scope="global").get("memory", "kwargs_global_note")
            )

    def test_global_kwarg_must_be_boolean(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            with self.assertRaisesRegex(TypeError, "global must be a bool"):
                state.create_memory("Bad global flag", "bad", id="bad_global", **{"global": "false"})

    def test_state_cache_keeps_scope_distinct_when_local_and_global_share_a_file(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            os.environ["RLM_HARNESS_STATE_DIR"] = temp_dir
            os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = temp_dir
            try:
                state = get_harness_state()
                global_state = get_harness_state(global_=True)
                local_entry = state.create_memory("Local note", "Only this session.", id="local_note")
                global_entry = state.create_memory("Global note", "All sessions.", id="global_note", global_=True)
            finally:
                if previous_local is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

            self.assertIsNot(state, global_state)
            self.assertEqual(state.file_path, global_state.file_path)
            self.assertEqual(state.scope, "local")
            self.assertEqual(global_state.scope, "global")
            self.assertEqual(local_entry.scope, "local")
            self.assertEqual(global_entry.scope, "global")
            reloaded = HarnessState(Path(temp_dir) / "harness_state.json")
            self.assertEqual(reloaded.get("memory", "local_note").scope, "local")
            self.assertEqual(reloaded.get("memory", "global_note").scope, "global")

    def test_scope_prefixed_ids_route_to_the_displayed_scope(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            local_dir = Path(temp_dir) / "local"
            global_dir = Path(temp_dir) / "global"
            os.environ["RLM_HARNESS_STATE_DIR"] = str(local_dir)
            os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = str(global_dir)
            try:
                state = get_harness_state()
                state.create_memory("Global note", "v1", id="routed", global_=True)

                # The overview displays [global:routed]; that id must be usable as-is
                # and imply the global scope without passing global_.
                updated = state.update_memory("global:routed", "Global note", "v2")
                self.assertEqual(updated.scope, "global")
                self.assertEqual(state.get("memory", "global:routed").content, "v2")
                self.assertIsNone(state.get("memory", "routed"))

                state.create_memory("Local note", "local", id="local_note")
                self.assertEqual(state.get("memory", "local:local_note").content, "local")
                self.assertTrue(state.delete_memory("local:local_note"))
                self.assertIsNone(state.get("memory", "local_note"))
            finally:
                if previous_local is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

            self.assertEqual(
                HarnessState(global_dir / "harness_state.json", scope="global").get("memory", "routed").content,
                "v2",
            )

    def test_create_with_prefixed_id_does_not_mint_literal_id(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            local_dir = Path(temp_dir) / "local"
            global_dir = Path(temp_dir) / "global"
            os.environ["RLM_HARNESS_STATE_DIR"] = str(local_dir)
            os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = str(global_dir)
            try:
                state = get_harness_state()
                entry = state.create_memory("Validation", "content", id="global:validation")
            finally:
                if previous_local is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

            self.assertEqual(entry.id, "validation")
            self.assertEqual(entry.scope, "global")
            global_store = HarnessState(global_dir / "harness_state.json", scope="global")
            self.assertIsNotNone(global_store.get("memory", "validation"))
            self.assertIsNone(global_store.get("memory", "global:validation"))
            self.assertFalse((local_dir / "harness_state.json").exists())

    def test_module_harness_binds_lazily_to_env_set_after_import(self) -> None:
        # Forkserver scenario: rlm is imported in the template process without the
        # per-session env; the child applies env after fork. rlm.harness must then
        # resolve against the new env instead of a store frozen at import time.
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_session = os.environ.get("RLM_SESSION_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            try:
                os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                os.environ.pop("RLM_SESSION_DIR", None)
                # Without local env, local writes fail loudly instead of vanishing.
                with self.assertRaisesRegex(RuntimeError, "global_=True"):
                    package_harness.create_memory("Volatile", "pre-env", id="pre_env")

                os.environ["RLM_HARNESS_STATE_DIR"] = temp_dir
                entry = package_harness.create_memory("Session note", "persisted", id="session_note")
                self.assertIsNone(package_harness.get("memory", "pre_env"))
            finally:
                if previous_local is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
                if previous_session is None:
                    os.environ.pop("RLM_SESSION_DIR", None)
                else:
                    os.environ["RLM_SESSION_DIR"] = previous_session

            self.assertEqual(entry.scope, "local")
            reloaded = HarnessState(Path(temp_dir) / "harness_state.json")
            self.assertEqual(reloaded.get("memory", "session_note").content, "persisted")

    def test_module_harness_without_env_raises_on_local_writes_and_reads_work(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_session = os.environ.get("RLM_SESSION_DIR")
        try:
            os.environ.pop("RLM_HARNESS_STATE_DIR", None)
            os.environ.pop("RLM_SESSION_DIR", None)

            for mutate in (
                lambda: package_harness.create_memory("Lost", "content", id="lost"),
                lambda: package_harness.update_memory("lost", "Lost", "content"),
                lambda: package_harness.delete_memory("lost"),
                lambda: package_harness.upsert("memory", "Lost", "content", id="lost"),
            ):
                with self.assertRaisesRegex(RuntimeError, "Local harness state requires.*global_=True"):
                    mutate()

            # Reads keep working against an empty view.
            self.assertIsNone(package_harness.get("memory", "lost"))
            self.assertEqual(package_harness.list(), [])
            self.assertIn("memory: 0", package_harness.overview())
            self.assertEqual(package_harness.snapshot()["refinements"], [])
        finally:
            if previous_local is None:
                os.environ.pop("RLM_HARNESS_STATE_DIR", None)
            else:
                os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
            if previous_session is None:
                os.environ.pop("RLM_SESSION_DIR", None)
            else:
                os.environ["RLM_SESSION_DIR"] = previous_session

    def test_module_harness_without_env_still_routes_global_writes(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_session = os.environ.get("RLM_SESSION_DIR")
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            global_dir = Path(temp_dir) / "global"
            try:
                os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                os.environ.pop("RLM_SESSION_DIR", None)
                os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = str(global_dir)
                entry = package_harness.create_memory("Lesson", "keep me", id="no_session_lesson", global_=True)
            finally:
                if previous_local is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
                if previous_session is None:
                    os.environ.pop("RLM_SESSION_DIR", None)
                else:
                    os.environ["RLM_SESSION_DIR"] = previous_session
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

            self.assertEqual(entry.scope, "global")
            self.assertEqual(
                HarnessState(global_dir / "harness_state.json", scope="global").get("memory", "no_session_lesson").content,
                "keep me",
            )

    def test_import_rlm_without_env_does_not_raise(self) -> None:
        env = dict(os.environ)
        env.pop("RLM_HARNESS_STATE_DIR", None)
        env.pop("RLM_SESSION_DIR", None)
        env["PYTHONPATH"] = str(Path(__file__).resolve().parents[1] / "src")
        result = subprocess.run(
            [sys.executable, "-c", "import rlm; repr(rlm.harness); rlm.harness.overview(); rlm.harness.create_memory"],
            env=env,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_empty_local_state_dir_env_is_treated_as_unset(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_session = os.environ.get("RLM_SESSION_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            try:
                # Empty local dir must not fall through to the global agent-dir default.
                os.environ["RLM_HARNESS_STATE_DIR"] = ""
                os.environ.pop("RLM_SESSION_DIR", None)
                with self.assertRaisesRegex(RuntimeError, "Local harness state requires"):
                    HarnessState()

                # With a session dir it takes the session fallback instead.
                os.environ["RLM_SESSION_DIR"] = temp_dir
                state = HarnessState()
                self.assertEqual(state.file_path, Path(temp_dir).resolve() / "harness" / "harness_state.json")

                # A whitespace-only session dir is also unset.
                os.environ["RLM_SESSION_DIR"] = "   "
                with self.assertRaisesRegex(RuntimeError, "Local harness state requires"):
                    HarnessState()
            finally:
                if previous_local is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
                if previous_session is None:
                    os.environ.pop("RLM_SESSION_DIR", None)
                else:
                    os.environ["RLM_SESSION_DIR"] = previous_session

    def test_explicit_dir_aliasing_env_local_dir_keeps_env_global_target(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            local_dir = Path(temp_dir) / "local"
            env_global_dir = Path(temp_dir) / "env-global"
            os.environ["RLM_HARNESS_STATE_DIR"] = str(local_dir)
            os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = str(env_global_dir)
            try:
                # First construction happens via an explicit dir that merely aliases
                # the env local dir; global writes must still hit the env global dir.
                state = get_harness_state(local_dir)
                global_entry = state.create_memory("Aliased", "still global", id="alias_global", global_=True)
            finally:
                if previous_local is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

            self.assertEqual(global_entry.scope, "global")
            self.assertIsNotNone(
                HarnessState(env_global_dir / "harness_state.json", scope="global").get("memory", "alias_global")
            )
            self.assertIsNone(
                HarnessState(local_dir / "harness_state.json").get("memory", "alias_global")
            )

    def test_callable_rlm_exposes_harness_state_helpers(self) -> None:
        self.assertIs(callable_rlm.harness, package_harness)
        self.assertIs(callable_rlm.get_harness_state, get_harness_state)

    def test_unknown_kind_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            with self.assertRaisesRegex(ValueError, "unknown harness kind"):
                state.upsert("tool", "Tool", "Tool content")
            with self.assertRaisesRegex(ValueError, "unknown harness kind"):
                state.get("tool", "tool")
            with self.assertRaisesRegex(ValueError, "unknown harness kind"):
                state.delete_memory("tool", kind="tool")
            with self.assertRaisesRegex(ValueError, "unknown harness kind"):
                state.list("tool")


if __name__ == "__main__":
    unittest.main()
