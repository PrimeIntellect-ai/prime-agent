//! Base properties for every telemetry event: product version, platform,
//! install method, execution mode, and the platform-fidelity set.
//!
//! Fidelity probes are cheap (bounded reads, no subprocesses) and memoised per
//! process; any failure degrades to `"unknown"`. Values are never faked.

use std::sync::OnceLock;

use serde_json::Value;

use crate::properties::Properties;

/// Current schema version stamped on every event (the catalog's version).
pub use crate::catalog::SCHEMA_VERSION;

const UNKNOWN: &str = "unknown";
const MAX_VERSION_LENGTH: usize = 64;

/// The catalog's property-rule revision (additive rule changes bump it).
pub const SCHEMA_REVISION: u64 = 3;

/// The `cpu_baseline` values.
const CPU_AVX2: &str = "avx2";
const CPU_NO_AVX2: &str = "no_avx2";
const CPU_AVX2_ASSUMED: &str = "avx2_assumed";
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
#[must_use]
pub fn base_properties(execution_mode: &str) -> Properties {
    let fidelity = fidelity();
    let mut properties = Properties::new();
    properties.set("version", Value::from(crate::version()));
    properties.set("schema_version", Value::from(SCHEMA_VERSION));
    // #2117/v2 common properties: the build channel, the workload origin
    // (env override first, then the execution mode), and the catalog's
    // property-rule revision.
    properties.set("build_channel", Value::from(build_channel()));
    properties.set(
        "workload_origin",
        Value::from(workload_origin(execution_mode)),
    );
    properties.set("schema_revision", Value::from(SCHEMA_REVISION));
    properties.set("os_family", Value::from(os_family()));
    properties.set("architecture", Value::from(architecture()));
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

/// The OS in the TS product's vocabulary (Node `os.platform()`), so the
/// Rust and TS populations land in the same `os_family` buckets.
fn os_family() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// The CPU architecture in the TS product's vocabulary (Node `os.arch()`).
fn architecture() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        "powerpc64" => "ppc64",
        "loongarch64" => "loong64",
        other => other,
    }
}

/// The build channel: debug builds are `development`, versions carrying a
/// `beta` prerelease are `prerelease`, everything else `release`.
fn build_channel() -> &'static str {
    if cfg!(debug_assertions) {
        return "development";
    }
    let version = crate::version();
    if version.contains('-') && version.contains("beta") {
        return "prerelease";
    }
    "release"
}

/// The workload origin: `PRIME_AGENT_TELEMETRY_ORIGIN=internal|test` wins;
/// otherwise the interactive execution mode is `interactive` and every
/// headless mode is `automated` (the mode alone never identifies internal
/// populations).
fn workload_origin(execution_mode: &str) -> &'static str {
    match std::env::var("PRIME_AGENT_TELEMETRY_ORIGIN")
        .ok()
        .as_deref()
        .map(str::trim)
    {
        Some("internal") => return "internal",
        Some("test") => return "test",
        _ => {}
    }
    if execution_mode == "interactive" {
        "interactive"
    } else {
        "automated"
    }
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
        os_release: sanitize_version(&detect_os_release()),
        os_product_version: sanitize_version(&detect_os_product_version()),
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

/// The running glibc version (TS `glibcVersionRuntime`, e.g. `2.39`) on
/// glibc Linux builds: the loaded `libc.so.6` (found in `/proc/self/maps`)
/// carries its banner `... stable release version 2.39.`; `unknown`
/// elsewhere or when the probe fails.
fn detect_libc_version() -> String {
    if cfg!(all(target_os = "linux", target_env = "gnu")) {
        loaded_glibc_version().unwrap_or_else(|| UNKNOWN.to_string())
    } else {
        UNKNOWN.to_string()
    }
}

fn loaded_glibc_version() -> Option<String> {
    let maps = read_text_prefix("/proc/self/maps", 1 << 20)?;
    let path = maps
        .lines()
        .filter_map(|line| line.split_whitespace().nth(5))
        .find(|path| path.ends_with("/libc.so.6"))?;
    let library = std::fs::read(path).ok()?;
    glibc_banner_version(&library)
}

fn glibc_banner_version(library: &[u8]) -> Option<String> {
    let marker = b"release version ";
    let start = library
        .windows(marker.len())
        .position(|window| window == marker)?
        + marker.len();
    let version: String = library[start..]
        .iter()
        .take(16)
        .take_while(|byte| byte.is_ascii_digit() || **byte == b'.')
        .map(|&byte| char::from(byte))
        .collect();
    let version = version.trim_end_matches('.');
    (!version.is_empty()).then(|| version.to_string())
}

/// AVX2 availability on `x86_64` via /proc/cpuinfo (Linux); not applicable off
/// `x86_64`; `unknown` where there is no probe.
fn detect_cpu_baseline() -> &'static str {
    if cfg!(target_arch = "x86_64") {
        if cfg!(target_os = "linux") {
            let Some(cpuinfo) = read_text_prefix("/proc/cpuinfo", 16_384) else {
                return UNKNOWN;
            };
            let Some(flags_line) = cpuinfo.split('\n').find(|line| line.starts_with("flags"))
            else {
                return UNKNOWN;
            };
            let flags = flags_line.split_once(':').map(|(_, rest)| rest);
            match flags {
                Some(flags) if flags.split_whitespace().any(|flag| flag == "avx2") => CPU_AVX2,
                Some(_) => CPU_NO_AVX2,
                None => UNKNOWN,
            }
        } else if cfg!(target_os = "macos") {
            // TS parity: every Intel Mac that runs a supported macOS has
            // AVX2; the distinct value keeps the inference visible.
            CPU_AVX2_ASSUMED
        } else {
            UNKNOWN
        }
    } else {
        CPU_NOT_APPLICABLE
    }
}

/// The kernel release (TS `os.release()`: `uname -r` on Linux and macOS);
/// `unknown` on Windows, where this build has no probe.
fn detect_os_release() -> String {
    #[cfg(unix)]
    {
        rustix::system::uname()
            .release()
            .to_string_lossy()
            .into_owned()
    }
    #[cfg(not(unix))]
    {
        UNKNOWN.into()
    }
}

/// macOS product version from SystemVersion.plist; `unknown` elsewhere.
fn detect_os_product_version() -> String {
    if cfg!(target_os = "macos") {
        let Some(plist) =
            read_text_prefix("/System/Library/CoreServices/SystemVersion.plist", 4_096)
        else {
            return UNKNOWN.into();
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

/// Up to `max_bytes` of a text file. Reads until EOF or the cap: procfs
/// files answer one page per `read`, so a single read would truncate them.
fn read_text_prefix(path: &str, max_bytes: usize) -> Option<String> {
    use std::io::Read;
    let file = std::fs::File::open(path).ok()?;
    let mut buffer = Vec::new();
    file.take(max_bytes as u64).read_to_end(&mut buffer).ok()?;
    String::from_utf8_lossy(&buffer).into_owned().into()
}

fn sanitize_version(value: &str) -> String {
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
        // The #2117 vocabulary bumped the catalog to schema version 2.
        assert_eq!(
            properties.get("schema_version"),
            Some(&Value::from(SCHEMA_VERSION))
        );
        assert_eq!(properties.get("schema_version"), Some(&Value::from(2u64)));
        assert_eq!(
            properties.get("schema_revision"),
            Some(&Value::from(SCHEMA_REVISION))
        );
        assert_eq!(
            properties.get("build_channel"),
            Some(&Value::from(build_channel()))
        );
        assert_eq!(
            properties.get("workload_origin"),
            Some(&Value::from("interactive"))
        );
        assert_eq!(
            base_properties("print").get("workload_origin"),
            Some(&Value::from("automated"))
        );
        assert_eq!(
            properties.get("version"),
            Some(&Value::from(crate::version()))
        );
        assert_eq!(
            properties.get("execution_mode"),
            Some(&Value::from("interactive"))
        );
        assert_eq!(
            properties.get("install_method"),
            Some(&Value::from("binary"))
        );
        assert_eq!(properties.get("os_family"), Some(&Value::from(os_family())));
        assert_eq!(
            properties.get("architecture"),
            Some(&Value::from(architecture()))
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

    /// The TS (Node) vocabulary the existing dashboards group by.
    #[test]
    fn platform_names_use_the_ts_vocabulary() {
        let os = os_family();
        assert!(["linux", "darwin", "win32", "freebsd", "android"].contains(&os) || !os.is_empty());
        assert_ne!(os, "macos");
        assert_ne!(os, "windows");
        let arch = architecture();
        assert_ne!(arch, "x86_64");
        assert_ne!(arch, "aarch64");
        if cfg!(target_arch = "x86_64") {
            assert_eq!(arch, "x64");
        }
        if cfg!(target_os = "linux") {
            assert_eq!(os, "linux");
        }
    }

    #[test]
    fn the_glibc_banner_parses() {
        let banner =
            b"\0GNU C Library (Ubuntu GLIBC 2.39-0ubuntu8.4) stable release version 2.39.\n\0";
        assert_eq!(glibc_banner_version(banner).as_deref(), Some("2.39"));
        assert_eq!(glibc_banner_version(b"no banner here"), None);
        if cfg!(all(target_os = "linux", target_env = "gnu")) {
            let version = detect_libc_version();
            assert!(version.starts_with("2."), "the running glibc: {version}");
        }
    }

    #[test]
    fn sanitize_trims_and_caps() {
        assert_eq!(sanitize_version("  6.8.0-45-generic "), "6.8.0-45-generic");
        assert_eq!(sanitize_version("   "), UNKNOWN);
        let long = "a".repeat(MAX_VERSION_LENGTH + 10);
        assert_eq!(sanitize_version(&long).len(), MAX_VERSION_LENGTH);
    }
}
