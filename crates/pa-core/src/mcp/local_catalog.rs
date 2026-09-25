//! Local user-authored MCP service sources (`mcp-services.json`, ENG-6108):
//! a bounded read of one local JSON file of service entries validated
//! against the same contract as the catalog. Port of
//! `packages/ai/src/mcp/local-catalog.ts`.
//!
//! The loader is deliberately narrow: a bounded read of a regular file +
//! JSON parse + structural validation — no execution, no network, no
//! credential access. A local file can never masquerade as trusted:
//! provenance may only claim the `user` source, `legacyBuiltin` and
//! `metadata-reviewed` review status cannot be self-asserted, audit-derived
//! `setup.readiness` cannot be self-asserted, and ids colliding with the
//! compiled built-ins are refused (no silent override/rebind of reserved
//! ids). Errors are visible and bounded: they name the file and entry index
//! and never echo raw input values.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::catalog_schema::{McpServiceEntry, ProvenanceSource, VerificationStatus};

/// Maximum accepted local source file size.
pub const MAX_LOCAL_CATALOG_BYTES: u64 = 256 * 1024;
/// Maximum accepted entries per local source file.
pub const MAX_LOCAL_CATALOG_ENTRIES: usize = 50;
/// The local read chunk (bounds how far an oversized read can go).
const READ_CHUNK: usize = 64 * 1024;

/// Validated local entries in file order (ids unique and non-reserved).
#[derive(Debug, Clone, Default)]
pub struct LocalCatalogLoadResult {
    pub entries: Vec<McpServiceEntry>,
    /// The path entries were loaded from; `None` when the file is absent.
    pub path: Option<PathBuf>,
}

/// Envelope of a local source file: `version` (exactly 1) and `entries`.
#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct LocalCatalogFile {
    version: u8,
    entries: Vec<McpServiceEntry>,
}

/// Load and validate one local service source file. A missing file is not an
/// error and yields zero entries; every problem with an existing file is a
/// returned error naming the path (and entry index where applicable).
///
/// `reserved` maps every id this installation already owns (compiled
/// built-ins plus the remote/bundled catalog) to its label; a local entry
/// colliding with any of them is refused — local sources cannot shadow or
/// rebind reserved ids.
pub fn load_local_service_catalog(
    path: &Path,
    reserved: &HashMap<String, String>,
) -> Result<LocalCatalogLoadResult, String> {
    if !path.exists() {
        return Ok(LocalCatalogLoadResult::default());
    }
    let metadata = std::fs::metadata(path).map_err(|_| {
        // Vanished between the existence check and stat: treat as absent —
        // the caller re-resolves on the next refresh.
        String::new()
    });
    let Ok(metadata) = metadata else {
        return Ok(LocalCatalogLoadResult::default());
    };
    // Only regular files (symlinks to regular files included): FIFOs,
    // sockets and devices are refused so a special file never hangs the read.
    if !metadata.is_file() {
        return Err(format!(
            "Local service source {} is not a regular file; directories, FIFOs and devices are refused",
            path.display()
        ));
    }
    let bytes = read_bounded(path, MAX_LOCAL_CATALOG_BYTES)?;
    let file: LocalCatalogFile = serde_json::from_slice(&bytes).map_err(|error| {
        let (line, column) = (error.line(), error.column());
        format!(
            "Local service source {} is not valid JSON (parse error near line {line} column {column})",
            path.display()
        )
    })?;
    if file.version != 1 {
        return Err(format!(
            "Local service source {} has an unsupported version; expected 1",
            path.display()
        ));
    }
    if file.entries.len() > MAX_LOCAL_CATALOG_ENTRIES {
        return Err(format!(
            "Local service source {} has {} entries; the maximum is {MAX_LOCAL_CATALOG_ENTRIES}",
            path.display(),
            file.entries.len()
        ));
    }
    let mut entries = Vec::with_capacity(file.entries.len());
    let mut seen_local = std::collections::HashSet::new();
    for (index, entry) in file.entries.iter().enumerate() {
        let at = format!("Local service source {}, entry {index}", path.display());
        entry.validate().map_err(|error| format!("{at}: {error}"))?;
        let id = entry.server.clone();
        if entry
            .provenance
            .iter()
            .any(|prov| prov.source != ProvenanceSource::User)
        {
            return Err(format!(
                "{at} ({id}): local entries may only carry provenance source \"user\""
            ));
        }
        if entry.provenance.is_empty() {
            return Err(format!(
                "{at} ({id}): local entries need at least one provenance record with source \"user\""
            ));
        }
        // Review status and legacy-builtin trust cannot be self-asserted.
        if entry.legacy_builtin {
            return Err(format!(
                "{at} ({id}): local entries cannot claim legacyBuiltin; it is reserved for Prime built-ins"
            ));
        }
        if entry.verification.status != VerificationStatus::Unverified {
            return Err(format!(
                "{at} ({id}): local entries cannot claim \"{}\"; local sources are always unverified",
                match entry.verification.status {
                    VerificationStatus::MetadataReviewed => "metadata-reviewed",
                    VerificationStatus::Unverified => "unverified",
                }
            ));
        }
        if entry.setup.readiness.is_some() {
            return Err(format!(
                "{at} ({id}): local entries cannot claim setup.readiness; readiness is a Prime audit assessment"
            ));
        }
        if !seen_local.insert(id.clone()) {
            return Err(format!("{at}: duplicate local id \"{id}\""));
        }
        if let Some(label) = reserved.get(&id) {
            return Err(format!(
                "{at}: id \"{id}\" collides with the bundled catalog entry for \"{label}\"; local sources cannot shadow or rebind built-ins — pick another id"
            ));
        }
        entries.push(entry.clone());
    }
    Ok(LocalCatalogLoadResult {
        entries,
        path: Some(path.to_path_buf()),
    })
}

/// Bounded read: chunked until the running total exceeds `max_bytes`, so at
/// most `max_bytes` + one chunk is ever read before an oversized file is
/// refused from the read itself.
fn read_bounded(path: &Path, max_bytes: u64) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let file = std::fs::File::open(path)
        .map_err(|_| format!("Local service source {} could not be read", path.display()))?;
    let mut reader = std::io::BufReader::new(file);
    let mut chunks: Vec<u8> = Vec::new();
    let mut total: u64 = 0;
    loop {
        let mut chunk = vec![0u8; READ_CHUNK];
        let read = reader
            .read(&mut chunk)
            .map_err(|_| format!("Local service source {} could not be read", path.display()))?;
        if read == 0 {
            break;
        }
        total += read as u64;
        if total > max_bytes {
            return Err(format!(
                "Local service source {} exceeds the maximum of {max_bytes} bytes",
                path.display()
            ));
        }
        chunk.truncate(read);
        chunks.extend_from_slice(&chunk);
    }
    Ok(chunks)
}
