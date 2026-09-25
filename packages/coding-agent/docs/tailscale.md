# Tailscale (agent mesh)

Prime Agent is tailnet-aware: it detects Tailscale on this machine, reports your tailnet state, and can expose local ports on your tailnet. This detection is the foundation of the Tailscale agent mesh: seeing your agents across tailnet machines, and messaging or spawning them from any machine.

## Detection: `prime-agent tailscale`

```sh
prime-agent tailscale            # tailnet state, MagicDNS name, served endpoints
prime-agent tailscale --json     # machine-readable form
prime-agent doctor               # includes the same detection as a one-line fact
```

The command reports whether the tailscale CLI is installed, whether this machine is up on a tailnet (including up but currently offline), the MagicDNS suffix, and this node's hostname. `probeTailscale()` in `src/cli/tailscale.ts` is the detection seam the mesh builds on.

## Expose a local port: `prime-agent tailscale serve`

```sh
prime-agent tailscale serve --port 3000          # https://<host>.<tailnet>.ts.net
prime-agent tailscale serve --port 3000 --funnel # public via tailscale funnel
```

The wrapper refuses with a teaching error when the CLI is missing or the machine is not up on a tailnet, and verifies after `tailscale serve` exits that the target is actually being served.

## The mesh: remote agents on your tailnet

The agent mesh treats depth-0 sessions on your tailnet machines as siblings. The agents view lists remote sessions labeled with the tailscale connection each is running on, and you can message or spawn them from any machine on the tailnet. The mesh ships in stages on top of this detection: this first stage adds the detection core (`tailscale status`, serve/funnel exposure, doctor facts); peer discovery, the agents-view tailnet labels, and cross-machine messaging/spawn follow.
