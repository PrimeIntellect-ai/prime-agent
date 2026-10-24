# Google Drive and Google Sheets MCP servers

Google hosts official remote MCP servers for Drive and Sheets:

- Drive: `https://drivemcp.googleapis.com/mcp/v1`
- Sheets: `https://sheetsmcp.googleapis.com/mcp/v1`

They are in the
[Google Workspace Developer Preview Program](https://developers.google.com/workspace/preview).
Google offers no dynamic client registration and requires a client secret, so
there is no one-click login. You create your own OAuth client in Google Cloud
and add it to Prime Agent's `mcpServers` setting. Google's own setup guide is
[Configure the Google Workspace MCP servers](https://developers.google.com/workspace/guides/configure-mcp-servers).

## 1. Google Cloud project

1. Use a Google Cloud project whose organization or account is enrolled in the
   Workspace Developer Preview Program.
2. Enable the product APIs and the MCP services:

   ```bash
   gcloud services enable drive.googleapis.com sheets.googleapis.com \
     drivemcp.googleapis.com sheetsmcp.googleapis.com --project=PROJECT_ID
   ```

3. In **Google Auth Platform > Branding**, configure the consent screen. Choose
   the **Internal** audience if you can: the app is then limited to your
   Workspace organization and needs no Google verification. With **External**,
   add yourself as a test user; Google expires refresh tokens of apps in
   testing after 7 days.
4. In **Data Access**, add the scopes you will request:
   `https://www.googleapis.com/auth/drive.readonly` for Drive, and also
   `https://www.googleapis.com/auth/spreadsheets` for Sheets.

## 2. OAuth client

In **Google Auth Platform > Clients > Create Client**:

1. Application type: **Web application**.
2. Authorized redirect URI: `http://localhost:<port>/callback`, for a free local
   port you choose, for example `http://localhost:8719/callback`.
3. Select **Use this client for an AI-powered agent**. Google rejects MCP
   requests from clients without this flag.
4. Create the client and copy the client ID and client secret.

## 3. Prime Agent settings

Add the servers to `mcpServers` in the user-level settings file
`~/.prime/agent/settings.json`. A project's `.prime/agent/settings.json` is
merged into `mcpServers` too, but never put `clientSecret` there: project
settings usually live in a repository.

```json
{
  "mcpServers": {
    "google-drive": {
      "type": "http",
      "url": "https://drivemcp.googleapis.com/mcp/v1",
      "oauth": true,
      "clientId": "CLIENT_ID.apps.googleusercontent.com",
      "clientSecret": "CLIENT_SECRET",
      "callbackPort": 8719,
      "scopes": "https://www.googleapis.com/auth/drive.readonly"
    },
    "google-sheets": {
      "type": "http",
      "url": "https://sheetsmcp.googleapis.com/mcp/v1",
      "oauth": true,
      "clientId": "CLIENT_ID.apps.googleusercontent.com",
      "clientSecret": "CLIENT_SECRET",
      "callbackPort": 8719,
      "scopes": "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/spreadsheets",
      "callTimeoutMs": 300000
    }
  }
}
```

- `callbackPort` must match the redirect URI registered on the client.
- `scopes` is space-separated. Without it, Prime Agent requests every scope the
  server advertises, which includes full `drive` access.
- `callTimeoutMs` raises the default 60 s tool-call timeout for large writes.

Then run `/mcp login google-drive` and `/mcp login google-sheets` inside Prime
Agent and finish Google's consent screen in the browser. Prime Agent asks Google
for offline access, so the stored grant includes a refresh token and renews
itself. The client secret stays in settings (it is not copied into the stored
login grant) and is sent to Google only on token requests. For SSH sessions, forward the callback port or paste the final
redirect URL into the auth panel.

## Tools

Read each tool's `inputSchema` with `mcp.describe_tool` before calling it.

| Task | Server | Tool |
| --- | --- | --- |
| File metadata | Drive | `get_file_metadata` (`excludeContentSnippets: true` skips the content snippet) |
| Download a file | Drive | `download_file_content` |
| Spreadsheet metadata | Sheets | `get_spreadsheet` with a `fields` mask, for example `["sheets.properties"]` |
| Atomic batch update | Sheets | `update_spreadsheet` (`spreadsheets.batchUpdate`: all requests apply or none do; pass `writeControl.requiredRevisionId` to reject a stale revision) |
| Typed values | Sheets | `get_spreadsheet` with grid data, see below |

`get_values` returns formatted strings and has no `valueRenderOption`. For
unformatted typed values, read the effective values through `get_spreadsheet`:

```python
grid = await mcp.call_tool("google-sheets", "get_spreadsheet", {
    "spreadsheetId": spreadsheet_id,
    "ranges": ["Ledger!A1:F2000"],
    "includeGridData": True,
    "fields": ["sheets.data.rowData.values.effectiveValue"],
})
```

Each cell's `effectiveValue` carries `numberValue`, `stringValue`, or
`boolValue`; dates come back as serial numbers.

For large or exact payloads, follow the "Large or integrity-critical payloads"
section of the `mcp` skill (`skills/mcp/SKILL.md`): load the arguments from a
file in the Python kernel, write results to a file, and verify them in code.

Disconnect with `/mcp logout google-drive` (or `google-sheets`).
