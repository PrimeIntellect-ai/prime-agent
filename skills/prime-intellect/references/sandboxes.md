# Sandboxes & Tunnels

Prime Sandboxes are disposable Docker environments for running AI-generated or untrusted code in the cloud: isolated, fast to create, billed only while running (CPU $0.05/core/hr, memory $0.01/GB/hr, disk $0.001/GB/hr).

Live docs: `sandboxes/overview.md`, `sandboxes/cli.md`, `sandboxes/sdk.md`, `sandboxes/images.md`, `sandboxes/tunnel.md` under https://docs.primeintellect.ai/

## CLI Lifecycle

```bash
prime sandbox create python:3.11-slim --timeout-minutes 120   # any Docker image
prime sandbox list
prime sandbox run <sandbox-id> "python --version"
prime sandbox get <sandbox-id>
prime sandbox delete <sandbox-id>
```

Useful create flags:

```bash
prime sandbox create python:3.11-slim \
  --name analytics-lab \
  --cpu-cores 2 --memory-gb 4 --disk-size-gb 20 \
  --timeout-minutes 240 \
  --idle-timeout-minutes 15 \
  --env APP_ENV=staging \
  --secret API_KEY=sk-abc123 \
  --start-command "python serve.py --port 8000" \
  --yes
```

- `--timeout-minutes` caps total lifetime; `--idle-timeout-minutes` reaps the sandbox early when no exec/upload/download/file-read arrives (1 ≤ idle ≤ timeout ≤ 1440; not supported with `--vm`).
- `--env` values are plain text; `--secret` values are encrypted at rest and obfuscated in output. Both become environment variables inside the container.
- Default start command is `tail -f /dev/null` (idle, ready for `prime sandbox run`); `--start-command` replaces the image ENTRYPOINT.
- Outbound internet is on by default; use `--no-network-access` for isolation when running untrusted code.
- `--team-id` bills a team; `--yes` skips confirmation in automation.

Custom images: build and push your own via Prime Images (`sandboxes/images.md`).

## Python SDK

`prime_sandboxes` ships `SandboxClient` (sync) and `AsyncSandboxClient` (async) with identical methods:

```python
from prime_sandboxes import SandboxClient, CreateSandboxRequest, APIClient

client = SandboxClient(APIClient())
sandbox = client.create(CreateSandboxRequest(
    name="sdk-demo",
    docker_image="python:3.11-slim",
    timeout_minutes=120,
    environment_vars={"LOG_LEVEL": "debug"},
    secrets={"API_KEY": "sk-abc123"},
))
client.wait_for_creation(sandbox.id)
result = client.execute_command(sandbox.id, "python -c 'print(42)'")
client.upload_file(sandbox.id, "/workspace/data.csv", "./data.csv")
client.download_file(sandbox.id, "/workspace/output.csv", "./output.csv")
exposed = client.expose(sandbox.id, port=8000, name="web")   # public URL
client.delete(sandbox.id)
```

Async variant: `async with AsyncSandboxClient() as sandboxes: await sandboxes.create(...)` — same methods, useful for fanning out many sandboxes concurrently.

## Tunnels

Prime Tunnel exposes a local (or in-sandbox) service through a secure public HTTPS URL — for dev servers, webhooks, and sharing work in progress:

```python
from prime_tunnel import Tunnel

tunnel = Tunnel(local_port=8000)
await tunnel.start()   # prints the public URL
```

Hosted evaluations can create tunnels too: launch the run with `--allow-tunnel-access` (grants tunnel permission to the temporary `PRIME_API_KEY`), then use the same flow inside the hosted sandbox.
