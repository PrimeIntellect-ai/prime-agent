# Discussion notifications

New discussions trigger `.github/workflows/discussion-slack.yml`. The workflow
posts a compact title, link, category, and author to `#notifications-27-prime-agent`
and mentions Prime once. Prime's existing mention handler replies in that
notification's thread. The discussion body stays on GitHub.

This uses the same incoming-webhook delivery pattern as the platform CVE monitor.
It requires no Slack Workflow Builder trigger or discussion-specific Icarus handler.

## Slack setup

1. Ask the existing CVE/alerts app's maintainers to provision a separate incoming
   webhook for discussions under their app, after verifying its ownership and
   authorization type. The CVE workflow's use of a webhook does not establish
   that its Slack app has shared ownership.
2. Require at least two current Engineering or Infrastructure maintainers as app
   collaborators, with ownership reviewed during offboarding. Use the app's bot
   `incoming-webhook` permission; do not use a personal user token. This sender
   needs no message-history or user-token scopes.
3. In that app's **Incoming Webhooks** settings, choose **Add New Webhook to
   Workspace** and select `#notifications-27-prime-agent` (`C0BQHHJM3JA`). The
   person installing must belong to this private channel. Create a new URL for
   this channel; do not reuse or change the CVE channel's webhook.
4. Save the generated `https://hooks.slack.com/services/...` URL as the repository
   Actions secret `SLACK_DISCUSSION_WEBHOOK_URL`. Keep the URL out of source code
   and Slack messages. A Workflow Builder `/triggers/...` URL will not work here.
5. Prime (`U0BT0M2HB88`) must also be a member of the notification channel.

If the existing alerts app cannot be reused, the prepared **Prime Discussion
Alerts** app (`A0C0PF2PHV4`) is a fallback. Before installing it, add shared
maintainers through its [Collaborators settings](https://app.slack.com/app-settings/T0742S5BEHW/A0C0PF2PHV4/collaborators)
and obtain workspace approval for `incoming-webhook`. Do not activate it with
Kevin as its sole collaborator.

Slack documents that even an incoming-webhook-only app is uninstalled from its
associated workspace when its last creator or collaborator leaves. See
[Slack's app lifecycle rules](https://docs.slack.dev/app-management/distribution/#uninstalling-apps).
Shared ownership and bot authorization avoid depending on one person's account.
The GitHub workflow runs in the company repository and needs no personal GitHub
token or process running on a maintainer's computer.

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
