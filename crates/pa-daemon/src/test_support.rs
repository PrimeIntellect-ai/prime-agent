//! Test-only shared state: one crate-wide lock for the process env.

/// Process-wide env reads and writes (the telemetry override vars)
/// serialize through one lock across the crate's test modules: parallel
/// test threads in the same binary otherwise race the process env. Both
/// the supervisor tests' scrub guard and `agent_engine`'s
/// `telemetry_opt_in` hold this lock through their restores.
#[cfg(test)]
pub(crate) static TELEMETRY_ENV_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());
