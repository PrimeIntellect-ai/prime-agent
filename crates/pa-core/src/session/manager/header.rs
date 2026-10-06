//! The header + rlm-depth concern: the first-line header read, the depth
//! validation, and the root depth from the environment.

use super::{Path, SessionHeader};

#[must_use]
pub fn read_session_header(file_path: &Path) -> Option<SessionHeader> {
    use std::io::BufRead;
    let file = std::fs::File::open(file_path).ok()?;
    let mut first_line = String::new();
    std::io::BufReader::new(file)
        .read_line(&mut first_line)
        .ok()?;
    let wrapper: SessionHeaderWrapper = serde_json::from_str(&first_line).ok()?;
    Some(wrapper.header)
}

#[derive(serde::Deserialize)]
struct SessionHeaderWrapper {
    #[serde(flatten)]
    header: SessionHeader,
}

pub(super) fn is_valid_rlm_depth(value: Option<u64>) -> bool {
    value.is_some_and(|depth| depth < u64::MAX)
}

pub(super) fn root_rlm_depth_from_env() -> u64 {
    match std::env::var("RLM_DEPTH") {
        Ok(value) if value.is_empty() => 0,
        Ok(value) => value
            .parse::<u64>()
            .ok()
            .filter(|depth| is_valid_rlm_depth(Some(*depth)))
            .unwrap_or_else(|| panic!("RLM_DEPTH must be a non-negative integer")),
        Err(_) => 0,
    }
}

pub(super) fn resolve_session_rlm_depth(header: &SessionHeader, _session_path: &Path) -> u64 {
    if is_valid_rlm_depth(header.rlm_depth) {
        return header.rlm_depth.unwrap();
    }
    0
}
