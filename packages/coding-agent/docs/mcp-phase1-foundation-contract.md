# MCP Phase 1 Foundation Contract

## Scope

This foundation establishes kernel-side access to configured remote HTTP MCP
servers without adding MCP tools to the model tool surface. An integration
remains a Python-backed skill: it discovers and invokes server tools through `McpIntegration`.

## Accepted behavior

- The host resolves a configured HTTP server to its URL, optional static headers,
  and a `requiresAuth` flag for the kernel.
- A server with neither `oauth` nor `bearerTokenEnvVar` is anonymous. It is
  enabled unless explicitly disabled, and its kernel connection sends its static
  headers without an `Authorization` header.
- OAuth and static-bearer configurations require credentials. For an authenticated
  connection, configured headers are retained and the resolved bearer token is
  sent as `Authorization`, taking precedence over a configured authorization
  header.
- The runtime supports both SDK streamable-HTTP transport signatures. When the
  transport takes an HTTP client, the runtime obtains that client from the MCP
  SDK factory so MCP timeout defaults, including the long SSE read timeout, are
  preserved.
- Missing `requiresAuth` from an older host response defaults to authenticated,
  preserving the prior safe behavior.

## Verification

The focused TypeScript test covers anonymous enablement and the host configuration
shape. The focused Python test covers anonymous header behavior, bearer injection,
and SDK-client timeout behavior.

## Boundary

This foundation does not implement an M01 product workflow, including server
add, list, remove, or management commands. It also does not add OAuth flow work,
security work, issue #1164 work, new transport types, or any additional MCP
protocol surface. Those changes require a separate contract.
