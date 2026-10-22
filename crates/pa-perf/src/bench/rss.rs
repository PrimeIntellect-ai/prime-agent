//! Immediate Linux process-tree RSS for the harness-owned roots.

use std::collections::{BTreeMap, BTreeSet};

/// One `/proc/<pid>` row of the snapshot: the tree edge and the resident set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ProcRow {
    pid: i32,
    ppid: i32,
    /// Missing VmRSS counts as zero for a process that still belongs to the tree.
    rss_bytes: Option<u64>,
}

/// The `PPid:` value of a `/proc/<pid>/status` body.
fn parse_ppid(status: &str) -> Option<i32> {
    status
        .lines()
        .find_map(|line| line.strip_prefix("PPid:")?.trim().parse().ok())
}

/// The `VmRSS:` value of a `/proc/<pid>/status` body, in bytes.
fn parse_rss(status: &str) -> Option<u64> {
    let kb = status.lines().find_map(|line| {
        let value = line.strip_prefix("VmRSS:")?.trim().strip_suffix(" kB")?;
        value.trim().parse::<u64>().ok()
    })?;
    Some(kb * 1024)
}

/// Sum each owned process once; a missing root fails the sample.
fn tree_rss_bytes(rows: &[ProcRow], roots: &[i32]) -> anyhow::Result<u64> {
    anyhow::ensure!(
        !roots.is_empty(),
        "an RSS sample needs at least one owned root"
    );
    let by_pid: BTreeMap<i32, ProcRow> = rows.iter().map(|row| (row.pid, *row)).collect();
    let mut children: BTreeMap<i32, Vec<i32>> = BTreeMap::new();
    for row in rows {
        children.entry(row.ppid).or_default().push(row.pid);
    }
    let mut total = 0u64;
    let mut seen: BTreeSet<i32> = BTreeSet::new();
    let mut queue: Vec<i32> = Vec::new();
    for &root in roots {
        anyhow::ensure!(
            by_pid.contains_key(&root),
            "the owned pid {root} is missing from the /proc snapshot"
        );
        if seen.insert(root) {
            total += by_pid[&root].rss_bytes.unwrap_or(0);
            queue.extend(children.get(&root).into_iter().flatten().copied());
        }
    }
    while let Some(pid) = queue.pop() {
        if seen.insert(pid) {
            total += by_pid[&pid].rss_bytes.unwrap_or(0);
            queue.extend(children.get(&pid).into_iter().flatten().copied());
        }
    }
    Ok(total)
}

/// Read one procfs snapshot and sum the owned process trees.
pub(super) fn sample(
    tui_pid: i32,
    held_pid: Option<i32>,
    daemon_pid: Option<i32>,
) -> anyhow::Result<Option<u64>> {
    let mut roots = vec![tui_pid];
    roots.extend(held_pid);
    roots.extend(daemon_pid);
    let mut rows = Vec::new();
    for entry in std::fs::read_dir("/proc")? {
        let entry = entry?;
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<i32>().ok())
        else {
            continue;
        };
        let Ok(status) = std::fs::read_to_string(entry.path().join("status")) else {
            continue;
        };
        let Some(ppid) = parse_ppid(&status) else {
            continue;
        };
        rows.push(ProcRow {
            pid,
            ppid,
            rss_bytes: parse_rss(&status),
        });
    }
    Ok(Some(tree_rss_bytes(&rows, &roots)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(pid: i32, ppid: i32, rss_kb: Option<u64>) -> String {
        let rss = rss_kb.map_or_else(String::new, |kb| {
            format!("VmPeak:\t  {kb} kB\nVmSize:\t  {kb} kB\nVmRSS:\t  {kb} kB\n")
        });
        format!(
            "Name:\tprime-agent\nState:\tS (sleeping)\nPid:\t{pid}\nPPid:\t{ppid}\n{rss}Threads:\t1\n"
        )
    }

    #[test]
    fn the_parsers_read_ppid_and_vm_rss_from_a_status_body() {
        let body = status(4242, 17, Some(8_192));
        assert_eq!(parse_ppid(&body), Some(17));
        assert_eq!(parse_rss(&body), Some(8_192 * 1024));
    }

    #[test]
    fn a_status_without_vm_rss_parses_an_absent_rss() {
        let body = status(1, 0, None);
        assert_eq!(parse_ppid(&body), Some(0));
        assert_eq!(parse_rss(&body), None);
    }

    fn row(pid: i32, ppid: i32, rss_kb: u64) -> ProcRow {
        ProcRow {
            pid,
            ppid,
            rss_bytes: Some(rss_kb * 1024),
        }
    }

    #[test]
    fn the_tree_sum_covers_the_owned_descendants_and_excludes_the_host() {
        // tui -> daemon -> worker -> kernel, plus unrelated host processes.
        let rows = [
            row(1, 0, 10),
            row(2, 1, 20),
            row(3, 2, 30),
            row(4, 3, 40),
            row(90, 80, 500),
            row(91, 90, 600),
            ProcRow {
                pid: 92,
                ppid: 90,
                rss_bytes: None,
            },
        ];
        assert_eq!(
            tree_rss_bytes(&rows, &[1]).expect("the tui-rooted tree"),
            (10 + 20 + 30 + 40) * 1024
        );
    }

    #[test]
    fn overlapping_roots_count_the_shared_tree_once() {
        let rows = [row(1, 0, 10), row(2, 1, 20), row(3, 2, 30)];
        // Both roots must not double-count the shared subtree.
        assert_eq!(
            tree_rss_bytes(&rows, &[1, 2]).expect("the overlapping roots"),
            (10 + 20 + 30) * 1024
        );
    }

    #[test]
    fn disjoint_roots_sum_both_owned_trees() {
        // The warm shape: the harness-owned daemon and the TUI are siblings.
        let rows = [row(1, 0, 10), row(2, 1, 20), row(5, 0, 50), row(6, 5, 60)];
        assert_eq!(
            tree_rss_bytes(&rows, &[1, 5]).expect("the disjoint roots"),
            (10 + 20 + 50 + 60) * 1024
        );
    }

    #[test]
    fn a_root_missing_from_the_snapshot_fails_instead_of_sampling_zero() {
        let rows = [row(1, 0, 10)];
        assert!(tree_rss_bytes(&rows, &[2]).is_err());
        assert!(tree_rss_bytes(&rows, &[]).is_err());
    }
}
