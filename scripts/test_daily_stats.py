"""Synthetic fixtures only; never contact PostHog or Slack."""

import contextlib
import io
import json
import os
import subprocess
import tempfile
import textwrap
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch
import urllib.error

import daily_stats as stats


DAY = date(2026, 10, 5)


class DeliveryLookupTests(unittest.TestCase):
    def lookup(self, ids="", status=0, error=""):
        workflow = (Path(__file__).resolve().parents[1] /
                    ".github/workflows/daily-stats.yml").read_text()
        step = workflow.split("      - name: Check previous delivery attempt\n", 1)[1]
        script = textwrap.dedent(step.split("        run: |\n", 1)[1]
                                 .split("      - name:", 1)[0])
        # Stub only the API boundary; execute the workflow's actual Bash script.
        gh = r'''
gh() {
  [[ "$1" == api && "$2" == --paginate ]] || return 99
  [[ "$3" == "repos/test/repo/actions/artifacts?name=prime-agent-stats-2026-10-05&per_page=100" ]] || return 99
  [[ "$4" == --jq && "$5" == '.artifacts[] | select(.name == "prime-agent-stats-2026-10-05" and .expired == false) | .id' ]] || return 99
  printf '%s' "$API_IDS"
  printf '%s' "$API_ERROR" >&2
  return "$API_STATUS"
}
'''
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "output"
            env = {"PATH": os.environ["PATH"], "REPORT_DAY": DAY.isoformat(),
                   "GITHUB_REPOSITORY": "test/repo", "GITHUB_OUTPUT": str(output),
                   "API_IDS": ids, "API_STATUS": str(status), "API_ERROR": error}
            result = subprocess.run(["bash", "--noprofile", "--norc", "-e", "-o",
                                     "pipefail", "-c", gh + script + "\necho lookup-complete"],
                                    env=env, capture_output=True, text=True, timeout=10)
            return result, output.read_text() if output.exists() else ""

    def test_successful_empty_lookup_allows_report_preparation(self):
        result, output = self.lookup()
        self.assertEqual((result.returncode, result.stdout, output),
                         (0, "lookup-complete\n", ""))

    def test_existing_markers_prevent_duplicate_delivery(self):
        for ids in ("123\n", "123\n456\n"):
            with self.subTest(ids=ids):
                result, output = self.lookup(ids=ids)
                self.assertEqual((result.returncode, output), (0, "attempted=true\n"))
                self.assertIn("skipping", result.stdout)

    def test_api_errors_stop_before_report_preparation_even_after_partial_results(self):
        for ids, error in (("", "unexpected end of JSON input"),
                           ("", "HTTP 500"), ("123\n", "HTTP 500 on later page")):
            with self.subTest(ids=ids, error=error):
                result, output = self.lookup(ids=ids, status=1, error=error)
                self.assertEqual((result.returncode, output), (1, ""))
                self.assertNotIn("lookup-complete", result.stdout)


def fixture():
    days = [(DAY - timedelta(days=offset)).isoformat() for offset in (30, 7, 1, 0)]
    values = ([20, 50, 80, 100], [120, 200, 220, 300], [500, 600, 650, 700],
              [1000, 2000, 3000, 4000], [100, 100, 100, 100], [70, 80, 90, 95])
    return {"results": [
        {"action": {"id": series["event"], "order": order,
                    "custom_name": series["custom_name"], "math": series["math"],
                    "math_property": series.get("math_property")},
         "days": days[:], "data": list(values[order])}
        for order, series in enumerate(stats.build_query(DAY)["series"])
    ]}


class ReportTests(unittest.TestCase):
    def test_day_uses_completed_utc_day_even_before_pacific_midnight(self):
        now = datetime(2026, 10, 6, 0, 30, tzinfo=timezone.utc)
        self.assertEqual(stats.report_day(now=now), DAY)
        for value in ("2026-10-06", "2026-10-07", "2026-08-01"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                stats.report_day(value, now=now)

    def test_series_order_does_not_depend_on_array_order(self):
        response = fixture()
        response["results"].reverse()
        points = stats.parse_results(response, DAY)
        self.assertEqual(points["DAU"][DAY], 100)
        self.assertEqual(points["Successful runs"][DAY], 95)

    def test_rejects_missing_or_malformed_data(self):
        mutations = [
            lambda r: r["results"].pop(),
            lambda r: r["results"][0]["days"].pop(),
            lambda r: r["results"][0]["days"].__setitem__(0, "2026-10-03"),
            lambda r: r["results"][0]["days"].__setitem__(0, "2026-10-05"),
            lambda r: r["results"][0]["data"].__setitem__(0, None),
            lambda r: r["results"][0]["data"].__setitem__(0, float("nan")),
            lambda r: r["results"][0]["data"].__setitem__(0, -1),
            lambda r: r["results"][0]["data"].__setitem__(0, 1.5),
            lambda r: r["results"][0]["action"].__setitem__("order", 1),
            lambda r: r["results"][3]["action"].__setitem__("math_property", "cost"),
            lambda r: r["results"][5]["data"].__setitem__(0, 101),
            lambda r: r.update(query_status={"complete": False}),
            lambda r: r.update(error="query failed"),
        ]
        for mutation in mutations:
            response = fixture()
            mutation(response)
            with self.subTest(mutation=mutations.index(mutation)), self.assertRaises(ValueError):
                stats.parse_results(response, DAY)

    def test_percentage_changes_and_zero_baselines(self):
        cases = [(100, 80, "↑ 25.0%"), (80, 100, "↓ 20.0%"),
                 (100, 100, "→ 0.0%"), (0, 0, "→ 0.0%"),
                 (100, 0, "new (baseline 0)"), (None, 100, "n/a")]
        for current, previous, expected in cases:
            self.assertEqual(stats.change(current, previous), expected)
        self.assertEqual(stats.change(90, 80, percentage_points=True), "↑ 10.0pp")

    def test_report_compares_complete_rolling_windows_and_success_rate(self):
        report = stats.render_report(stats.parse_results(fixture(), DAY), DAY)
        self.assertTrue(report.startswith("*Prime Agent Daily Stats (Oct 5, 2026)*\n"))
        lines = report.splitlines()
        self.assertTrue(lines[2].startswith("• *DAU: 100* · ↑ 25.0%"))
        self.assertTrue(lines[3].startswith("• *WAU: 300* · ↑ 50.0%"))
        self.assertTrue(lines[4].startswith("• *MAU: 700* · ↑ 40.0%"))
        self.assertNotIn("—", report)
        self.assertNotIn("(UTC)", report)
        for expected in ("DAU: 100", "↑ 25.0% vs yesterday", "↑ 100.0% vs last week",
                         "WAU: 300", "↑ 50.0% vs previous 7 days", "MAU: 700",
                         "↑ 40.0% vs previous 30 days", "Token usage: 4.00K",
                         "Run success rate: 95.0%", "↑ 5.0pp vs yesterday",
                         "↑ 15.0pp vs last week", stats.DASHBOARD_URL):
            self.assertIn(expected, report)

    def test_zero_runs_are_unavailable_rate(self):
        response = fixture()
        response["results"][4]["data"][-1] = 0
        response["results"][5]["data"][-1] = 0
        report = stats.render_report(stats.parse_results(response, DAY), DAY)
        self.assertIn("Run success rate: n/a (no completed runs)", report)

    def test_offline_prepare_never_sends_or_logs_metric_values(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / "response.json", Path(directory) / "report.json"
            source.write_text(json.dumps(fixture()))
            stdout = io.StringIO()
            with patch("sys.argv", ["stats", "prepare", "--date", DAY.isoformat(),
                                   "--response-file", str(source), "--output", str(output)]), \
                    patch.object(stats, "report_day", return_value=DAY), \
                    patch.object(stats, "request") as request, \
                    patch.object(stats, "send_report") as send, contextlib.redirect_stdout(stdout):
                stats.main()
            request.assert_not_called()
            send.assert_not_called()
            self.assertNotIn("95.0%", stdout.getvalue())
            self.assertIn("Run success rate: 95.0%", json.loads(output.read_text())["text"])

    def test_prepare_api_uses_fresh_blocking_query(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch("sys.argv", ["stats", "prepare", "--output", directory + "/report.json"]), \
                patch.object(stats, "report_day", return_value=DAY), \
                patch.dict(stats.os.environ, {"POSTHOG_PERSONAL_API_KEY": "synthetic-key"}), \
                patch.object(stats, "request", return_value=json.dumps(fixture()).encode()) as request, \
                contextlib.redirect_stdout(io.StringIO()):
            stats.main()
            args, kwargs = request.call_args
            self.assertEqual(args[0], stats.POSTHOG_URL)
            self.assertEqual(args[1]["query"], stats.build_query(DAY))
            self.assertEqual((args[1]["refresh"], args[1]["async"]), ("force_blocking", False))
            self.assertEqual(kwargs["token"], "synthetic-key")

    def test_malformed_server_dates_are_not_logged(self):
        response = fixture()
        response["results"][0]["days"][0] = "private-response-value"
        stderr = io.StringIO()
        with tempfile.TemporaryDirectory() as directory, \
                patch("sys.argv", ["stats", "prepare", "--output", directory + "/report.json"]), \
                patch.object(stats, "report_day", return_value=DAY), \
                patch.dict(stats.os.environ, {"POSTHOG_PERSONAL_API_KEY": "synthetic-key"}), \
                patch.object(stats, "request", return_value=json.dumps(response).encode()), \
                contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit):
            stats.main()
        self.assertNotIn("private-response-value", stderr.getvalue())
        self.assertNotIn("synthetic-key", stderr.getvalue())

    def test_oversized_metric_is_rejected_without_traceback_or_output(self):
        response = fixture()
        response["results"][0]["data"][0] = 10 ** 400
        stderr = io.StringIO()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "report.json"
            with patch("sys.argv", ["stats", "prepare", "--output", str(output)]), \
                    patch.object(stats, "report_day", return_value=DAY), \
                    patch.dict(stats.os.environ, {"POSTHOG_PERSONAL_API_KEY": "synthetic-key"}), \
                    patch.object(stats, "request", return_value=json.dumps(response).encode()), \
                    contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit) as raised:
                stats.main()
            self.assertEqual(raised.exception.code, 1)
            self.assertFalse(output.exists())
        self.assertEqual(stderr.getvalue(),
                         "PostHog returned an unavailable or invalid metric value.\n")

    def test_missing_posthog_key_stops_before_network_or_output(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch("sys.argv", ["stats", "prepare", "--output", directory + "/report.json"]), \
                patch.object(stats, "report_day", return_value=DAY), \
                patch.dict(stats.os.environ, {}, clear=True), \
                patch.object(stats, "request") as request, \
                contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            stats.main()
        request.assert_not_called()

    def test_http_failures_never_expose_credentials_or_response_bodies(self):
        url = "https://hooks.slack.com/services/synthetic-secret"
        failures = [urllib.error.HTTPError(url, 403, "secret", {}, None),
                    urllib.error.URLError(url), TimeoutError(url)]
        for failure in failures:
            with patch.object(stats.urllib.request, "urlopen", side_effect=failure) as request:
                with self.assertRaises(ValueError) as raised:
                    stats.request(url, {"text": "private metrics"}, service="Slack")
                self.assertNotIn("synthetic-secret", str(raised.exception))
                self.assertNotIn("private metrics", str(raised.exception))
                self.assertEqual(request.call_count, 1)

    def test_slack_requires_confirmation_without_retry(self):
        with patch.dict(stats.os.environ, {"SLACK_STATS_WEBHOOK_URL":
                        "https://hooks.slack.com/services/synthetic"}), \
                patch.object(stats, "request", return_value=b"error") as request:
            with self.assertRaises(ValueError):
                stats.send_report({"text": "synthetic"})
            self.assertEqual(request.call_count, 1)


if __name__ == "__main__":
    unittest.main()
