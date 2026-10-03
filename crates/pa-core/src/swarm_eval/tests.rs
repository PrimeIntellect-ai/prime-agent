use serde_json::json;

use super::transcript::snapshot_from_transcript;
use super::*;

fn snapshot() -> MessagingStatsSnapshot {
    MessagingStatsSnapshot {
        arrivals: ArrivalCounts {
            total: 3,
            last5m: 3,
        },
        model_steps: StepCounts {
            total: 6,
            last5m: 6,
            tokens: 6_000,
        },
        ingestion_steps: StepCounts {
            total: 2,
            last5m: 2,
            tokens: 800,
        },
        context: ContextShape {
            estimated_agent_message_tokens: 100,
            context_tokens: Some(1_000),
            share: Some(0.1),
        },
        sends: SendCounts {
            attempts: 3,
            failures: 0,
        },
    }
}

fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

fn eval_config() -> SwarmEvalConfig {
    let mut config = default_eval_config();
    config.model = "internal/glm-5.2-fast".to_string();
    config
}

// ---------------------------------------------------------------------------
// Defense lines
// ---------------------------------------------------------------------------

#[test]
fn passes_when_every_pre_registered_line_holds() {
    let defense =
        evaluate_messaging_defense_lines(&snapshot(), MessagingDefenseLineLimits::default());
    assert_eq!(defense.context_share.value, Some(0.1));
    assert_eq!(defense.context_share.limit, 0.25);
    assert_eq!(defense.context_share.passed, Some(true));
    assert_eq!(defense.turn_share.value, Some(2.0 / 6.0));
    assert_eq!(defense.turn_share.passed, Some(true));
    assert_eq!(defense.cost_share.value, Some(800.0 / 6_000.0));
    assert_eq!(defense.cost_share.passed, Some(true));
    assert_eq!(defense.verdict, DefenseVerdict::Pass);
}

#[test]
fn fails_on_the_first_crossed_line() {
    let crossed = MessagingStatsSnapshot {
        ingestion_steps: StepCounts {
            total: 3,
            last5m: 3,
            tokens: 800,
        },
        ..snapshot()
    };
    let defense = evaluate_messaging_defense_lines(&crossed, MessagingDefenseLineLimits::default());
    assert_eq!(defense.turn_share.value, Some(0.5));
    assert_eq!(defense.turn_share.limit, 1.0 / 3.0);
    assert_eq!(defense.turn_share.passed, Some(false));
    assert_eq!(defense.verdict, DefenseVerdict::Fail);
}

#[test]
fn stays_inconclusive_instead_of_passing_without_measurements() {
    let empty = MessagingStatsSnapshot::default();
    let defense = evaluate_messaging_defense_lines(&empty, MessagingDefenseLineLimits::default());
    assert_eq!(defense.context_share.passed, None);
    assert_eq!(defense.turn_share.passed, None);
    assert_eq!(defense.cost_share.passed, None);
    assert_eq!(defense.verdict, DefenseVerdict::Inconclusive);
}

#[test]
fn unknown_lines_never_override_a_failure() {
    // A failed cost line with unknown context/turn lines still fails.
    let only_cost = MessagingStatsSnapshot {
        arrivals: ArrivalCounts::default(),
        model_steps: StepCounts {
            total: 4,
            last5m: 4,
            tokens: 100,
        },
        ingestion_steps: StepCounts {
            total: 0,
            last5m: 0,
            tokens: 50,
        },
        context: ContextShape::default(),
        sends: SendCounts::default(),
    };
    let defense =
        evaluate_messaging_defense_lines(&only_cost, MessagingDefenseLineLimits::default());
    assert_eq!(defense.context_share.passed, None);
    assert_eq!(defense.cost_share.passed, Some(false));
    assert_eq!(defense.verdict, DefenseVerdict::Fail);
}

#[test]
fn treats_the_exact_limit_as_passing_and_honors_overrides() {
    let at_limit = MessagingStatsSnapshot {
        context: ContextShape {
            estimated_agent_message_tokens: 250,
            context_tokens: Some(1_000),
            share: Some(0.25),
        },
        ..snapshot()
    };
    let at_limit_defense =
        evaluate_messaging_defense_lines(&at_limit, MessagingDefenseLineLimits::default());
    assert_eq!(at_limit_defense.context_share.passed, Some(true));

    // A tighter override flips the same measurement to a failure.
    let overridden = evaluate_messaging_defense_lines(
        &at_limit,
        MessagingDefenseLineLimits {
            context_share: 0.2,
            ..MessagingDefenseLineLimits::default()
        },
    );
    assert_eq!(overridden.context_share.limit, 0.2);
    assert_eq!(overridden.context_share.passed, Some(false));
    assert_eq!(overridden.verdict, DefenseVerdict::Fail);
}

#[test]
fn default_limits_match_the_pre_registered_values() {
    assert_eq!(MESSAGING_DEFENSE_LINE_LIMITS.context_share, 0.25);
    assert_eq!(MESSAGING_DEFENSE_LINE_LIMITS.turn_share, 1.0 / 3.0);
    assert_eq!(MESSAGING_DEFENSE_LINE_LIMITS.cost_share, 0.2);
    assert_eq!(
        MessagingDefenseLineLimits::default(),
        MESSAGING_DEFENSE_LINE_LIMITS
    );
}

// ---------------------------------------------------------------------------
// Config and prompts
// ---------------------------------------------------------------------------

#[test]
fn parses_arguments_with_defaults_and_validates_the_model() {
    let config = parse_eval_args(&args(&[
        "--model",
        "internal/glm-5.2-fast",
        "--sizes",
        "2,10",
    ]))
    .expect("parses");
    assert_eq!(config.model, "internal/glm-5.2-fast");
    assert_eq!(config.sizes, vec![2, 10]);
    assert_eq!(config.message_size, MessageSize::Short);
    assert_eq!(config.pattern, ArrivalPattern::Spread);
    assert_eq!(config.trials, 1);
    assert_eq!(config.gap_seconds, 2.0);
    assert_eq!(config.timeout_minutes, 35.0);
    assert_eq!(config.seed, 1);

    assert_eq!(
        parse_eval_args(&args(&["--sizes", "2"])),
        Err(EvalArgsError::Message(
            "--model is required (provider/id)".to_string()
        ))
    );
    assert_eq!(
        parse_eval_args(&args(&["--model", "x/y", "--nonsense"])),
        Err(EvalArgsError::Message(
            "Unknown argument: --nonsense".to_string()
        ))
    );
    assert_eq!(
        parse_eval_args(&args(&["--model"])),
        Err(EvalArgsError::Message(
            "Missing value for --model".to_string()
        ))
    );
    assert_eq!(
        parse_eval_args(&args(&["--help"])),
        Err(EvalArgsError::Help)
    );
}

#[test]
fn timeout_minutes_inf_parses_to_an_unbounded_wait() {
    // `--timeout-minutes inf` must become an explicit unbounded wait instead
    // of reaching a `Duration` conversion that panics mid-run.
    for raw in ["inf", "Infinity", "+INF", " infinity ", "-inf", "-INFINITY"] {
        let config =
            parse_eval_args(&args(&["--model", "m", "--timeout-minutes", raw])).expect("parses");
        assert!(
            config.timeout_minutes.is_infinite(),
            "{raw} must parse to infinity"
        );
    }
    let config =
        parse_eval_args(&args(&["--model", "m", "--timeout-minutes", "30"])).expect("parses");
    assert_eq!(config.timeout_minutes, 30.0);
    // Other non-finite or unparsable values keep the clamped default.
    let nan =
        parse_eval_args(&args(&["--model", "m", "--timeout-minutes", "nan"])).expect("parses");
    assert_eq!(nan.timeout_minutes, 1.0);
}

#[test]
fn an_overflowing_timeout_literal_falls_back_to_the_clamped_default() {
    // `1e999` also parses to infinity (Rust's dec2flt overflow), which
    // would silently open an unbounded wait without an explicit `inf`
    // spelling; it falls back to the clamped default like any unparsable
    // value.
    let config =
        parse_eval_args(&args(&["--model", "m", "--timeout-minutes", "1e999"])).expect("parses");
    assert_eq!(config.timeout_minutes, 1.0);
    let config =
        parse_eval_args(&args(&["--model", "m", "--timeout-minutes", "-1e999"])).expect("parses");
    assert_eq!(config.timeout_minutes, 1.0);
}

#[test]
fn the_default_timeout_covers_the_largest_supported_spread_schedule() {
    // The largest supported crew in the default Spread pattern waits
    // `(MAX_CREW_SIZE - 1) * gap_seconds` before its last child even
    // replies; the default timeout must cover that schedule plus the
    // last reply and the orchestrator's final ANSWER step, or supported
    // sizes fail by harness schedule instead of by measurement.
    let config = default_eval_config();
    let last_child_wait = (MAX_CREW_SIZE - 1) as f64 * config.gap_seconds;
    let final_turn_budget = 240.0;
    assert!(
        config.timeout_minutes * 60.0 >= last_child_wait + final_turn_budget,
        "default timeout {} min cannot cover the largest supported spread schedule \
         ({last_child_wait}s sleep + {final_turn_budget}s of final turns)",
        config.timeout_minutes
    );
}

#[test]
fn the_trial_deadline_degrades_extreme_timeouts_instead_of_panicking() {
    use std::time::{Duration, Instant};
    // The explicit unbounded wait.
    assert_eq!(trial_deadline(f64::INFINITY), None);
    // A non-finite hand-built value degrades the same way (never a
    // `Duration::from_secs_f64` panic).
    assert_eq!(trial_deadline(f64::NAN), None);
    // A finite value too large to represent degrades to unbounded too.
    assert_eq!(trial_deadline(1e300), None);
    // A sane timeout produces the deadline it asked for.
    let before = Instant::now();
    let deadline = trial_deadline(15.0).expect("a finite timeout is bounded");
    assert!(deadline >= before + Duration::from_mins(14));
    assert!(deadline <= Instant::now() + Duration::from_mins(16));
}

#[test]
fn drops_non_positive_sizes_and_requires_at_least_one() {
    let config =
        parse_eval_args(&args(&["--model", "m", "--sizes", "2, 0, x, 5"])).expect("parses");
    assert_eq!(config.sizes, vec![2, 5]);
    assert_eq!(
        parse_eval_args(&args(&["--model", "m", "--sizes", "0, nope"])),
        Err(EvalArgsError::Message(
            "--sizes must contain at least one positive size".to_string()
        ))
    );
}

#[test]
fn non_finite_gap_seconds_fall_back_to_the_immediate_reply_zero() {
    // `1e999` parses to infinity and would emit `asyncio.sleep(inf)`
    // (NaN for child 0) into the child prompts, stalling every staggered
    // reply until the trial timeout; `NaN` already degraded via the
    // clamp, the infinities did not.
    for raw in ["inf", "Infinity", "1e999", "nan", "-inf"] {
        let config =
            parse_eval_args(&args(&["--model", "m", "--gap-seconds", raw])).expect("parses");
        assert_eq!(config.gap_seconds, 0.0, "{raw}");
    }
    let config = parse_eval_args(&args(&["--model", "m", "--gap-seconds", "3.5"])).expect("parses");
    assert_eq!(config.gap_seconds, 3.5);
}

#[test]
fn rejects_sizes_above_the_supported_maximum() {
    // The 900-value 3-digit secret space bounds a crew whose ANSWER can
    // be verified; a huge size would also abort the driver's secret
    // allocation mid-run.
    let at_cap = parse_eval_args(&args(&["--model", "m", "--sizes", "900"])).expect("parses");
    assert_eq!(at_cap.sizes, vec![MAX_CREW_SIZE]);
    assert_eq!(
        parse_eval_args(&args(&["--model", "m", "--sizes", "901"])),
        Err(EvalArgsError::Message(
            "--sizes 901 exceeds the supported maximum crew size 900".to_string()
        ))
    );
    assert_eq!(
        parse_eval_args(&args(&["--model", "m", "--sizes", "18446744073709551615"])),
        Err(EvalArgsError::Message(
            "--sizes 18446744073709551615 exceeds the supported maximum crew size 900".to_string()
        ))
    );
}

#[test]
fn rejects_a_sweep_that_overflows_the_derived_trial_seed() {
    // The driver derives each trial's seed as `seed + 31 * size + trial`
    // (i64); `--seed 9223372036854775807 --sizes 2` overflows it before
    // the first real-token request, so the parser rejects it up front.
    assert_eq!(
        parse_eval_args(&args(&[
            "--model",
            "m",
            "--seed",
            "9223372036854775807",
            "--sizes",
            "2"
        ]))
        .unwrap_err(),
        EvalArgsError::Message(
            "--seed 9223372036854775807 with size 2 and 1 trials overflows the derived trial seed (seed + 31 * size + trial)"
                .to_string()
        )
    );
    // An absurd trial count is caught by the same derived-seed rule.
    assert!(
        matches!(
            parse_eval_args(&args(&["--model", "m", "--trials", "18446744073709551615"])),
            Err(EvalArgsError::Message(_))
        ),
        "an unrepresentable trial count must be rejected"
    );
    // The exact clamp-hiding combination: a negative-extreme seed plus an
    // unrepresentable trial count used to pass validation because
    // `unwrap_or(i64::MAX)` hid the failed `i64::try_from`, starting an
    // effectively unbounded sweep.
    assert_eq!(
        parse_eval_args(&args(&[
            "--model",
            "m",
            "--seed",
            "-9223372036854775808",
            "--sizes",
            "2",
            "--trials",
            "18446744073709551615"
        ]))
        .unwrap_err(),
        EvalArgsError::Message(
            "--trials 18446744073709551615 cannot be represented in the derived trial seed (seed + 31 * size + trial)"
                .to_string()
        )
    );
    // Sane sweeps (including every default size and a negative seed) still
    // parse.
    assert!(parse_eval_args(&args(&[
        "--model",
        "m",
        "--seed",
        "-9223372036854775808",
        "--sizes",
        "2,5,10,20,40"
    ]))
    .is_ok());
}

#[test]
fn default_out_dir_is_stamped_when_omitted() {
    let config = parse_eval_args(&args(&["--model", "m"])).expect("parses");
    assert!(
        config.out_dir.starts_with("swarm-eval-reports/"),
        "{}",
        config.out_dir
    );
    let explicit = parse_eval_args(&args(&["--model", "m", "--out", "./reports"])).expect("parses");
    assert_eq!(explicit.out_dir, "./reports");
}

#[test]
fn builds_deterministic_child_prompts_per_pattern_and_message_size() {
    let config = eval_config();
    let short = build_child_prompt(1, 481, &config);
    assert!(short.contains("481"));
    assert!(short.contains("REPORT 481"));
    assert!(short.contains("asyncio.sleep(2)"));
    assert!(!short.contains("filler"));

    let burst = build_child_prompt(
        0,
        481,
        &SwarmEvalConfig {
            pattern: ArrivalPattern::Burst,
            ..config.clone()
        },
    );
    assert!(burst.contains("Reply immediately"));
    assert!(!burst.contains("asyncio.sleep"));

    let long = build_child_prompt(
        0,
        481,
        &SwarmEvalConfig {
            message_size: MessageSize::Long,
            ..config
        },
    );
    assert!(long.contains("200 lines each containing only the word filler"));
}

#[test]
fn embeds_every_child_prompt_and_the_answer_format_in_the_orchestrator_prompt() {
    let prompt = build_orchestrator_prompt(&eval_config(), 3, &[111, 222, 333]);
    assert!(prompt.contains("3-subagent crew"));
    assert!(prompt.contains("111"));
    assert!(prompt.contains("333"));
    assert!(prompt.contains("ANSWER:"));
    assert!(prompt.contains("\"\"\""));
}

#[test]
fn seeds_secrets_deterministically() {
    let first = seeded_secrets(1, 5);
    assert_eq!(first, seeded_secrets(1, 5));
    assert_ne!(first, seeded_secrets(2, 5));
    assert_eq!(first.len(), 5);
    assert!(first.iter().all(|secret| (100..1000).contains(secret)));
}

#[test]
fn seeds_a_unique_secret_for_every_child() {
    // Every secret of a trial must be pairwise unique: adjacent children
    // sharing one number (the old even-index hash chain) would let a
    // swapped or merged aggregation still match the expected ANSWER.
    for seed in [1, 2, 7, 100] {
        let secrets = seeded_secrets(seed, 12);
        let mut unique = secrets.clone();
        unique.sort_unstable();
        unique.dedup();
        // (The drawn values are not written into the assert message: they
        // are deterministic for the named seed, and CodeQL's cleartext
        // logger flags them by name.)
        assert_eq!(
            unique.len(),
            secrets.len(),
            "seed {seed} must draw pairwise-unique secrets"
        );
    }
    // The default sweep's largest crew stays unique as well.
    let size = 40;
    let sweep_seed = 1 + i64::try_from(size).expect("in range") * 31 + 1;
    let secrets = seeded_secrets(sweep_seed, size);
    let mut unique = secrets.clone();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(unique.len(), secrets.len());
}

// ---------------------------------------------------------------------------
// Verification and reporting
// ---------------------------------------------------------------------------

#[test]
fn parses_the_answer_line() {
    assert_eq!(
        parse_answer_line(Some("work done\nANSWER: 12, 34, 56")),
        Some(vec![12, 34, 56])
    );
    assert_eq!(parse_answer_line(Some("ANSWER: 12,34")), Some(vec![12, 34]));
    assert_eq!(parse_answer_line(Some("answer: 7")), Some(vec![7]));
    assert_eq!(parse_answer_line(Some("ANSWER:12")), Some(vec![12]));
    assert_eq!(parse_answer_line(Some("no answer")), None);
    assert_eq!(parse_answer_line(Some("ANSWER:")), None);
    assert_eq!(parse_answer_line(Some("ANSWER: 1,")), None);
    // Trailing non-whitespace text makes the line malformed: parsing a
    // prefix out of it would credit a wrong answer.
    assert_eq!(parse_answer_line(Some("ANSWER: 12, 34 extra text")), None);
    assert_eq!(parse_answer_line(Some("ANSWER: 12 34")), None);
    assert_eq!(parse_answer_line(None), None);
}

#[test]
fn parses_past_a_prose_answer_mention_before_the_real_answer_line() {
    // The TS-era regex scanned forward past prose `answer:` mentions; the
    // first substring occurrence must not hijack the real ANSWER line and
    // make a correct response look missing.
    assert_eq!(
        parse_answer_line(Some("I don't have the answer: not yet.\nANSWER: 12, 34")),
        Some(vec![12, 34])
    );
    // A prose mention followed by numbers must not be credited either: the
    // ANSWER line is the occurrence whose numbers consume the whole text,
    // so the terminal occurrence wins over the prose one (the TS regex
    // would have returned the prose digits here).
    assert_eq!(
        parse_answer_line(Some("the answer: 999 and counting\nANSWER: 12, 34")),
        Some(vec![12, 34])
    );
    // The strict terminal rule stands when no real ANSWER line follows the
    // prose mention: trailing text is still malformed, never a prefix
    // credit.
    assert_eq!(
        parse_answer_line(Some("the answer: 999 is all I have\nANSWER: 12, 34 extra")),
        None
    );
}

#[test]
fn turns_task_failures_and_rate_limit_errors_into_instant_fails() {
    let config = eval_config();
    let ok = trial_result_from_snapshot(&config, 5, 1, &snapshot(), true, None, 12.0);
    assert_eq!(ok.verdict, DefenseVerdict::Pass);

    let wrong_answer = trial_result_from_snapshot(&config, 5, 1, &snapshot(), false, None, 12.0);
    assert_eq!(wrong_answer.verdict, DefenseVerdict::Fail);

    let rate_limited = trial_result_from_snapshot(
        &config,
        5,
        1,
        &snapshot(),
        true,
        Some("rate-limit error during trial".to_string()),
        12.0,
    );
    assert_eq!(rate_limited.verdict, DefenseVerdict::Fail);
    assert_eq!(
        rate_limited.instant_fail.as_deref(),
        Some("rate-limit error during trial")
    );
}

#[test]
fn renders_a_markdown_report_with_every_trial_and_a_verdict_summary() {
    let config = eval_config();
    let rows = vec![
        trial_result_from_snapshot(&config, 2, 1, &snapshot(), true, None, 10.0),
        trial_result_from_snapshot(
            &config,
            2,
            2,
            &MessagingStatsSnapshot {
                ingestion_steps: StepCounts {
                    total: 5,
                    last5m: 5,
                    tokens: 5_000,
                },
                ..snapshot()
            },
            true,
            None,
            11.0,
        ),
    ];
    let report = render_markdown_report(&rows, &config);
    assert!(report.contains("# Swarm starvation eval report"));
    assert!(report.contains("context <= 25%"));
    assert!(report.contains("turns <= 33%"));
    assert!(report.contains("cost <= 20%"));
    assert!(report.contains("| 2 | 1 |"));
    assert!(report.contains("1/2 trials failed"));
}

#[test]
fn reports_all_passed_when_no_trial_fails() {
    let config = eval_config();
    let rows = vec![trial_result_from_snapshot(
        &config,
        2,
        1,
        &snapshot(),
        true,
        None,
        10.0,
    )];
    let report = render_markdown_report(&rows, &config);
    assert!(report.contains("All 1 trials passed every defense line."));
}

#[test]
fn reports_an_all_inconclusive_sweep_as_inconclusive_never_as_passed() {
    let config = eval_config();
    // An empty snapshot leaves every defense line unknown, so both rows
    // fold to Inconclusive; the summary must not claim them as passes.
    let rows = vec![
        trial_result_from_snapshot(
            &config,
            2,
            1,
            &MessagingStatsSnapshot::default(),
            true,
            None,
            10.0,
        ),
        trial_result_from_snapshot(
            &config,
            5,
            1,
            &MessagingStatsSnapshot::default(),
            true,
            None,
            11.0,
        ),
    ];
    let report = render_markdown_report(&rows, &config);
    assert!(
        report.contains("2/2 trials were inconclusive (a defense line was unmeasured)"),
        "{report}"
    );
    assert!(!report.contains("passed every defense line"), "{report}");
    assert!(report.contains("size 2/trial 1"), "{report}");
    assert!(report.contains("size 5/trial 1"), "{report}");
    // The per-row verdict column shows the inconclusive token itself.
    assert!(report.contains("| inconclusive |"), "{report}");
}

#[test]
fn names_the_inconclusive_trials_in_a_mixed_report() {
    let config = eval_config();
    let rows = vec![
        trial_result_from_snapshot(&config, 2, 1, &snapshot(), true, None, 10.0),
        trial_result_from_snapshot(
            &config,
            5,
            1,
            &MessagingStatsSnapshot::default(),
            true,
            None,
            11.0,
        ),
    ];
    let report = render_markdown_report(&rows, &config);
    assert!(report.contains("1/2 trials were inconclusive"), "{report}");
    assert!(!report.contains("All 2 trials passed"), "{report}");
    // A failing trial keeps its summary and the inconclusive rows are
    // still named beside it.
    let mixed = vec![
        rows[0].clone(),
        rows[1].clone(),
        trial_result_from_snapshot(&config, 10, 1, &snapshot(), false, None, 11.0),
    ];
    let report = render_markdown_report(&mixed, &config);
    assert!(report.contains("1/3 trials failed"), "{report}");
    assert!(report.contains("1 trials were inconclusive"), "{report}");
}

// ---------------------------------------------------------------------------
// Transcript-derived snapshots
// ---------------------------------------------------------------------------

#[test]
fn derives_arrivals_steps_and_context_share_from_a_transcript() {
    let messages = vec![
        json!({ "role": "user", "content": "orchestrator prompt" }),
        json!({ "role": "assistant", "usage": { "totalTokens": 1000 }, "stopReason": "toolUse" }),
        json!({
            "role": "custom",
            "customType": "agent_message",
            "content": "12345678",
            "details": { "id": "agentmsg_1" }
        }),
        json!({ "role": "assistant", "usage": { "totalTokens": 200 }, "stopReason": "stop" }),
        json!({ "role": "toolResult", "content": "tool output" }),
        json!({ "role": "assistant", "usage": { "totalTokens": 300 }, "stopReason": "stop" }),
        json!({ "role": "assistant", "usage": { "totalTokens": 999 }, "stopReason": "error" }),
    ];
    let snapshot = snapshot_from_transcript(&messages, Some(2_000));
    assert_eq!(snapshot.arrivals.total, 1);
    // Three completed steps (the error stop is skipped).
    assert_eq!(snapshot.model_steps.total, 3);
    assert_eq!(snapshot.model_steps.tokens, 1_500);
    // Both steps of the agent-triggered turn count: the primary input stays
    // the agent message across the turn's tool result.
    assert_eq!(snapshot.ingestion_steps.total, 2);
    assert_eq!(snapshot.ingestion_steps.tokens, 500);
    // 8 chars -> 2 tokens; share = 2/2000.
    assert_eq!(snapshot.context.estimated_agent_message_tokens, 2);
    assert_eq!(snapshot.context.share, Some(2.0 / 2_000.0));
}

#[test]
fn transcript_context_share_is_unknown_without_context_tokens() {
    let messages = vec![json!({
        "role": "custom",
        "customType": "agent_message",
        "content": "hello"
    })];
    let snapshot = snapshot_from_transcript(&messages, None);
    assert_eq!(snapshot.arrivals.total, 1);
    assert_eq!(snapshot.context.context_tokens, None);
    assert_eq!(snapshot.context.share, None);
    // Unknown context still never silently passes.
    let defense =
        evaluate_messaging_defense_lines(&snapshot, MessagingDefenseLineLimits::default());
    assert_eq!(defense.context_share.passed, None);
    assert_eq!(defense.verdict, DefenseVerdict::Inconclusive);
}

#[test]
fn a_plain_user_message_resets_the_ingestion_trigger() {
    let messages = vec![
        json!({ "role": "custom", "customType": "agent_message", "content": "hi" }),
        json!({ "role": "user", "content": "back to the user" }),
        json!({ "role": "assistant", "usage": { "totalTokens": 50 }, "stopReason": "stop" }),
    ];
    let snapshot = snapshot_from_transcript(&messages, Some(1_000));
    assert_eq!(snapshot.model_steps.total, 1);
    assert_eq!(snapshot.ingestion_steps.total, 0);
}
