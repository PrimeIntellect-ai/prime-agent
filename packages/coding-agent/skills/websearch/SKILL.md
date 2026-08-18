---
name: websearch
description: Search Google via the Serper API. Configure access via /login, then MCP Connections, then Serper (web search). Takes one query and returns titles, URLs, snippets, and knowledge-graph data.
---

# Web Search

Search the web via the Serper Google Search API.

## Setup

Get a free API key at https://serper.dev, then run `/login` in Prime Agent,
switch to **MCP Connections**, and choose **Serper (web search)** to paste it.
The key is stored in Prime Agent and made available to this skill automatically.

If web search reports a missing key, walk the user through those two steps;
don't ask them to set environment variables.

Optional overrides (environment variables):

- `PRIME_AGENT_WEBSEARCH_TIMEOUT` - HTTP timeout in seconds (default 45).
- `PRIME_AGENT_WEBSEARCH_NUM_RESULTS` - number of organic results to return (default 5).

## Usage

Call the prepared `websearch` import directly in the IPython kernel:

```python
print(await websearch("latest Prime Agent release"))
```
