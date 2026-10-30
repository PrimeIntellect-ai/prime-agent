//! Test-only shared state: one crate-wide lock for the process env.

/// Process-wide env reads and writes (the telemetry override vars, the
/// live-kernel abort test's kernel vars) serialize through one lock across
/// the crate's test modules: parallel test threads in the same binary
/// otherwise race the process env. The supervisor tests' scrub guard,
/// `agent_engine`'s `telemetry_opt_in`, and the abort tests'
/// `KernelEnvOverride` hold this lock through their restores.
#[cfg(test)]
pub(crate) static TELEMETRY_ENV_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());
