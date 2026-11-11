---
name: websearch
description: Search the web with the provider chosen in /settings (Serper or You.com Eco). Configure its API key via /mcp. Takes one query and returns titles, URLs, snippets, and (with Serper) knowledge-graph data.
---

# Web Search

Search the web with the provider chosen in `/settings` → **Agents** → **Web search provider**:
Serper (Google results, the default) or You.com Eco Search.

## Setup

Get a free API key for the chosen provider (Serper: https://serper.dev, You.com Eco:
https://you.com/platform), then run `/mcp` in Prime Agent and choose
**Serper (web search)** or **You.com Eco (web search)** to paste it.
The key is stored in Prime Agent and made available to this skill automatically.

If web search reports a missing key, walk the user through those two steps;
don't ask them to set environment variables.

Optional overrides (environment variables):

- `PRIME_AGENT_WEBSEARCH_TIMEOUT` - HTTP timeout in seconds (default 45).
- `PRIME_AGENT_WEBSEARCH_NUM_RESULTS` - number of organic results to return (default 5; You.com Eco returns at most 10).

## Usage

Call the prepared `websearch` import directly in the Python kernel:

```python
print(await websearch("latest Prime Agent release"))
```
