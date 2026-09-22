# Compute & Storage

Prime Intellect aggregates GPU capacity across providers: rent single GPU pods on demand or deploy multi-node clusters, with persistent network-attached storage.

Live docs: `cli-reference/check-gpu-availability.md`, `cli-reference/provision-gpu.md`, `cli-reference/managing-disks.md`, `tutorials-multi-node-cluster/deploy-multi-node.md`, `tutorials-storage/create-persistent-storage.md` under https://docs.primeintellect.ai/

## GPU Availability

```bash
prime availability list                        # all GPUs with pricing
prime availability list --gpu-type H100_80GB   # filter by GPU type
```

## Pods (single instances)

```bash
prime config set-ssh-key-path   # one-time: SSH key for pod access (generate on the dashboard profile page)
prime pods create               # interactive provisioning from availability data
prime pods list
prime pods ssh <pod-id>
```

Pods support custom Docker images (`tutorials-on-demand-cloud/deploy-custom-docker-image.md`). Monitor, terminate, and inspect pods from the CLI or the dashboard.

## Multi-Node Clusters

Deploy multi-node clusters (with optional Slurm orchestration) from the platform; see `tutorials-multi-node-cluster/deploy-multi-node.md` and `tutorials-multi-node-cluster/slurm-orchestration.md`. Cluster monitoring guidance lives at `tutorials-reserved-clusters/monitoring.md`.

## Storage

Persistent disks outlive individual instances and can be attached to different instances as needed:

- Create disks from the Storage tab of the Instances page (choose provider, datacenter, size), then attach them to pods or clusters.
- Manage disks from the CLI as well — see `cli-reference/managing-disks.md`.
- For multi-node shared and ephemeral storage patterns, see `tutorials-storage/cluster-storage.md`.

## Teams

Manage team membership and run resources against team billing:

```bash
prime teams list
```

Most provisioning commands accept a `--team-id` flag; the REST API equivalent is the `X-Prime-Team-ID` header.
