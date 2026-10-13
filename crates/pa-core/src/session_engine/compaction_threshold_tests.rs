use super::*;

#[test]
fn default_percentage_preserves_the_current_threshold_and_strict_boundary() {
    let settings = CompactionSettings::default();
    for (window, output, expected) in [
        (1_048_576, 32_000, 996_147),
        (131_072, 32_768, 81_920),
        (128_000, 0, 111_616),
        (0, 0, 0),
    ] {
        assert_eq!(compaction_threshold(window, output, &settings), expected);
        assert!(!should_compact(expected, window, output, &settings));
        assert_eq!(
            should_compact(expected + 1, window, output, &settings),
            expected > 0
        );
    }
}

#[test]
fn custom_percentages_obey_both_ceilings_as_model_limits_change() {
    for percent in [1.0, 50.0, 62.5, 80.0, 95.0, 100.0] {
        let settings = CompactionSettings {
            threshold_percent: percent,
            ..Default::default()
        };
        for (window, output) in [(1_048_576, 32_000), (131_072, 32_768), (65_536, 32_000)] {
            let expected = ((window as f64 * (percent / 100.0)) as u64)
                .min(window - output - DEFAULT_RESERVE_TOKENS);
            assert_eq!(compaction_threshold(window, output, &settings), expected);
            assert!(!should_compact(expected, window, output, &settings));
            assert!(should_compact(expected + 1, window, output, &settings));
        }
    }
}

#[test]
fn invalid_runtime_percentages_fall_back_without_losing_headroom() {
    for percent in [
        0.0,
        -1.0,
        100.01,
        f64::NAN,
        f64::INFINITY,
        f64::NEG_INFINITY,
    ] {
        let settings = CompactionSettings {
            threshold_percent: percent,
            ..Default::default()
        };
        assert_eq!(compaction_threshold(1_048_576, 32_000, &settings), 996_147);
        assert_eq!(compaction_threshold(131_072, 32_768, &settings), 81_920);
    }
    let settings = CompactionSettings {
        threshold_percent: 100.0,
        reserve_tokens: 1,
        ..Default::default()
    };
    assert_eq!(compaction_threshold(131_072, 32_768, &settings), 94_208);
    assert_eq!(compaction_threshold(4_000, 32_000, &settings), 0);
}

#[tokio::test]
async fn saved_percentage_applies_to_existing_sessions_without_changing_manual_budgets() {
    let dir = tempfile::tempdir().unwrap();
    let agent_dir = dir.path().join("agent");
    let agent = std::sync::Arc::new(pa_agent::agent::Agent::new(
        pa_agent::agent::AgentOptions::default(),
    ));
    let mut session = super::super::AgentSession::new(
        agent,
        crate::session::manager::SessionManager::in_memory(dir.path()),
        Vec::new(),
    )
    .await
    .unwrap();
    session.set_compaction_settings(CompactionSettings {
        reserve_tokens: 12_345,
        keep_recent_tokens: 567,
        ..Default::default()
    });
    session.set_auxiliary_model_context(super::super::auxiliary_model::AuxiliaryModelContext {
        cwd: dir.path().to_path_buf(),
        agent_dir: agent_dir.clone(),
    });
    let mut settings = crate::settings::SettingsManager::create(dir.path(), &agent_dir);
    assert_eq!(session.compaction_settings().threshold_percent, 95.0);
    settings.set_compaction_threshold_percent(80.5).unwrap();
    assert_eq!(
        session.compaction_settings(),
        CompactionSettings {
            threshold_percent: 80.5,
            reserve_tokens: 12_345,
            keep_recent_tokens: 567,
            ..Default::default()
        }
    );
    session.set_auto_compaction_enabled(false);
    assert!(!should_compact(
        1_000_000,
        1_048_576,
        32_000,
        &session.compaction_settings()
    ));
}
