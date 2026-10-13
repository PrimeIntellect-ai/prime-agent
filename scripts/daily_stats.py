#!/usr/bin/env python3
"""Prepare aggregate PostHog reports; send only when explicitly requested."""

import argparse
import json
import math
import os
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
import urllib.error
import urllib.request


POSTHOG_URL = "https://eu.posthog.com/api/projects/22174/query/"
DASHBOARD_URL = "https://eu.posthog.com/project/22174/dashboard/999378"
METRICS = ("DAU", "WAU", "MAU", "Tokens", "Runs", "Successful runs")


class ReportError(ValueError):
    """A safe diagnostic that contains no response values or credentials."""


def report_day(value="", now=None):
    today = (now or datetime.now(timezone.utc)).astimezone(timezone.utc).date()
    day = date.fromisoformat(value) if value else today - timedelta(days=1)
    if day >= today or day < today - timedelta(days=60):
        raise ReportError("Report date must be a completed UTC day within the last 60 days.")
    return day


def build_query(day):
    series = [
        {"kind": "EventsNode", "event": "agent run completed", "custom_name": name,
         "math": aggregation}
        for name, aggregation in zip(METRICS, ("dau", "weekly_active", "monthly_active",
                                               "sum", "total", "total"))
    ]
    series[3]["math_property"] = "total_tokens"
    series[5]["properties"] = [
        {"key": "outcome", "type": "event", "operator": "exact", "value": ["success"]}
    ]
    return {
        "kind": "TrendsQuery", "interval": "day", "filterTestAccounts": True,
        "dateRange": {"date_from": (day - timedelta(days=60)).isoformat(),
                      "date_to": day.isoformat()},
        "properties": [{"type": "hogql", "key":
                        "coalesce(toString(properties.version), '') != '0.0.0-benchmark'"}],
        "series": series,
    }


def parse_results(response, day):
    if not isinstance(response, dict):
        raise ReportError("PostHog returned an unexpected response shape.")
    if response.get("error"):
        raise ReportError("PostHog returned a query error.")
    status = response.get("query_status")
    if status is not None and (not isinstance(status, dict) or
                               not status.get("complete") or status.get("error")):
        raise ReportError("PostHog query has not completed successfully.")
    results = response.get("results")
    if not isinstance(results, list) or len(results) != len(METRICS):
        raise ReportError("PostHog did not return all six metric series.")
    required = {day - timedelta(days=offset) for offset in (0, 1, 7, 30)}
    by_metric = {}
    for result in results:
        if not isinstance(result, dict) or not isinstance(result.get("action"), dict):
            raise ReportError("PostHog returned an unexpected metric shape.")
        action = result.get("action", {})
        order = action.get("order")
        if type(order) is not int or not 0 <= order < len(METRICS):
            raise ReportError("PostHog metric series order is missing or invalid.")
        name = METRICS[order]
        if name in by_metric or action.get("custom_name") != name:
            raise ReportError("PostHog metric series is duplicated or mislabeled.")
        expected = build_query(day)["series"][order]
        if (action.get("id") != expected["event"] or
                action.get("math") != expected["math"] or
                action.get("math_property") != expected.get("math_property")):
            raise ReportError("PostHog returned an unexpected aggregation.")
        days, values = result.get("days", []), result.get("data", [])
        if (not isinstance(days, list) or not isinstance(values, list) or
                len(days) != len(values) or not days):
            raise ReportError("PostHog date and value arrays do not match.")
        points = {}
        for raw_day, value in zip(days, values):
            point_day = date.fromisoformat(raw_day)
            if point_day in points:
                raise ReportError("PostHog returned duplicate dates.")
            try:
                finite = type(value) in (int, float) and math.isfinite(value)
            except OverflowError:
                finite = False
            if not finite or value < 0:
                raise ReportError("PostHog returned an unavailable or invalid metric value.")
            if name != "Tokens" and int(value) != value:
                raise ReportError("PostHog returned a fractional event or user count.")
            points[point_day] = value
        if not required.issubset(points):
            raise ReportError("PostHog omitted dates needed for comparisons.")
        by_metric[name] = points
    for point_day in required:
        if by_metric["Successful runs"][point_day] > by_metric["Runs"][point_day]:
            raise ReportError("Successful runs exceed completed runs.")
    return by_metric


def change(current, previous, *, percentage_points=False):
    if current is None or previous is None:
        return "n/a"
    if percentage_points:
        delta, unit = current - previous, "pp"
    elif previous == 0:
        return "→ 0.0%" if current == 0 else "new (baseline 0)"
    else:
        delta, unit = (current / previous - 1) * 100, "%"
    delta = round(delta, 1)
    arrow = "↑" if delta > 0 else "↓" if delta < 0 else "→"
    return f"{arrow} {abs(delta):.1f}{unit}"


def render_report(points, day):
    yesterday, last_week, last_month = (day - timedelta(days=n) for n in (1, 7, 30))
    title_date = f"{day:%b} {day.day}, {day.year}"
    lines = [f"*Prime Agent Daily Stats ({title_date})*", ""]
    values = points["DAU"]
    lines.append(f"• *DAU: {values[day]:,.0f}* · "
                 f"{change(values[day], values[yesterday])} vs yesterday · "
                 f"{change(values[day], values[last_week])} vs last week")
    for name, previous, period in (("WAU", last_week, "previous 7 days"),
                                    ("MAU", last_month, "previous 30 days")):
        values = points[name]
        lines.append(f"• *{name}: {values[day]:,.0f}* · "
                     f"{change(values[day], values[previous])} vs {period}")
    for name, display_name in (("Tokens", "Token usage"), ("Runs", "Completed runs")):
        values = points[name]
        value = f"{values[day]:,.0f}"
        if name == "Tokens":
            for divisor, suffix in ((1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "K")):
                if values[day] >= divisor:
                    value = f"{values[day] / divisor:.2f}{suffix}"
                    break
        lines.append(f"• *{display_name}: {value}* · {change(values[day], values[yesterday])}"
                     f" vs yesterday · {change(values[day], values[last_week])} vs last week")
    rates = {d: points["Successful runs"][d] / points["Runs"][d] * 100
             if points["Runs"][d] else None for d in (day, yesterday, last_week)}
    rate = f"{rates[day]:.1f}%" if rates[day] is not None else "n/a (no completed runs)"
    lines.append(f"• *Run success rate: {rate}* · "
                 f"{change(rates[day], rates[yesterday], percentage_points=True)} vs yesterday · "
                 f"{change(rates[day], rates[last_week], percentage_points=True)} vs last week")
    lines.extend([f"<{DASHBOARD_URL}|Open dashboard>",
                  "Active users count anonymous installations with a completed run. "
                  "Tokens are recorded usage, including cache; they do not measure cost. "
                  "Test accounts and known benchmarks are excluded."])
    return "\n".join(lines)


def request(url, payload, *, token=None, service):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=90) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        raise ReportError(f"{service} request failed with HTTP {error.code}.") from None
    except (urllib.error.URLError, TimeoutError):
        raise ReportError(f"{service} delivery result unknown; inspect the run before retrying.") from None


def send_report(payload):
    url = os.environ.get("SLACK_STATS_WEBHOOK_URL", "")
    if not url.startswith("https://hooks.slack.com/services/"):
        raise ReportError("SLACK_STATS_WEBHOOK_URL is missing or is not a Slack incoming webhook.")
    if request(url, payload, service="Slack").strip() != b"ok":
        raise ReportError("Slack did not confirm delivery; inspect the channel before retrying.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    day_parser = commands.add_parser("day")
    day_parser.add_argument("--date", default="")
    prepare = commands.add_parser("prepare")
    prepare.add_argument("--date", default="")
    prepare.add_argument("--response-file", type=Path)
    prepare.add_argument("--output", type=Path, required=True)
    send = commands.add_parser("send")
    send.add_argument("--payload", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "day":
            print(report_day(args.date))
        elif args.command == "prepare":
            day = report_day(args.date)
            if args.response_file:
                response = json.loads(args.response_file.read_text())
            else:
                token = os.environ.get("POSTHOG_PERSONAL_API_KEY", "")
                if not token:
                    raise ReportError("POSTHOG_PERSONAL_API_KEY is missing.")
                response = json.loads(request(POSTHOG_URL, {
                    "query": build_query(day), "name": "Prime Agent daily Slack stats",
                    "refresh": "force_blocking", "async": False,
                }, token=token, service="PostHog"))
            text = render_report(parse_results(response, day), day)
            args.output.write_text(json.dumps({"text": text, "unfurl_links": False,
                                                "unfurl_media": False}))
            print("Report prepared and validated. Metric values were not logged.")
        elif args.command == "send":
            send_report(json.loads(args.payload.read_text()))
            print("Slack confirmed daily report delivery.")
    except (ValueError, KeyError, TypeError, OSError) as error:
        # Never include HTTP exception strings: those can contain a webhook URL.
        if isinstance(error, ReportError):
            parser.exit(1, f"{error}\n")
        parser.exit(1, "Report preparation failed; no metric values or credentials were logged.\n")


if __name__ == "__main__":
    main()
