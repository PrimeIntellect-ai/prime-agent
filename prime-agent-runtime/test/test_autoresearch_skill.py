from __future__ import annotations

import asyncio
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from rlm import RLMSpawnHandle


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
        with patch.object(module, "host_request", host):
            asyncio.run(module.initialize("Find a problem", topic="agent memory"))
            asyncio.run(module.complete_cycle({"candidate": {"statement": "candidate"}}))
            asyncio.run(module.update_claim("claim-1", {"unresolved_objections": ["new evidence"]}))
        self.assertEqual(host.await_args_list[0].args[0], "autoresearch.initialize")
        self.assertEqual(host.await_args_list[1].args[0], "autoresearch.cycle.complete")
        self.assertEqual(host.await_args_list[2].args[0], "autoresearch.claim.update")

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
                "candidate": {"candidateId": "candidate-authority"},
                "prompts": {role: f"Review as {role}" for role in roles},
            }
        )
        spawn = AsyncMock(
            side_effect=lambda prompt, **kwargs: RLMSpawnHandle(
                rlm_child_id=f"sub-{kwargs['name']}",
                name=kwargs["name"],
                session_dir=Path("/tmp") / kwargs["name"],
                model="provider/model",
            )
        )
        with patch.object(module, "host_request", host), patch.object(module, "spawn_rlm", spawn):
            handles = asyncio.run(
                module.spawn_reviewers(
                    {"candidate_id": "candidate-authority"},
                    model="provider/model",
                    thinking="high",
                )
            )
        self.assertEqual(len(handles), 4)
        self.assertEqual(spawn.await_count, 4)
        self.assertTrue(all(call.kwargs["model"] == "provider/model" for call in spawn.await_args_list))
        self.assertTrue(all(call.kwargs["thinking"] == "high" for call in spawn.await_args_list))
        self.assertEqual(
            [call.args[0] for call in spawn.await_args_list],
            [f"Review as {role}" for role in roles],
        )

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
        </feed>"""
        with patch.object(module, "_request_json", return_value=crossref_payload):
            crossref = asyncio.run(module.crossref_search("agent memory", rows=1))
        with patch.object(module, "_cached_bytes", return_value=arxiv_xml):
            arxiv = asyncio.run(module.arxiv_search("agent memory", max_results=1))
        self.assertEqual(crossref[0]["paper_id"], "doi:10.1000/example")
        self.assertEqual(crossref[0]["publication_status"], "published_status_unclear")
        self.assertEqual(crossref[0]["metadata_verified_by"], ["crossref"])
        self.assertEqual(arxiv[0]["paper_id"], "arxiv:2608.12345")
        self.assertEqual(arxiv[0]["publication_status"], "preprint")
        self.assertEqual(arxiv[0]["full_text_url"], "https://arxiv.org/pdf/2608.12345v2")

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
