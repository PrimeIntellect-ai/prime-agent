# Tailscale

Prime Agent is tailnet-aware: it detects Tailscale, reports your tailnet state, and can expose local ports on your tailnet with one command. This page documents the three supported patterns.

## 1. Reach your agent from anywhere (Tailscale SSH)

The agents view is local-first: it renders in your terminal over the daemon's unix socket. To control it from any device on your tailnet, use Tailscale SSH into the host and run `prime-agent` there:

```sh
# from your laptop or phone terminal, on any tailnet device:
ssh your-agent-host
prime-agent agents
```

No port forwarding, no public exposure - Tailscale SSH authenticates with your tailnet identity. Prerequisites: Tailscale SSH must be enabled on the agent host (`tailscale up --ssh` on it, and your tailnet ACL must allow `autogroup:member` ssh access to it); plain `ssh` without Tailscale SSH enabled would fall back to a normal SSH server that may not exist or use different credentials.

## 2. Expose a local port on your tailnet (`prime-agent tailscale serve`)

Wrap `tailscale serve` for any local bridge, API, or dev server:

```sh
prime-agent tailscale serve --port 3000          # https://<host>.<tailnet>.ts.net
prime-agent tailscale serve --port 3000 --funnel # public via tailscale funnel
prime-agent tailscale                            # status: tailnet, MagicDNS name, served endpoints
```

The command refuses with a teaching error when the tailscale CLI is missing or the machine is not up on a tailnet. `prime-agent doctor` includes the same detection in its report.

## 3. Let the agent reach tailnet services (MagicDNS + containers)

A process on a tailnet machine reaches every other device by MagicDNS name (`http://db.tailnet.ts.net:5432`) with no extra wiring - the agent can already do this from the kernel. To give a CLOUD-hosted agent container tailnet access, join it to your tailnet: install the Tailscale CLI (or sidecar container) and run `tailscale up` with an auth key in the container bootstrap, then MagicDNS names resolve from inside the agent. Container note: without `/dev/net/tun` (typical for hosted containers), run tailscaled in userspace-networking mode (`tailscaled --tun=userspace-networking`) - the container then dials out through userspace networking and MagicDNS still works; `tailscale up` alone cannot create the tunnel interface in that environment.

## 4. Operate your tailnet from the agent (Tailscale MCP)

Tailscale publishes an MCP server for AI agents to operate a tailnet (list devices, manage serve/funnel). Find the current endpoint in Tailscale's docs (https://tailscale.com/kb - search "MCP"), then add it as a remote MCP server:

```sh
prime-agent mcp add remote --url https://<current-tailscale-mcp-endpoint>
```

References: https://tailscale.com/kb (Serve/Funnel, MagicDNS, container patterns, MCP).
