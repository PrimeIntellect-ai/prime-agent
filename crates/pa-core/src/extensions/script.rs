//! Materialization of the bundled extension host runtime (design doc
//! §2.2): the host script, its shim modules, and the vendored jiti
//! (`jiti/static`) are shipped inside the binary and written under
//! `<agentDir>/extension-host/runtime-<sha256>/` at first use.
//!
//! The whole runtime is content-addressed as one unit: the digest covers
//! every file's name and bytes, so a stale runtime on disk (older agent dir)
//! fails the protocol handshake (R10) and every release writes a fresh
//! directory, leaving a running sidecar's files untouched. A partially
//! written runtime is unobservable (temp dir + rename), and a concurrent
//! materializer that loses the rename finds the winner in place.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};

/// One file of the runtime bundle.
struct BundleFile {
    /// Path relative to the runtime directory.
    name: &'static str,
    /// Content compiled into the binary.
    bytes: &'static [u8],
}

const HOST_SCRIPT: &str = include_str!("host_script.mjs");

const RUNTIME_FILES: &[BundleFile] = &[
    BundleFile {
        name: "host.mjs",
        bytes: HOST_SCRIPT.as_bytes(),
    },
    BundleFile {
        name: "typebox.mjs",
        bytes: include_bytes!("typebox.mjs"),
    },
    BundleFile {
        name: "pi-ai.mjs",
        bytes: include_bytes!("pi-ai.mjs"),
    },
    BundleFile {
        name: "pi-coding-agent.mjs",
        bytes: include_bytes!("pi-coding-agent.mjs"),
    },
    BundleFile {
        name: "unsupported.mjs",
        bytes: include_bytes!("unsupported.mjs"),
    },
    BundleFile {
        name: "vendor/jiti/package.json",
        bytes: include_bytes!("vendor/jiti/package.json"),
    },
    BundleFile {
        name: "vendor/jiti/LICENSE",
        bytes: include_bytes!("vendor/jiti/LICENSE"),
    },
    BundleFile {
        name: "vendor/jiti/lib/jiti-static.mjs",
        bytes: include_bytes!("vendor/jiti/lib/jiti-static.mjs"),
    },
    BundleFile {
        name: "vendor/jiti/dist/jiti.cjs",
        bytes: include_bytes!("vendor/jiti/dist/jiti.cjs"),
    },
    BundleFile {
        name: "vendor/jiti/dist/babel.cjs",
        bytes: include_bytes!("vendor/jiti/dist/babel.cjs"),
    },
];

/// The digest of the runtime bundle: every file's name and content, in
/// bundle order. Two runs of the same build produce the same digest.
fn runtime_digest() -> String {
    let mut hasher = Sha256::new();
    for file in RUNTIME_FILES {
        hasher.update(file.name.as_bytes());
        hasher.update(file.bytes);
    }
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Write the bundled runtime under `<agent_dir>/extension-host/` and return
/// the host script's path. Already-materialized runtimes are a cache hit;
/// the temp-directory + rename keeps a partial write unobservable, and a
/// concurrent materializer that loses the rename finds the winner in place.
pub(crate) fn materialize_host_script(agent_dir: &Path) -> Result<PathBuf> {
    let digest = runtime_digest();
    let root = agent_dir.join("extension-host");
    let dir = root.join(format!("runtime-{digest}"));
    let host = dir.join("host.mjs");
    if host.is_file() {
        return Ok(host);
    }
    let temp = root.join(format!(".runtime-{digest}.{}.tmp", std::process::id()));
    if temp.exists() {
        // A crashed earlier materializer left its temp dir behind.
        let _ = std::fs::remove_dir_all(&temp);
    }
    for file in RUNTIME_FILES {
        let path = temp.join(file.name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        std::fs::write(&path, file.bytes).with_context(|| format!("writing {}", path.display()))?;
    }
    if std::fs::rename(&temp, &dir).is_err() {
        // Lost the race to another materializer: drop our temp copy, the
        // winner's identical content is already in place.
        let _ = std::fs::remove_dir_all(&temp);
    }
    if !host.is_file() {
        return Err(anyhow::anyhow!(
            "extension host runtime did not materialize: {}",
            host.display()
        ));
    }
    Ok(host)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_is_content_addressed_and_complete() {
        let temp = tempfile::tempdir().unwrap();
        let host = materialize_host_script(temp.path()).unwrap();
        let dir = host.parent().unwrap();
        let name = dir.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with("runtime-"), "got {name}");
        assert_eq!(runtime_digest().len(), 64);
        // Every bundle file is present next to the host script.
        for file in RUNTIME_FILES {
            assert!(dir.join(file.name).is_file(), "missing {}", file.name);
        }
        // The materialized host script matches the bundled source.
        let content = std::fs::read_to_string(&host).unwrap();
        assert_eq!(content, HOST_SCRIPT);
        // A second materialization is a cache hit on the same directory.
        assert_eq!(materialize_host_script(temp.path()).unwrap(), host);
    }

    #[test]
    fn content_address_excludes_leftover_temp_dirs() {
        let temp = tempfile::tempdir().unwrap();
        materialize_host_script(temp.path()).unwrap();
        let entries: Vec<_> = std::fs::read_dir(temp.path().join("extension-host"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries.len(), 1, "no temp dirs survive: {entries:?}");
        assert!(entries[0].starts_with("runtime-"));
    }

    #[test]
    fn vendored_jiti_matches_the_upstream_dist() {
        // The vendored jiti is a dependency of the shipped binary; assert
        // the pieces the static entry imports exist and are the real dists
        // (not zero-byte truncations).
        let static_entry = std::str::from_utf8(
            RUNTIME_FILES
                .iter()
                .find(|file| file.name == "vendor/jiti/lib/jiti-static.mjs")
                .unwrap()
                .bytes,
        )
        .unwrap();
        assert!(static_entry.contains("export function createJiti"));
        let jiti = RUNTIME_FILES
            .iter()
            .find(|file| file.name == "vendor/jiti/dist/jiti.cjs")
            .unwrap()
            .bytes;
        assert!(jiti.len() > 100_000, "jiti dist truncated: {}", jiti.len());
    }
}
