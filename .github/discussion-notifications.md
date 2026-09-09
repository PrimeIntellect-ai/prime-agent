# Discussion notifications

New discussions trigger `.github/workflows/discussion-slack.yml`. The workflow
posts a compact title, link, category, and author to `#notifications-27-prime-agent`
and mentions Prime once. Prime's existing mention handler replies in that
notification's thread. The discussion body stays on GitHub.

This uses the same incoming-webhook delivery pattern as the platform CVE monitor.
It requires no Slack Workflow Builder trigger or discussion-specific Icarus handler.

## Slack setup

1. Approve **Prime Discussion Alerts** (app ID `A0C0PF2PHV4`) in the Prime Intellect
   workspace. Its only required OAuth scope is `incoming-webhook`.
2. In the [app's Incoming Webhooks settings](https://api.slack.com/apps/A0C0PF2PHV4/incoming-webhooks),
   choose **Add New Webhook to Workspace** and select `#notifications-27-prime-agent`
   (`C0BQHHJM3JA`). The person installing must belong to this private channel.
3. Save the generated `https://hooks.slack.com/services/...` URL as the repository
   Actions secret `SLACK_DISCUSSION_WEBHOOK_URL`. Keep the URL out of source code
   and Slack messages. A Workflow Builder `/triggers/...` URL will not work here.
4. Prime (`U0BT0M2HB88`) must also be a member of the notification channel.

## Verify and activate

Send one compact notification through the webhook and verify that Prime replies
under that message. Confirm that Prime can retrieve the linked discussion and
perform the requested investigation before enabling unattended triage. Repository
checkout access alone does not provide access to discussion bodies; Icarus also
needs a general capability to read the linked GitHub discussion.

Merge the workflow into `main` when ready. GitHub only runs `discussion` event
workflows that exist on the default branch. After the first real discussion is
delivered and receives a Prime response, remove the native GitHub app's discussion
subscription in the notification channel:

```text
/github unsubscribe PrimeIntellect-ai/prime-agent discussions
```

That command leaves the repository's other GitHub subscriptions intact. Subsequent
comments and edits do not create new notifications. The workflow does not retry
ambiguous delivery failures: inspect Slack before manually rerunning a failed job
to avoid another notification and Prime invocation.

To pause the sender, disable **Discussion notifications** in GitHub Actions. If
restoring the native feed, subscribe to `discussions` again in the same channel.
