# Daily Prime Agent stats

The GitHub Actions workflow `Prime Agent daily stats` prepares a report at 9 AM
America/Los_Angeles, including daylight saving changes. GitHub may start scheduled
runs late. The report covers the previous completed **UTC day**, matching the
[Prime Agent Overview dashboard](https://eu.posthog.com/project/22174/dashboard/999378).

It reports DAU, WAU, MAU, token usage, completed runs, and run success rate. Daily
values compare with yesterday and the same weekday last week. WAU compares with
the preceding seven-day window, and MAU with the preceding 30-day window. Success
rate changes use percentage points. A zero baseline shows `new (baseline 0)`;
no completed runs gives an unavailable success rate.

Active users count anonymous installations that emitted `agent run completed`,
including successful, failed, and aborted runs. They do not count verified people.
Tokens sum `total_tokens`, including recorded cache usage; they do not measure
spend. Success rate divides runs with `outcome=success` by all completed runs.
The query excludes PostHog test accounts and version `0.0.0-benchmark`.

## Setup and activation

1. Add repository secret `POSTHOG_PERSONAL_API_KEY`: a
   [PostHog personal API key](https://posthog.com/docs/api/personal-api-keys) with
   read access to queries and insights, limited to project 22174. A project capture
   token cannot read analytics. The script uses the EU
   [query endpoint](https://posthog.com/docs/product-analytics/surfaces/api).
2. Set repository secret `SLACK_STATS_WEBHOOK_URL` to the engineering bot's incoming
   webhook for `#research-19-prime-agent`. The webhook chooses the channel and sender.
3. Merge the workflow to `main`. Run it manually with **publish unchecked** to
   validate access without sending a message. Logs show validation status only.
4. After reviewing a local report, set repository variable
   `PRIME_AGENT_STATS_ENABLED=true` to enable daily delivery. Keep this variable
   unset or `false` to stop delivery. Manual sends also require this variable,
   **publish checked**, and the `main` branch.

Neither Codex nor n8n runs the scheduled report. An Actions preview does not receive
the Slack secret. Metric values never enter job logs, summaries, or uploaded artifacts.

For a local preview, supply the PostHog key through the environment and run:

```sh
python3 scripts/daily_stats.py prepare --output /tmp/prime-agent-stats.json
```

Read the JSON file locally. Do not commit or upload it: it contains business metrics.
An existing query response can be replayed without network access:

```sh
python3 scripts/daily_stats.py prepare --date YYYY-MM-DD \
  --response-file /tmp/posthog-response.json --output /tmp/prime-agent-stats.json
```

## Delivery and recovery

The workflow serializes delivery attempts and saves an artifact named
`prime-agent-stats-YYYY-MM-DD` **before** contacting Slack. It contains only the
report date and workflow run ID, retained for 90 days. Manual report dates are
limited to completed UTC days within the last 60 days. A rerun with an existing
artifact skips delivery, including a timeout whose delivery outcome is unknown.
Failed preparation creates no delivery artifact and can be rerun safely.

An interruption after saving the artifact can leave a report unsent. Check the
channel and run first. If the report was never delivered, delete that date's
artifact in GitHub Actions before rerunning with publish enabled. Do not remove
the marker for a delivered report. The script never automatically retries Slack.
Incoming webhooks cannot delete messages; deletion requires the owning bot or a
Slack administrator.

Run the synthetic tests without credentials or network access:

```sh
python3 -m unittest discover -s scripts -p test_daily_stats.py -v
```
