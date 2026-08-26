from __future__ import annotations

import asyncio
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

SKILL = Path(__file__).parents[2] / "packages/coding-agent/skills/autoresearch/src/autoresearch/__init__.py"


def load_skill(name: str):
    spec = importlib.util.spec_from_file_location(name, SKILL)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AutoresearchSkillTest(unittest.TestCase):
    def test_initialize_and_complete_cycle_use_host_owned_requests(self) -> None:
        module = load_skill("autoresearch_host_test")
        host = AsyncMock(return_value={"checkpoint": {"status": "progressing"}})
        with (
            patch.object(module, "host_request", host),
            patch.object(module, "spontaneous_recall", AsyncMock(return_value={"ok": True})),
            patch.object(module, "_finish_cycle_memory", AsyncMock()),
        ):
            asyncio.run(module.initialize("Find a problem", topic="agent memory"))
            asyncio.run(module.complete_cycle({"candidate": {"statement": "candidate"}}))
            asyncio.run(module.update_claim("claim-1", {"unresolved_objections": ["new evidence"]}))
        self.assertEqual(host.await_args_list[0].args[0], "autoresearch.initialize")
        self.assertEqual(host.await_args_list[1].args[0], "autoresearch.cycle.complete")
        self.assertEqual(host.await_args_list[2].args[0], "autoresearch.claim.update")

    def test_search_and_peer_review_evidence_use_host_owned_receipts(self) -> None:
        module = load_skill("autoresearch_receipts_test")
        host = AsyncMock(return_value={"receipt": {"verified": True}})
        candidate = {"candidate_id": "candidate-authority", "statement": "Authority failures"}
        with patch.object(module, "host_request", host):
            asyncio.run(
                module.record_search(
                    candidate,
                    coverage_kind="mechanism_queries",
                    query="authority calibration agent memory",
                    source="google_search",
                    result_urls=["https://example.org/search?q=authority"],
                    inspected_paper_ids=["doi:10.1000/example"],
                )
            )
            asyncio.run(
                module.verify_peer_review(
                    "doi:10.1000/example",
                    "https://publisher.example/articles/example",
                    "This article underwent peer review before publication.",
                )
            )
        self.assertEqual(host.await_args_list[0].args[0], "autoresearch.search.record")
        self.assertEqual(
            host.await_args_list[0].args[1]["receipt"]["inspected_paper_ids"],
            ["doi:10.1000/example"],
        )
        self.assertEqual(
            host.await_args_list[1].args,
            (
                "autoresearch.publication.peer_review.verify",
                {
                    "evidence": {
                        "paper_id": "doi:10.1000/example",
                        "evidence_url": "https://publisher.example/articles/example",
                        "exact_quote": "This article underwent peer review before publication.",
                    }
                },
            ),
        )

    def test_cycle_memory_runs_reflection_at_each_required_milestone(self) -> None:
        module = load_skill("autoresearch_cycle_memory_test")
        scenarios = (
            (
                "candidate_promotion",
                {"cycle": {"cycleId": "cycle-1"}},
                {"outcome": "promoted", "candidate": {"statement": "promoted candidate"}},
                [],
            ),
            (
                "supervisor_intervention",
                {
                    "cycle": {"cycleId": "cycle-2"},
                    "supervision": {"interventionNeeded": True, "reason": "trajectory collapsed"},
                },
                {"outcome": "rejected", "candidate": {"statement": "rejected candidate"}},
                [],
            ),
            (
                "five_cycles",
                {"cycle": {"cycleId": "cycle-5"}},
                {"outcome": "rejected", "candidate": {"statement": "fifth candidate"}},
                [{"cycleId": f"cycle-{index}"} for index in range(1, 6)],
            ),
        )
        for expected_trigger, response, cycle, state_cycles in scenarios:
            with self.subTest(trigger=expected_trigger):
                reflect = AsyncMock(return_value={"ok": True})
                spontaneous = AsyncMock(return_value={"ok": True, "context": "memory"})
                with (
                    patch.object(module, "sync_nooa_memory", AsyncMock(return_value={"ok": True})),
                    patch.object(
                        module,
                        "get_state",
                        AsyncMock(return_value={"state": {"cycles": state_cycles}}),
                    ),
                    patch.object(module, "_reflect_synced", reflect),
                    patch.object(module, "_spontaneous_recall_synced", spontaneous),
                ):
                    asyncio.run(module._finish_cycle_memory(response, cycle))
                reflect.assert_awaited_once_with(expected_trigger, cycle_id=response["cycle"]["cycleId"])
                spontaneous.assert_awaited_once()
                self.assertEqual(response["spontaneous_recall"]["context"], "memory")

    def test_nooa_reflection_is_bound_back_to_canonical_host_state(self) -> None:
        module = load_skill("autoresearch_reflection_receipt_test")
        host = AsyncMock(return_value={"reflection": {"reflectionId": "reflection-1"}})
        sidecar = {
            "ok": True,
            "report": {"merged": 1, "pruned": 2},
            "archived_memory_ids": ["memory-1"],
        }
        with (
            patch.object(module, "host_request", host),
            patch.object(module, "_run_nooa_sidecar", return_value=sidecar),
        ):
            result = asyncio.run(
                module._reflect_synced("supervisor_intervention", cycle_id="cycle-1")
            )
        self.assertTrue(result["ok"])
        host.assert_awaited_once_with(
            "autoresearch.memory.reflection.record",
            {
                "trigger": "supervisor_intervention",
                "report": {"merged": 1, "pruned": 2},
                "archived_memory_ids": ["memory-1"],
                "cycle_id": "cycle-1",
            },
        )

    def test_supervisor_timeout_still_runs_next_cycle_memory_maintenance(self) -> None:
        module = load_skill("autoresearch_timeout_memory_test")
        host = AsyncMock(
            return_value={
                "cycle": {"cycleId": "cycle-timeout"},
                "checkpoint": {"interventionNeeded": False},
                "delivery": {},
            }
        )
        finish = AsyncMock()
        with (
            patch.object(module, "host_request", host),
            patch.object(module, "collect_results", AsyncMock(return_value={"supervision": []})),
            patch.object(module, "_finish_cycle_memory", finish),
        ):
            with self.assertRaisesRegex(TimeoutError, "cycle-timeout"):
                asyncio.run(
                    module.complete_cycle(
                        {"candidate": {"statement": "candidate"}, "outcome": "rejected"},
                        timeout=0,
                        poll_interval=0,
                    )
                )
        finish.assert_awaited_once()

    def test_spawn_reviewers_creates_four_role_separated_children(self) -> None:
        module = load_skill("autoresearch_reviewers_test")
        roles = (
            "literature_auditor",
            "prior_art_killer",
            "experimental_critic",
            "top_tier_editor",
        )
        host = AsyncMock(
            return_value={
                "assignments": [
                    {
                        "childId": f"sub-autoresearch-{role}",
                        "name": f"autoresearch-{role}",
                        "role": role,
                        "candidateDigest": "sha256:candidate",
                    }
                    for role in roles
                ],
            }
        )
        candidate = {"candidate_id": "candidate-authority"}
        with patch.object(module, "host_request", host):
            assignments = asyncio.run(module.spawn_reviewers(candidate))
        self.assertEqual(len(assignments), 4)
        self.assertEqual(
            [assignment["role"] for assignment in assignments],
            list(roles),
        )
        host.assert_awaited_once_with("autoresearch.reviewers.spawn", {"candidate": candidate})

    def test_rejects_non_dict_claim_before_contacting_host(self) -> None:
        module = load_skill("autoresearch_validation_test")
        host = AsyncMock()
        with patch.object(module, "host_request", host):
            with self.assertRaisesRegex(TypeError, "claim must be a dict"):
                asyncio.run(module.add_claim([]))
        host.assert_not_awaited()

    def test_scholarly_clients_normalize_crossref_and_arxiv_without_inventing_peer_review(self) -> None:
        module = load_skill("autoresearch_scholarly_test")
        crossref_payload = {
            "message": {
                "items": [
                    {
                        "DOI": "10.1000/example",
                        "title": ["Grounded Research"],
                        "author": [{"given": "Ada", "family": "Lovelace"}],
                        "published": {"date-parts": [[2026, 8, 25]]},
                        "container-title": ["Research Journal"],
                    }
                ]
            }
        }
        arxiv_xml = b"""<?xml version="1.0"?>
        <feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
          <entry>
            <id>http://arxiv.org/abs/2608.12345v2</id>
            <title>Mechanistic Agent Memory</title>
            <summary>A complete abstract.</summary>
            <published>2026-08-20T00:00:00Z</published>
            <author><name>A. Researcher</name></author>
            <link title="pdf" href="https://arxiv.org/pdf/2608.12345v2" type="application/pdf" />
          </entry>
          <entry>
            <id>http://arxiv.org/abs/math/0301234v2</id>
            <title>Legacy Category Identifier</title>
            <summary>An older identifier must retain its category.</summary>
            <published>2003-01-20T00:00:00Z</published>
            <author><name>B. Researcher</name></author>
          </entry>
        </feed>"""
        with patch.object(module, "_request_json", return_value=crossref_payload):
            crossref = asyncio.run(module.crossref_search("agent memory", rows=1))
        with patch.object(module, "_cached_bytes", return_value=arxiv_xml):
            arxiv = asyncio.run(module.arxiv_search("agent memory", max_results=2))
        self.assertEqual(crossref[0]["paper_id"], "doi:10.1000/example")
        self.assertNotIn("publication_status", crossref[0])
        self.assertNotIn("metadata_verified_by", crossref[0])
        self.assertEqual(arxiv[0]["paper_id"], "arxiv:2608.12345")
        self.assertNotIn("publication_status", arxiv[0])
        self.assertNotIn("metadata_verified_by", arxiv[0])
        self.assertEqual(arxiv[0]["full_text_url"], "https://arxiv.org/pdf/2608.12345v2")
        self.assertEqual(arxiv[1]["paper_id"], "arxiv:math/0301234")
        self.assertEqual(arxiv[1]["preprint_id"], "math/0301234")
        self.assertEqual(arxiv[1]["full_text_url"], "https://arxiv.org/pdf/math/0301234v2")

    def test_memory_reuse_and_final_export_use_host_gates(self) -> None:
        module = load_skill("autoresearch_memory_test")
        host = AsyncMock(
            side_effect=[
                {"memory": {"memoryId": "memory-1"}},
                {"reuse": {"status": "proposed"}},
                {"reuse": {"status": "verified"}},
                {"deliverable": {"stop_gate": {"passed": True}}},
            ]
        )
        with patch.object(module, "host_request", host):
            asyncio.run(
                module.remember(
                    {"type": "FAILED_DIRECTION", "title": "Old failure", "content": "Do not repeat."},
                    mirror_nooa=False,
                )
            )
            asyncio.run(module.prepare_memory_reuse({"memory_ids": ["memory-1"]}))
            asyncio.run(module.verify_memory_reuse("reuse-1", accepted=True, evidence=["rechecked"]))
            asyncio.run(module.export_deliverable())
        self.assertEqual(host.await_args_list[0].args[0], "autoresearch.memory.remember")
        self.assertEqual(host.await_args_list[1].args[0], "autoresearch.memory.reuse.prepare")
        self.assertEqual(host.await_args_list[2].args[0], "autoresearch.memory.reuse.verify")
        self.assertEqual(host.await_args_list[3].args, ("autoresearch.export", {"final": True}))

    def test_heartbeat_uses_existing_host_scheduler(self) -> None:
        module = load_skill("autoresearch_heartbeat_test")
        host = AsyncMock(return_value={"heartbeat": {"id": "heartbeat-1"}})
        with patch.object(module, "host_request", host):
            asyncio.run(module.enable_heartbeat(interval="45m"))
            asyncio.run(module.disable_heartbeat("heartbeat-1"))
        self.assertEqual(host.await_args_list[0].args[0], "rlm_heartbeat.create")
        self.assertEqual(host.await_args_list[0].args[1]["delivery_mode"], "follow_up")
        self.assertEqual(host.await_args_list[1].args, ("rlm_heartbeat.delete", {"id": "heartbeat-1"}))

    def test_full_text_download_rejects_non_https_and_uses_bounded_artifact_helper(self) -> None:
        module = load_skill("autoresearch_fulltext_test")
        with self.assertRaisesRegex(ValueError, "credential-free HTTPS"):
            module._validate_public_https_url("http://127.0.0.1/paper.pdf")
        with patch.object(
            module,
            "_download_open_full_text",
            return_value={"path": "/tmp/paper.pdf", "bytes": 100},
        ) as download:
            result = asyncio.run(
                module.download_open_full_text(
                    "https://example.org/paper.pdf",
                    filename="paper",
                    max_bytes=1024,
                )
            )
        self.assertEqual(result["bytes"], 100)
        download.assert_called_once_with("https://example.org/paper.pdf", "paper", 1024)


if __name__ == "__main__":
    unittest.main()
