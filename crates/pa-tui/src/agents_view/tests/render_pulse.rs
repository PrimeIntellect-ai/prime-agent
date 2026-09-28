//! The running-row pulse cadence: idle rows never draw, running rows
//! pulse on the redraw ticks.

use super::*;

#[test]
fn idle_draws_only_on_running_row_pulses() {
    for count in [0, 100, 1000] {
        for running in [false, true] {
            let (mut mode, _) = mode_with_row("row", "mock-1");
            let template = mode.rows[0].clone();
            mode.rows = (0..count)
                .map(|n| {
                    let mut row = template.clone();
                    row.identity = format!("agent {n}");
                    row.section = if running {
                        Section::Running
                    } else {
                        Section::Idle
                    };
                    row
                })
                .collect();
            let start = tokio::time::Instant::now();
            let mut last_pulse = start;
            let draws = (1..=20)
                .filter(|tick| {
                    advance_running_pulse(
                        &mut mode,
                        &mut last_pulse,
                        start + Duration::from_millis(tick * 50),
                    )
                })
                .count();
            let expected = if running && count > 0 { 4 } else { 0 };
            assert_eq!((draws, mode.pulse), (expected, expected));
        }
    }
}
