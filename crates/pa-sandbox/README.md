# pa-sandbox

The Prime Sandboxes lifecycle client. It calls the Prime platform REST
API with the user's Prime API key. Prime Agent bots use it to manage the
VM sandbox that hosts each bot.

## Scope

- Create (`POST /api/v1/sandbox`): `snake_case` body, `vm: true` forced,
  a fresh UUID `idempotency_key` when unset. Transient (network or
  timeout) failures retry with the same key, so a retried create never
  provisions a second sandbox. `timeout_minutes = -1` means no lifetime
  cap. A `checkpoint_id` restores a DURABLE checkpoint.
- Fetch (`GET /api/v1/sandbox/{id}`): a strict `camelCase` record. A
  malformed 200 body is a typed `invalid_response` error.
- List (`GET /api/v1/sandbox?labels=...`): every active sandbox that
  carries all the given labels, across all pages.
- Pause and resume (`POST /api/v1/sandbox/{id}/pause|resume`): the pause
  answer carries the checkpoint the pause froze. Both state changes
  finish asynchronously.
- Delete (`DELETE /api/v1/sandbox/{id}`): idempotent; a 404 is success.
- Checkpoints: create, fetch, delete (404 is success), and wait until
  `DURABLE`. `FAILED` and `DELETING` fail the wait; any other state keeps
  polling.
- VM exec: `CommandSessionClient` starts, connects to, writes stdin to, and signals a guest process over the sandbox gateway. `PlatformGatewayAuthSource` fetches the gateway credentials, and the `secrets` module lists and creates platform secrets.

## Safety contract

- No secret (the API key) appears in an error message, URL, or
  `details` preview. Error bodies become a bounded, scrubbed preview.
- Every response is strictly validated.
- Sandbox and checkpoint ids are validated before they enter a URL.
- The transport refuses redirects, so the key never hops origins.
- Everything is injected (key, base URL, transport, deadlines). Nothing
  is read from the environment or `~/.prime`.

## Non-goals

- Container (non-VM) sandboxes.
- Local validation of egress entries and header rules: the platform
  validates them.
