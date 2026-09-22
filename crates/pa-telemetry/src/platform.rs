//! Base properties for every telemetry event: product version, platform,
//! install method, execution mode, and the platform-fidelity set.
//!
//! Fidelity probes are cheap (bounded reads, no subprocesses) and memoised per
//! process; any failure degrades to `"unknown"`. Values are never faked.
//! Schema doc: `docs/telemetry-events.md` (version 1).

use std::sync::OnceLock;

use serde_json::Value;

use crate::properties::Properties;

/// Current schema version stamped on every event.
pub const SCHEMA_VERSION: u64 = 1;

const UNKNOWN: &str = "unknown";
const MAX_VERSION_LENGTH: usize = 64;

/// The `cpu_baseline` values.
const CPU_AVX2: &str = "avx2";
const CPU_NO_AVX2: &str = "no_avx2";
const CPU_NOT_APPLICABLE: &str = "not_applicable";

/// The platform-fidelity set (memoised: probes run at most once per process).
#[derive(Debug, Clone, PartialEq, Eq)]
struct PlatformFidelity {
    libc: &'static str,
    libc_version: String,
    cpu_baseline: &'static str,
    os_release: String,
    os_product_version: String,
}

/// Base properties for one event, with the given `execution_mode`.
pub fn base_properties(execution_mode: &str) -> Properties {
    let fidelity = fidelity();
    let mut properties = Properties::new();
    properties.set("version", Value::String(crate::VERSION.to_string()));
    properties.set("schema_version", Value::from(SCHEMA_VERSION));
    properties.set("os_family", Value::from(std::env::consts::OS));
    properties.set("architecture", Value::from(std::env::consts::ARCH));
    properties.set("install_method", Value::String("binary".to_string()));
    properties.set("execution_mode", Value::from(execution_mode));
    properties.set("libc", Value::from(fidelity.libc));
    properties.set("libc_version", Value::from(fidelity.libc_version.as_str()));
    properties.set("cpu_baseline", Value::from(fidelity.cpu_baseline));
    properties.set("os_release", Value::from(fidelity.os_release.as_str()));
    properties.set(
        "os_product_version",
        Value::from(fidelity.os_product_version.as_str()),
    );
    properties
}

fn fidelity() -> &'static PlatformFidelity {
    static CACHE: OnceLock<PlatformFidelity> = OnceLock::new();
    CACHE.get_or_init(detect_fidelity)
}

/// Run every probe; failures degrade to `unknown`, never panic.
fn detect_fidelity() -> PlatformFidelity {
    PlatformFidelity {
        libc: detect_libc(),
        libc_version: detect_libc_version(),
        cpu_baseline: detect_cpu_baseline(),
        os_release: sanitize_version(detect_os_release()),
        os_product_version: sanitize_version(detect_os_product_version()),
    }
}

/// C library family, from the compile-time target env.
fn detect_libc() -> &'static str {
    if cfg!(target_os = "linux") {
        if cfg!(target_env = "musl") {
            "musl"
        } else {
            "glibc"
        }
    } else {
        "none"
    }
}

/// The linked glibc version when `getconf GNU_LIBC_VERSION` output is embedded
/// at build time; the Rust standard library exposes no portable runtime probe,
/// so this stays `unknown` unless ldd-style inspection succeeded. Cheapest true
/// answer: `ldd --version` needs a subprocess, which is out of budget here.
fn detect_libc_version() -> String {
    UNKNOWN.to_string()
}

/// AVX2 availability on x86_64 via /proc/cpuinfo (Linux); not applicable off
/// x86_64; `unknown` where there is no probe.
fn detect_cpu_baseline() -> &'static str {
    if cfg!(target_arch = "x86_64") {
        if cfg!(target_os = "linux") {
            let cpuinfo = match read_text_prefix("/proc/cpuinfo", 16_384) {
                Some(text) => text,
                None => return UNKNOWN,
            };
            let flags_line = match cpuinfo.split('\n').find(|line| line.starts_with("flags")) {
                Some(line) => line,
                None => return UNKNOWN,
            };
            let flags = flags_line.split_once(':').map(|(_, rest)| rest);
            match flags {
                Some(flags) if flags.split_whitespace().any(|flag| flag == "avx2") => CPU_AVX2,
                Some(_) => CPU_NO_AVX2,
                None => UNKNOWN,
            }
        } else {
            UNKNOWN
        }
    } else {
        CPU_NOT_APPLICABLE
    }
}

/// Kernel release via /proc (Linux); `unknown` elsewhere.
fn detect_os_release() -> String {
    if cfg!(target_os = "linux") {
        read_text_prefix("/proc/sys/kernel/osrelease", 256).unwrap_or_else(|| UNKNOWN.into())
    } else {
        UNKNOWN.into()
    }
}

/// macOS product version from SystemVersion.plist; `unknown` elsewhere.
fn detect_os_product_version() -> String {
    if cfg!(target_os = "macos") {
        let plist =
            match read_text_prefix("/System/Library/CoreServices/SystemVersion.plist", 4_096) {
                Some(text) => text,
                None => return UNKNOWN.into(),
            };
        plist
            .split("<key>ProductVersion</key>")
            .nth(1)
            .and_then(|rest| {
                let start = rest.find("<string>")? + "<string>".len();
                let end = rest[start..].find("</string>")? + start;
                Some(rest[start..end].to_string())
            })
            .unwrap_or_else(|| UNKNOWN.into())
    } else {
        UNKNOWN.into()
    }
}

fn read_text_prefix(path: &str, max_bytes: usize) -> Option<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    let mut buffer = vec![0u8; max_bytes];
    let read = file.read(&mut buffer).ok()?;
    buffer.truncate(read);
    String::from_utf8(buffer).ok()
}

fn sanitize_version(value: String) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return UNKNOWN.to_string();
    }
    trimmed.chars().take(MAX_VERSION_LENGTH).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_properties_carry_schema_and_platform() {
        let properties = base_properties("interactive");
        assert_eq!(properties.get("schema_version"), Some(&Value::from(1)));
        assert_eq!(
            properties.get("version"),
            Some(&Value::from(crate::VERSION))
        );
        assert_eq!(
            properties.get("execution_mode"),
            Some(&Value::from("interactive"))
        );
        assert_eq!(
            properties.get("install_method"),
            Some(&Value::from("binary"))
        );
        assert_eq!(
            properties.get("os_family"),
            Some(&Value::from(std::env::consts::OS))
        );
        assert_eq!(
            properties.get("architecture"),
            Some(&Value::from(std::env::consts::ARCH))
        );
        // Fidelity fields are always present and never empty.
        for key in [
            "libc",
            "libc_version",
            "cpu_baseline",
            "os_release",
            "os_product_version",
        ] {
            let value = properties.get(key).and_then(Value::as_str).expect(key);
            assert!(!value.is_empty(), "{key} must not be empty");
        }
        // Every base value is a primitive.
        for (key, value) in properties.iter() {
            assert!(
                matches!(
                    value,
                    Value::String(_) | Value::Number(_) | Value::Bool(_) | Value::Null
                ),
                "{key} must be a primitive"
            );
        }
    }

    #[test]
    fn sanitize_trims_and_caps() {
        assert_eq!(
            sanitize_version("  6.8.0-45-generic ".into()),
            "6.8.0-45-generic"
        );
        assert_eq!(sanitize_version("   ".into()), UNKNOWN);
        let long = "a".repeat(MAX_VERSION_LENGTH + 10);
        assert_eq!(sanitize_version(long.clone()).len(), MAX_VERSION_LENGTH);
    }
}
