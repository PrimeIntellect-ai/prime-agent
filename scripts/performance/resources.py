"""Process-tree RSS snapshots scoped to explicitly owned benchmark roots."""
import subprocess


def process_tree_rss(roots: list[int]) -> dict:
    result = subprocess.run(["ps", "-axo", "pid=,ppid=,rss="], capture_output=True,
                            text=True, check=True, timeout=5)
    records = []
    for line in result.stdout.splitlines():
        pid, parent, rss = map(int, line.split())
        records.append({"pid": pid, "ppid": parent, "rss_bytes": rss * 1024})
    owned = set(roots)
    while True:
        expanded = owned | {row["pid"] for row in records if row["ppid"] in owned}
        if expanded == owned:
            break
        owned = expanded
    tree = [row for row in records if row["pid"] in owned]
    if not tree or any(root not in {row["pid"] for row in tree} for root in roots):
        raise RuntimeError("benchmark process root missing from RSS snapshot")
    return {"rss_bytes": sum(row["rss_bytes"] for row in tree), "processes": tree}
