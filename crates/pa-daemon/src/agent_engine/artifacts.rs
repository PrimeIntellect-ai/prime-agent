//! Agent-engine artifact references (moved with their concern): the
//! sha256 artifact-id mint, the cwd-relative logical-path resolution,
//! and the epoch-millis clock.
use super::{Value, json};

/// One artifact reference (TS `createArtifactReference` in
/// modes/agent-connection/snapshot.ts): the sha256-derived id, the owning
/// session, the artifact type, and the logical path (cwd-relative when the
/// file lives under the cwd, else the basename).
pub(crate) fn artifact_reference(
    session_id: &str,
    cwd: &str,
    artifact_type: &str,
    file_path: &str,
) -> Option<Value> {
    use sha2::{Digest, Sha256};
    if file_path.is_empty() {
        return None;
    }
    let digest = Sha256::new()
        .chain_update(format!("{session_id}\0{artifact_type}\0{file_path}"))
        .finalize();
    let id = format!("artifact_{}", hex_prefix(&digest, 16));
    let mut reference = json!({
        "id": id,
        "sessionId": session_id,
        "type": artifact_type,
        "logicalPath": logical_artifact_path(cwd, file_path),
    });
    let logical = reference["logicalPath"].as_str().unwrap_or_default();
    let resolved_cwd = std::path::Path::new(cwd);
    let resolved_path = std::path::Path::new(file_path);
    if let (Ok(relative), true) = (
        resolved_path.strip_prefix(resolved_cwd),
        logical.chars().next().is_some_and(|c| c != '.' && c != '/'),
    ) {
        reference["relativePath"] = json!(relative.to_string_lossy().replace('\\', "/"));
    }
    Some(reference)
}

/// The first `len` hex characters of a digest.
pub(crate) fn hex_prefix(digest: &[u8], len: usize) -> String {
    digest
        .iter()
        .flat_map(|byte| [format!("{:02x}", byte >> 4), format!("{:02x}", byte & 0x0f)])
        .collect::<String>()
        .chars()
        .take(len)
        .collect()
}

/// TS `createArtifactPathInfo`: synthetic paths (`<...>`) stay as-is; a
/// path under the cwd keeps its cwd-relative form; anything else degrades
/// to the basename.
pub(crate) fn logical_artifact_path(cwd: &str, file_path: &str) -> String {
    if file_path.starts_with('<') && file_path.ends_with('>') {
        return file_path.to_string();
    }
    let resolved_cwd = std::path::Path::new(cwd);
    let resolved_path = std::path::Path::new(file_path);
    if let Ok(relative) = resolved_path.strip_prefix(resolved_cwd) {
        let relative = relative.to_string_lossy().replace('\\', "/");
        if !relative.is_empty() && !relative.starts_with("..") && !relative.starts_with('/') {
            return relative;
        }
    }
    std::path::Path::new(file_path).file_name().map_or_else(
        || "artifact".to_string(),
        |name| name.to_string_lossy().to_string(),
    )
}

pub(crate) fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}
