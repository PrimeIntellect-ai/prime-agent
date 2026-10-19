# Slack MCP connector

Open `/mcp` (or `/plugins`), search for **Slack**, and connect. You can also
run `/mcp login slack` inside Prime Agent. Complete Slack's consent screen in
your browser. The connection becomes available to the current session through
the generic `mcp` Python API:

```python
tools = await mcp.list_tools("slack")
# Read the returned inputSchema before calling a tool.
```

Prime Agent connects to Slack's hosted Streamable HTTP server at
`https://mcp.slack.com/mcp`. It uses the public desktop OAuth client published
in [Slack's agent harness guide](https://docs.slack.dev/ai/slack-mcp-server/connect-to-harnesses/):
client ID `1601185624273.8899143856786` and callback
`http://localhost:3118/callback`. This is the client used by Slack's Claude Code
plugin, so Slack's consent screen may identify the app as Claude. Prime Agent
uses PKCE and state validation, then stores the grant in its own auth store;
no Claude installation or credentials are needed.

Slack does not offer dynamic client registration. Workspace administrators
still control app approval and granted scopes. The desktop client registration
is controlled by Slack and its partner; changes there can require an update.

If port `3118` is occupied, finish or close the other login attempt and retry.
Prime Agent reports the conflict instead of redirecting to an unregistered
port. For SSH sessions, forward local port `3118` to port `3118` on the host
running Prime Agent, or paste the final redirect URL into the auth panel.

Disconnect with `/mcp logout slack`. Connector usage contributes to the existing
`mcp_connector_use_count` session telemetry counter; server names and Slack
content are not recorded in that counter.
