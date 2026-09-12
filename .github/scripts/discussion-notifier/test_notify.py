import html
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import Mock, patch

import notify

TEST_PRIME_USER_ID = "UPRIME123"


def edge(number: int, author: str = "contributor") -> dict:
    return {
        "cursor": f"cursor-{number}",
        "node": {
            "id": f"discussion-{number}",
            "number": number,
            "title": f"Discussion {number}",
            "author": {"login": author},
            "category": {"name": "Bug reports"},
        },
    }


def state() -> dict:
    return notify.initial_state({"pageInfo": {"endCursor": "baseline"}})


def report(number: int, author: str = "contributor") -> dict:
    return {
        **notify.notification_item(edge(number, author)["node"]),
        "body": f"Original report {number}\n\nReproduction steps and error output.",
    }


def bodies_response(*numbers: int) -> str:
    return json.dumps({"data": {"nodes": [report(number) for number in numbers]}})


def trusted_run() -> dict:
    return {
        "event": "schedule",
        "path": notify.STATE_WORKFLOW,
        "head_branch": "main",
        "head_repository": {"full_name": notify.SOURCE_REPOSITORY},
        "conclusion": "failure",
    }


class NotificationTests(unittest.TestCase):
    def setUp(self):
        environment = patch.dict(
            "os.environ", {"PRIME_SLACK_USER_ID": TEST_PRIME_USER_ID}
        )
        environment.start()
        self.addCleanup(environment.stop)

    def test_single_notification_previews_without_webhook_or_state(self):
        response = {"data": {"repository": {"discussion": edge(1)["node"]}}}
        with (
            patch.object(
                notify, "gh", side_effect=[json.dumps(response), bodies_response(1)]
            ),
            patch.object(notify, "deliver") as deliver,
            patch.object(notify, "webhook_path") as webhook,
            patch.object(notify, "restore_state") as restore,
            patch("sys.argv", ["notify.py", "test", "--discussion", "1"]),
            redirect_stdout(io.StringIO()) as output,
        ):
            notify.main()
        self.assertIn("/discussions/1", output.getvalue())
        self.assertIn("Original report 1", output.getvalue())
        self.assertIn("Preview only", output.getvalue())
        deliver.assert_not_called()
        webhook.assert_not_called()
        restore.assert_not_called()

    def test_single_notification_sends_the_production_payload_once(self):
        response = {"data": {"repository": {"discussion": edge(1)["node"]}}}
        with (
            patch.object(
                notify, "gh", side_effect=[json.dumps(response), bodies_response(1)]
            ),
            patch.object(notify, "deliver") as deliver,
            patch.object(notify, "webhook_path", return_value="/services/test"),
            patch.object(notify, "restore_state") as restore,
            patch.dict("os.environ", {"DRY_RUN": "false"}),
            patch("sys.argv", ["notify.py", "test", "--discussion", "1", "--send"]),
            redirect_stdout(io.StringIO()) as output,
        ):
            notify.main()
        deliver.assert_called_once_with(report(1), "/services/test")
        restore.assert_not_called()
        self.assertIn("production state is unchanged", output.getvalue())

    def test_single_notification_respects_dry_run(self):
        with (
            patch.dict("os.environ", {"DRY_RUN": "true"}),
            patch.object(notify, "gh") as gh,
            patch.object(notify, "deliver") as deliver,
        ):
            with self.assertRaisesRegex(RuntimeError, "disabled during a dry run"):
                notify.test_notification(1, send=True)
        gh.assert_not_called()
        deliver.assert_not_called()

    def test_single_notification_rejects_missing_or_invalid_discussion(self):
        with (
            patch.object(
                notify,
                "gh",
                return_value=json.dumps(
                    {
                        "data": {"repository": {"discussion": None}},
                    }
                ),
            ) as gh,
            patch.object(notify, "deliver") as deliver,
        ):
            with self.assertRaisesRegex(RuntimeError, "positive discussion number"):
                notify.test_notification(0, send=False)
            gh.assert_not_called()
            with self.assertRaisesRegex(RuntimeError, "Cannot read discussion #1"):
                notify.test_notification(1, send=False)
        deliver.assert_not_called()

    def test_first_run_does_not_backfill(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(notify, "restore_state", return_value=None),
            patch.object(
                notify,
                "fetch_page",
                return_value={
                    "edges": [edge(1)],
                    "pageInfo": {"endCursor": "cursor-1"},
                },
            ),
            patch.object(notify, "deliver") as deliver,
        ):
            notify.plan(Path(directory), dry_run=True)
            saved = json.loads((Path(directory) / "state.json").read_text())
            self.assertEqual(saved["cursor"], "cursor-1")
            self.assertEqual(saved["pending"], [])
            self.assertEqual(
                json.loads((Path(directory) / "outbox.json").read_text()), []
            )
            deliver.assert_not_called()

    def test_plan_fetches_selected_bodies_without_saving_them_in_state(self):
        current = state()
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(notify, "restore_state", return_value=current),
            patch.object(
                notify,
                "fetch_page",
                return_value={"edges": [edge(i) for i in (1, 2, 3)]},
            ),
            patch.object(notify, "gh", return_value=bodies_response(2, 1)) as gh,
        ):
            notify.plan(Path(directory), dry_run=True)
            saved = json.loads((Path(directory) / "state.json").read_text())
            outbox = json.loads((Path(directory) / "outbox.json").read_text())
        self.assertEqual(outbox, [report(1), report(2)])
        self.assertEqual([item["number"] for item in saved["pending"]], [3])
        self.assertNotIn('"body"', json.dumps(saved))
        self.assertEqual(
            gh.call_args.kwargs["payload"]["variables"]["ids"],
            ["discussion-1", "discussion-2"],
        )

    def test_missing_body_does_not_checkpoint_reservations(self):
        for response in [
            {"data": {"nodes": [None]}},
            {"data": {"nodes": [{"id": "discussion-1", "body": None}]}},
            {"data": {"nodes": []}, "errors": [{"message": "unavailable"}]},
        ]:
            with (
                self.subTest(response=response),
                tempfile.TemporaryDirectory() as directory,
                patch.object(notify, "restore_state", return_value=state()),
                patch.object(notify, "fetch_page", return_value={"edges": [edge(1)]}),
                patch.object(notify, "gh", return_value=json.dumps(response)),
            ):
                with self.assertRaisesRegex(RuntimeError, "state was not advanced"):
                    notify.plan(Path(directory), dry_run=True)
                self.assertFalse((Path(directory) / "state.json").exists())
                self.assertFalse((Path(directory) / "outbox.json").exists())

    def test_empty_selection_does_not_fetch_bodies(self):
        with patch.object(notify, "gh") as gh:
            self.assertEqual(notify.fetch_report_bodies([]), [])
        gh.assert_not_called()

    def test_per_run_limit_preserves_pending_items(self):
        current = state()
        notify.enqueue(
            current, {"edges": [edge(i, f"author-{i}") for i in range(1, 9)]}
        )
        first = notify.reserve(current, 100_000)
        self.assertEqual(len(first), 5)
        self.assertEqual(len(current["pending"]), 3)
        second = notify.reserve(current, 100_001)
        self.assertEqual(len(second), 3)
        self.assertFalse(
            {item["id"] for item in first} & {item["id"] for item in second}
        )

    def test_author_limit_cannot_be_bypassed_with_case(self):
        current = state()
        notify.enqueue(
            current,
            {
                "edges": [
                    edge(1, "Alice"),
                    edge(2, "alice"),
                    edge(3, "ALICE"),
                    edge(4, "bob"),
                ]
            },
        )
        self.assertEqual(
            [item["number"] for item in notify.reserve(current, 100_000)], [1, 2, 4]
        )
        self.assertEqual([item["number"] for item in current["pending"]], [3])
        self.assertEqual(notify.reserve(current, 100_001), [])
        self.assertEqual(
            [item["number"] for item in notify.reserve(current, 186_400)], [3]
        )

    def test_rolling_daily_limit_across_runs(self):
        current = state()
        notify.enqueue(
            current, {"edges": [edge(i, f"author-{i}") for i in range(1, 26)]}
        )
        selected = []
        for offset in range(6):
            selected.extend(notify.reserve(current, 100_000 + offset))
        self.assertEqual(len(selected), 20)
        self.assertEqual(len(current["pending"]), 5)
        self.assertEqual(notify.reserve(current, 186_399), [])
        self.assertEqual(len(notify.reserve(current, 186_405)), 5)

    def test_duplicate_pages_do_not_repeat_mentions(self):
        current = state()
        page = {"edges": [edge(1), edge(2)]}
        notify.enqueue(current, page)
        notify.enqueue(current, page)
        self.assertEqual(len(notify.reserve(current, 100_000)), 2)
        notify.enqueue(current, page)
        self.assertEqual(notify.reserve(current, 100_001), [])

    def test_full_queue_does_not_advance_past_unread_discussions(self):
        current = state()
        notify.enqueue(
            current, {"edges": [edge(i) for i in range(1, notify.MAX_PENDING + 2)]}
        )
        self.assertEqual(len(current["pending"]), notify.MAX_PENDING)
        self.assertEqual(current["cursor"], f"cursor-{notify.MAX_PENDING}")

    def test_missing_author_is_handled(self):
        current = state()
        item = edge(1)
        item["node"]["author"] = None
        notify.enqueue(current, {"edges": [item]})
        self.assertEqual(current["pending"][0]["author"], "deleted-user")

    def test_invalid_discussion_number_is_rejected(self):
        current = state()
        item = edge(1)
        item["node"]["number"] = "1?redirect=evil"
        with self.assertRaises(RuntimeError):
            notify.enqueue(current, {"edges": [item]})
        self.assertEqual(current["cursor"], "baseline")

    def test_message_contains_full_report_and_only_one_real_mention(self):
        item = report(1, "<@UOTHER>")
        item.update(
            {
                "title": "<!channel> <@UOTHER> & " + "a" * 500,
                "body": (
                    "## Report\n\n<!channel> <@UOTHER> <@" + TEST_PRIME_USER_ID + ">"
                    "\n\n```typescript\nconst a = b < 5 && c > 0;\n```\n" + "x" * 4_000
                ),
            }
        )
        payload = notify.slack_payload(item)
        encoded = json.dumps(payload)
        self.assertEqual(encoded.count("<@"), 1)
        self.assertNotIn("<!channel>", encoded)
        self.assertEqual(html.unescape(payload["attachments"][0]["text"]), item["body"])
        self.assertIn("untrusted evidence", payload["text"])
        self.assertEqual(
            payload["attachments"][0]["title_link"],
            "https://github.com/PrimeIntellect-ai/prime-agent/discussions/1",
        )
        self.assertNotIn("thread_ts", payload)
        self.assertFalse(payload["unfurl_links"])

    def test_oversized_report_requests_manual_review_without_a_mention(self):
        item = report(1)
        item["body"] = "&" * (notify.MAX_REPORT_CHARS // 5)
        payload = notify.slack_payload(item)
        self.assertIn(f"<@{TEST_PRIME_USER_ID}>", payload["text"])
        self.assertEqual(html.unescape(payload["attachments"][0]["text"]), item["body"])
        item["body"] += "&"
        payload = notify.slack_payload(item)
        self.assertNotIn("<@", json.dumps(payload))
        self.assertIn("manual review", payload["text"])
        self.assertIn("no partial report", payload["attachments"][0]["text"])
        self.assertTrue(
            payload["attachments"][0]["title_link"].endswith("/discussions/1")
        )

    def test_bot_configuration_cannot_inject_mentions(self):
        for value in ["", "prime", "<!channel>", "UPRIME123> <@UOTHER", "U123\n"]:
            with (
                self.subTest(value=value),
                patch.dict("os.environ", {"PRIME_SLACK_USER_ID": value}),
            ):
                with self.assertRaisesRegex(RuntimeError, "PRIME_SLACK_USER_ID"):
                    notify.slack_payload(report(1))

    def test_missing_bot_configuration_does_not_reserve_discussions(self):
        with (
            patch.dict("os.environ", {"PRIME_SLACK_USER_ID": ""}),
            patch.object(notify, "webhook_path", return_value="/services/test"),
            patch.object(notify, "restore_state") as restore,
        ):
            with self.assertRaisesRegex(RuntimeError, "PRIME_SLACK_USER_ID"):
                notify.plan(Path("unused"), dry_run=False)
        restore.assert_not_called()

    def test_webhook_is_restricted_to_slack_incoming_webhooks(self):
        for url in [
            "",
            "https://example.com/services/test",
            "http://hooks.slack.com/services/test",
            "https://hooks.slack.com/triggers/test",
            "https://hooks.slack.com/services/test?token=secret",
        ]:
            with (
                self.subTest(url=url),
                patch.dict("os.environ", {"SLACK_WEBHOOK_URL": url}),
            ):
                with self.assertRaisesRegex(
                    RuntimeError, "Configure SLACK_DISCUSSION_WEBHOOK_URL"
                ):
                    notify.webhook_path()
        with patch.dict(
            "os.environ", {"SLACK_WEBHOOK_URL": "https://hooks.slack.com/services/test"}
        ):
            self.assertEqual(notify.webhook_path(), "/services/test")

    def test_ambiguous_slack_failure_is_not_retried(self):
        current = state()
        notify.enqueue(current, {"edges": [edge(1)]})
        item = notify.reserve(current, 100_000)[0]
        item["body"] = report(1)["body"]
        with patch.object(notify.http.client, "HTTPSConnection") as connection:
            connection.return_value.getresponse.side_effect = TimeoutError(
                "sensitive endpoint"
            )
            with self.assertRaisesRegex(
                RuntimeError, "delivery for discussion #1 is uncertain"
            ):
                notify.deliver(item, "/services/secret")
            connection.return_value.request.assert_called_once()
            connection.return_value.close.assert_called_once()
        self.assertEqual(notify.reserve(current, 100_001), [])

    def test_slack_requires_success_status_and_body(self):
        item = report(1)
        for status, body, succeeds in [
            (200, b"ok", True),
            (200, b"invalid_payload", False),
            (429, b"rate_limited", False),
        ]:
            with (
                self.subTest(status=status, body=body),
                patch.object(notify.http.client, "HTTPSConnection") as connection,
            ):
                connection.return_value.getresponse.return_value = Mock(
                    status=status, read=Mock(return_value=body)
                )
                if succeeds:
                    notify.deliver(item, "/services/test")
                else:
                    with self.assertRaises(RuntimeError):
                        notify.deliver(item, "/services/test")
                connection.return_value.request.assert_called_once()

    def test_restores_latest_reservation_regardless_of_run_conclusion(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            saved = state()
            (path / "state.json").write_text(json.dumps(saved))
            artifacts = [
                {
                    "id": i,
                    "expired": False,
                    "workflow_run": {"id": i * 10, "head_branch": branch},
                }
                for i, branch in [(1, "main"), (3, "feature/test"), (2, "main")]
            ]
            with patch.object(
                notify,
                "gh",
                side_effect=[
                    json.dumps({"artifacts": artifacts}),
                    json.dumps(trusted_run()),
                    "",
                ],
            ) as gh:
                self.assertEqual(notify.restore_state(path), saved)
                self.assertIn("20", gh.call_args.args)

    def test_untrusted_builds_cannot_replace_notification_state(self):
        for change in [
            {"event": "pull_request"},
            {"event": "pull_request_target"},
            {"path": ".github/workflows/other.yml"},
            {"head_repository": {"full_name": "contributor/prime-agent"}},
            {"head_branch": "feature/test"},
        ]:
            with (
                self.subTest(change=change),
                tempfile.TemporaryDirectory() as directory,
            ):
                path = Path(directory)
                saved = state()
                (path / "state.json").write_text(json.dumps(saved))
                artifacts = [
                    {
                        "id": i,
                        "expired": False,
                        "workflow_run": {"id": i * 10, "head_branch": "main"},
                    }
                    for i in [1, 2]
                ]
                with patch.object(
                    notify,
                    "gh",
                    side_effect=[
                        json.dumps({"artifacts": artifacts}),
                        json.dumps({**trusted_run(), **change}),
                        json.dumps({**trusted_run(), "event": "workflow_dispatch"}),
                        "",
                    ],
                ) as gh:
                    self.assertEqual(notify.restore_state(path), saved)
                    downloads = [
                        call for call in gh.call_args_list if call.args[0] == "run"
                    ]
                    self.assertEqual(len(downloads), 1)
                    self.assertEqual(downloads[0].args[2], "10")

    def test_expired_state_is_not_silently_reset(self):
        artifact = {
            "id": 1,
            "expired": True,
            "workflow_run": {"id": 10, "head_branch": "main"},
        }
        with patch.object(
            notify,
            "gh",
            side_effect=[
                json.dumps({"artifacts": [artifact]}),
                json.dumps(trusted_run()),
            ],
        ):
            with self.assertRaisesRegex(RuntimeError, "state expired"):
                notify.restore_state(Path("unused"))


if __name__ == "__main__":
    unittest.main()
