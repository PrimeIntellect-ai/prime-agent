//! The auth panel's unit battery: the request folds, the paste field, the team picker, the URL
//! block, the per-surface chrome, the scrub hygiene, and the cancel-signal contract.

use super::*;
use crate::keybindings::KeybindingsManager;

fn kb() -> KeybindingsManager {
    KeybindingsManager::new()
}

/// The copy path's captured OSC 52 channel (a headless run's sink).
fn sink() -> crate::clipboard::OscSink {
    crate::clipboard::OscSink::Buffer(Vec::new())
}

fn theme() -> Theme {
    Theme::builtin("prime", crate::theme::ColorMode::TrueColor)
}

fn acme() -> PrimeTeamOption {
    PrimeTeamOption {
        team_id: "team-acme".to_string(),
        name: "Acme Corp".to_string(),
        slug: Some("acme".to_string()),
        role: Some("Owner".to_string()),
        created_at: None,
    }
}

fn beta() -> PrimeTeamOption {
    PrimeTeamOption {
        team_id: "team-beta".to_string(),
        name: "Beta Team".to_string(),
        slug: None,
        role: None,
        created_at: None,
    }
}

fn frame_text(panel: &mut AuthPanel) -> Vec<String> {
    panel
        .render(&theme(), 90, &kb())
        .iter()
        .map(|line| line.iter().map(|span| span.content.as_str()).collect())
        .collect()
}

/// A paste prompt mounted over a panel with its oneshot pair.
fn mount_paste() -> (AuthPanel, oneshot::Receiver<Option<String>>) {
    mount_paste_tone(PastePromptTone::Muted)
}

/// A paste prompt with its own tone.
fn mount_paste_tone(tone: PastePromptTone) -> (AuthPanel, oneshot::Receiver<Option<String>>) {
    let mut panel = AuthPanel::new("Login to Prime Inference");
    let (reply, answer) = oneshot::channel();
    panel.mount_paste(
        "Paste a Prime API key below:",
        tone,
        PasteStyle::Visible,
        false,
        reply,
    );
    (panel, answer)
}

/// A team picker mounted with its oneshot pair.
fn mount_teams(
    teams: Vec<PrimeTeamOption>,
    current: Option<&str>,
) -> (AuthPanel, oneshot::Receiver<PrimeTeamPick>) {
    let mut panel = AuthPanel::new("Login to Prime Inference");
    let (reply, answer) = oneshot::channel();
    panel.mount_teams(teams, current.map(str::to_string), reply);
    (panel, answer)
}

#[test]
fn the_first_progress_line_lands_under_the_section_title() {
    let mut panel = AuthPanel::new("Login to Prime Inference");
    panel.push_progress("Checking existing Prime CLI credentials...");
    let rows = frame_text(&mut panel);
    assert!(rows
        .iter()
        .any(|row| row.contains("Login to Prime Inference")));
    assert!(
        rows.iter()
            .any(|row| row.contains("Preparing authentication")),
        "the TS section title rides the first progress: {rows:?}"
    );
    assert!(rows
        .iter()
        .any(|row| row.contains("Checking existing Prime CLI credentials...")));
}

#[test]
fn the_auth_url_block_replaces_the_content() {
    let mut panel = AuthPanel::new("Login to Linear");
    panel.mount_paste(
        "Paste the code below:",
        PastePromptTone::Muted,
        PasteStyle::Visible,
        false,
        oneshot::channel().0,
    );
    panel.show_auth_url(
        "https://fixture.example/authorize".to_string(),
        Some("Enter the code from the browser.".to_string()),
    );
    let rows = frame_text(&mut panel);
    assert!(rows
        .iter()
        .any(|row| row.contains("https://fixture.example/authorize")));
    assert!(
        rows.iter()
            .any(|row| row.contains("Enter the code from the browser.")),
        "the instructions render: {rows:?}"
    );
    assert!(
        !rows.iter().any(|row| row.contains("Paste the code below:")),
        "the mounted field unmounts with the content"
    );
    panel.show_auth_url("https://fixture.example/x".to_string(), None);
    let rows = frame_text(&mut panel);
    assert!(
        rows.iter()
            .any(|row| row.contains("Complete the sign-in in your browser.")),
        "the TS default browser line renders: {rows:?}"
    );
}

#[test]
fn the_paste_prompt_submits_the_typed_value() {
    let (mut panel, mut answer) = mount_paste();
    let rows = frame_text(&mut panel);
    assert!(rows
        .iter()
        .any(|row| row.contains("Paste a Prime API key below:")));
    let field = rows
        .iter()
        .position(|row| row.contains("Paste value"))
        .expect("the plain field row");
    assert!(
        rows[field].starts_with(" > "),
        "the field keeps its `> ` prompt: {rows:?}"
    );
    let rules = rows
        .iter()
        .filter(|row| !row.is_empty() && row.chars().all(|c| c == '\u{2500}'))
        .count();
    assert_eq!(
        rules, 1,
        "the session panel's top rule alone rides; the field adds none: {rows:?}"
    );
    assert!(
        rows[0].chars().all(|c| c == '\u{2500}'),
        "the rule opens the panel"
    );
    // The paste-only panel keeps its own hint row; the auth-actions row rides only under a
    // shown URL block (pinned by the URL block's tests below).
    assert!(rows
        .iter()
        .any(|row| row.contains("Enter submit  Esc cancel")));
    for character in "  sk-live  ".chars() {
        panel.handle_key(character.to_string().as_str(), &kb(), &mut sink());
    }
    panel.handle_key("enter", &kb(), &mut sink());
    assert_eq!(answer.try_recv(), Ok(Some("sk-live".to_string())));
}

#[test]
fn escape_on_the_paste_prompt_cancels_the_flow() {
    let (mut panel, mut answer) = mount_paste();
    panel.handle_key("escape", &kb(), &mut sink());
    assert_eq!(answer.try_recv(), Ok(None));
}

#[test]
fn an_empty_paste_submit_shows_the_notice_only_on_the_token_panel() {
    let mut panel = AuthPanel::new("Connect GitHub");
    let (reply, mut answer) = oneshot::channel();
    panel.mount_paste(
        "Paste the token for github:",
        PastePromptTone::Text,
        PasteStyle::Masked,
        false,
        reply,
    );
    panel.handle_key("enter", &kb(), &mut sink());
    let rows = frame_text(&mut panel);
    assert!(rows
        .iter()
        .any(|row| row.contains("The value cannot be empty.")));
    assert!(answer.try_recv().is_err(), "nothing answered");
    panel.handle_key("k", &kb(), &mut sink());
    panel.handle_key("enter", &kb(), &mut sink());
    assert_eq!(answer.try_recv(), Ok(Some("k".to_string())));

    let (mut panel, mut answer) = mount_paste();
    panel.handle_key("enter", &kb(), &mut sink());
    let rows = frame_text(&mut panel);
    assert!(
        !rows
            .iter()
            .any(|row| row.contains("The value cannot be empty.")),
        "the login dialog waits silently: {rows:?}"
    );
    assert!(answer.try_recv().is_err(), "nothing answered");
}

#[test]
fn cancel_runs_through_the_effective_binding() {
    let (mut panel, mut answer) = mount_paste();
    panel.handle_key("ctrl+c", &kb(), &mut sink());
    assert_eq!(
        answer.try_recv(),
        Ok(None),
        "ctrl+c cancels through the stock binding"
    );
    let mut cfg = crate::keybindings::KeybindingsConfig::new();
    cfg.insert("tui.select.cancel".to_string(), Vec::new());
    let kb = KeybindingsManager::with_user_bindings(cfg);
    let (mut panel, mut answer) = mount_paste();
    panel.handle_key("ctrl+c", &kb, &mut sink());
    assert!(
        answer.try_recv().is_err(),
        "an emptied cancel binding takes ctrl+c with it"
    );
    let mut cfg = crate::keybindings::KeybindingsConfig::new();
    cfg.insert("tui.select.cancel".to_string(), vec!["ctrl+q".to_string()]);
    let kb = KeybindingsManager::with_user_bindings(cfg);
    let (mut panel, mut answer) = mount_paste();
    panel.handle_key("ctrl+c", &kb, &mut sink());
    assert!(answer.try_recv().is_err(), "the default key went inert");
    panel.handle_key("ctrl+q", &kb, &mut sink());
    assert_eq!(answer.try_recv(), Ok(None), "the rebound key cancels");
}

#[test]
fn an_allow_empty_paste_prompt_submits_the_blank_answer() {
    let mut panel = AuthPanel::new("Login to GitHub Copilot");
    let (reply, mut answer) = oneshot::channel();
    panel.mount_paste(
        "GitHub Enterprise URL/domain (blank for github.com)",
        PastePromptTone::Text,
        PasteStyle::Visible,
        true,
        reply,
    );
    panel.handle_key("enter", &kb(), &mut sink());
    assert_eq!(answer.try_recv(), Ok(Some(String::new())));
    let rows = frame_text(&mut panel);
    assert!(
        !rows
            .iter()
            .any(|row| row.contains("The value cannot be empty.")),
        "the blank entry is a valid answer, not a notice"
    );
}

#[test]
fn the_masked_field_renders_bullets_never_the_secret() {
    let mut panel = AuthPanel::new("Connect GitHub");
    panel.mount_paste(
        "Paste the token for github:",
        PastePromptTone::Text,
        PasteStyle::Masked,
        false,
        oneshot::channel().0,
    );
    for character in "ghp_secretvalue".chars() {
        panel.handle_key(character.to_string().as_str(), &kb(), &mut sink());
    }
    let rows = frame_text(&mut panel);
    let joined = rows.join("\n");
    assert!(
        !joined.contains("ghp_secretvalue"),
        "the secret never renders: {joined:?}"
    );
    assert!(
        joined.contains("\u{2022}\u{2022}\u{2022}"),
        "bullets render"
    );
}

#[test]
fn the_team_picker_renders_the_ts_rows() {
    let (mut panel, _answer) = mount_teams(vec![acme(), beta()], Some("team-beta"));
    let rows = frame_text(&mut panel);
    assert!(rows.iter().any(|row| row.contains("Select a Prime Team:")));
    assert!(rows
        .iter()
        .any(|row| { row.contains("Choose which account pays for Prime Inference usage.") }));
    assert!(rows.iter().any(|row| row.contains("Search teams")));
    assert!(rows.iter().any(|row| row.contains("Personal")));
    assert!(rows.iter().any(|row| row.contains("personal account")));
    assert!(rows.iter().any(|row| row.contains("Acme Corp")));
    assert!(rows
        .iter()
        .any(|row| row.contains("slug: acme, role: owner")));
    assert!(rows.iter().any(|row| row.contains("role: member")));
    let beta_row = rows
        .iter()
        .find(|row| row.contains("Beta Team"))
        .expect("the beta row");
    assert!(beta_row.contains("current"), "the beta row: {beta_row:?}");
    assert!(
        !rows
            .iter()
            .any(|row| row.contains("personal account · current")),
        "personal is not current while a team is stored"
    );
}

#[test]
fn the_personal_row_is_current_without_a_stored_selection() {
    let (mut panel, _answer) = mount_teams(vec![acme()], None);
    let rows = frame_text(&mut panel);
    assert!(rows
        .iter()
        .any(|row| row.contains("personal account · current")));
}

#[test]
fn the_picker_navigates_and_picks() {
    let (mut panel, mut answer) = mount_teams(vec![acme(), beta()], None);
    panel.handle_key("down", &kb(), &mut sink());
    panel.handle_key("enter", &kb(), &mut sink());
    assert_eq!(answer.try_recv(), Ok(PrimeTeamPick::Team(acme())));
    let (mut panel, mut answer) = mount_teams(vec![acme()], None);
    panel.handle_key("enter", &kb(), &mut sink());
    assert_eq!(answer.try_recv(), Ok(PrimeTeamPick::PersonalAccount));
}

#[test]
fn escape_on_the_picker_answers_the_cancelled_pick() {
    let (mut panel, mut answer) = mount_teams(vec![acme()], None);
    panel.handle_key("escape", &kb(), &mut sink());
    assert_eq!(answer.try_recv(), Ok(PrimeTeamPick::Cancelled));
}

#[test]
fn the_picker_search_filters_and_picks_the_surviving_row() {
    let (mut panel, mut answer) = mount_teams(vec![acme(), beta()], None);
    for character in "acme".chars() {
        panel.handle_key(character.to_string().as_str(), &kb(), &mut sink());
    }
    let rows = frame_text(&mut panel);
    assert!(rows.iter().any(|row| row.contains("Acme Corp")));
    assert!(
        !rows.iter().any(|row| row.contains("Beta Team")),
        "the non-match is filtered out: {rows:?}"
    );
    assert!(
        !rows.iter().any(|row| row.contains("Personal")),
        "the personal row is filtered out too: {rows:?}"
    );
    panel.handle_key("enter", &kb(), &mut sink());
    assert_eq!(answer.try_recv(), Ok(PrimeTeamPick::Team(acme())));
    let (mut panel, _answer) = mount_teams(vec![acme()], None);
    for character in "personal".chars() {
        panel.handle_key(character.to_string().as_str(), &kb(), &mut sink());
    }
    let rows = frame_text(&mut panel);
    assert!(rows.iter().any(|row| row.contains("Personal")));
    assert!(
        !rows.iter().any(|row| row.contains("Acme Corp")),
        "the team row is filtered out: {rows:?}"
    );
}

#[test]
fn an_empty_filter_renders_the_ts_empty_row_and_selects_nothing() {
    let (mut panel, mut answer) = mount_teams(vec![acme()], None);
    for character in "zzz".chars() {
        panel.handle_key(character.to_string().as_str(), &kb(), &mut sink());
    }
    let rows = frame_text(&mut panel);
    assert!(rows.iter().any(|row| row.contains("No matching teams")));
    panel.handle_key("enter", &kb(), &mut sink());
    assert!(
        answer.try_recv().is_err(),
        "an empty filter selects nothing"
    );
}

#[test]
fn the_picker_navigation_clamps_instead_of_wrapping() {
    let (mut panel, mut answer) = mount_teams(vec![acme()], None);
    panel.handle_key("up", &kb(), &mut sink());
    panel.handle_key("enter", &kb(), &mut sink());
    assert_eq!(
        answer.try_recv(),
        Ok(PrimeTeamPick::PersonalAccount),
        "up clamps at the personal row (index 0)"
    );
    let (mut panel, mut answer) = mount_teams(vec![acme()], None);
    panel.handle_key("down", &kb(), &mut sink());
    panel.handle_key("down", &kb(), &mut sink());
    panel.handle_key("enter", &kb(), &mut sink());
    assert_eq!(
        answer.try_recv(),
        Ok(PrimeTeamPick::Team(acme())),
        "down clamps at the last row"
    );
}

/// A dropped reply cancels the flow (the old terminal input's EOF contract).
#[tokio::test]
async fn a_dropped_prompt_reply_cancels_the_flow() {
    let (tx, rx) = mpsc::unbounded_channel();
    drop(rx);
    let handle = AuthPanelHandle::new(tx);
    assert_eq!(
        handle
            .paste_prompt("Paste a key:", PastePromptTone::Muted, PasteStyle::Visible)
            .await,
        None
    );
    assert_eq!(
        handle.select_team(vec![acme()], None).await,
        PrimeTeamPick::Cancelled
    );
}

#[test]
fn a_paste_payload_lands_in_the_mounted_field() {
    let (mut panel, mut answer) = mount_paste();
    panel.handle_paste("  sk-pasted-key  ");
    panel.handle_key("enter", &kb(), &mut sink());
    assert_eq!(answer.try_recv(), Ok(Some("sk-pasted-key".to_string())));
    let (mut panel, mut answer) = mount_teams(vec![acme()], None);
    panel.handle_paste("acme");
    panel.handle_key("enter", &kb(), &mut sink());
    assert_eq!(answer.try_recv(), Ok(PrimeTeamPick::Team(acme())));
}

/// Provider-supplied text can never execute terminal control operations: the panel scrubs
/// control characters out of every provider-fed row (the URL is single-line for OSC 8).
#[test]
fn provider_text_is_scrubbed_never_a_terminal_sequence() {
    let mut panel = AuthPanel::new("Login to \u{1b}]8;;https://evil.example\u{7}Evil");
    panel.push_progress("Loading\u{1b}[2J teams...");
    panel.show_auth_url(
        "https://a.example/\u{1b}]8;;https://evil.example\u{7}link\u{1b}\\\u{1b}]8;;\u{1b}\\"
            .to_string(),
        Some("Open\r\nhttps://evil".to_string()),
    );
    let rows = frame_text(&mut panel);
    let joined = rows.join("\n");
    assert!(
        !joined.contains("\u{1b}]8;;https://evil.example"),
        "the escape never renders: {joined:?}"
    );
    assert!(
        !joined.contains("\u{1b}[2J"),
        "the clear never renders: {joined:?}"
    );
    assert!(!joined.contains("\u{1b}]8;;"));

    let (mut panel, mut _answer) = mount_teams(
        vec![PrimeTeamOption {
            team_id: "t".to_string(),
            name: "A\u{1b}[2J Corp".to_string(),
            slug: Some("s\u{7}".to_string()),
            role: Some("Owner\u{1b}".to_string()),
            created_at: None,
        }],
        None,
    );
    let rows = frame_text(&mut panel);
    let joined = rows.join("\n");
    assert!(!joined.contains('\u{1b}'), "no escapes render: {joined:?}");
    assert!(joined.contains('A'), "the scrubbed name still renders");
}

#[test]
fn the_auth_url_link_carries_the_url_as_display_text() {
    let mut panel = AuthPanel::new("Login to Linear");
    panel.show_auth_url("https://fixture.example/authorize".to_string(), None);
    let rows = frame_text(&mut panel);
    let linked = rows
        .iter()
        .find(|row| row.contains("https://fixture.example/authorize"))
        .expect("the URL row");
    assert!(linked.contains("https://fixture.example/authorize"));
}

/// The session surface's panel chrome: the rule, the muted one-space title — and NO bottom
/// rule, NO leading blank (the content's own `startContent` blank opens the body).
#[test]
fn the_session_chrome_is_the_ts_inline_panel() {
    let mut panel = AuthPanel::new("Login to Prime Inference");
    let rows = frame_text(&mut panel);
    assert_eq!(
        rows.len(),
        2,
        "the empty dialog renders its chrome alone: {rows:?}"
    );
    assert!(
        rows[0].chars().all(|c| c == '\u{2500}'),
        "the rule opens the panel: {rows:?}"
    );
    assert_eq!(
        rows[1], " Login to Prime Inference",
        "the muted 1-space title"
    );
    panel.push_progress("Opening the browser challenge...");
    let rows = frame_text(&mut panel);
    assert_eq!(rows[2], "", "the startContent blank opens the body");
    assert!(
        !rows.iter().any(|row| row == " Login to Prime Inference  "),
        "no 2-space raw title rides the panel"
    );
    assert!(
        !rows
            .last()
            .is_some_and(|row| row.chars().all(|c| c == '\u{2500}')),
        "the inline panel closes on its content: {rows:?}"
    );
}

#[test]
fn the_onboarding_panel_is_chrome_less() {
    let mut panel = AuthPanel::onboarding("Login to Prime Inference");
    let rows = frame_text(&mut panel);
    assert!(
        rows.is_empty(),
        "the empty onboarding dialog renders nothing: {rows:?}"
    );
    panel.show_auth_url("https://fixture.example/authorize".to_string(), None);
    let rows = frame_text(&mut panel);
    assert!(
        !rows
            .iter()
            .any(|row| !row.is_empty() && row.chars().all(|c| c == '\u{2500}')),
        "no rule rides the onboarding dialog: {rows:?}"
    );
    assert!(
        !rows
            .iter()
            .any(|row| row.contains("Login to Prime Inference")),
        "no title rides the onboarding dialog: {rows:?}"
    );
    assert_eq!(rows[0], "");
    assert_eq!(rows[1], " https://fixture.example/authorize");
    assert_eq!(rows[2], "");
    assert_eq!(rows[3], " Complete the sign-in in your browser.");
    assert_eq!(
        rows[4], " C copy  Esc/Ctrl+C cancel",
        "the TS auth-actions row: {rows:?}"
    );
}

/// With provider instructions the URL renders in the text colour (never the accent), and a
/// code-carrying line becomes the verification code block.
#[test]
fn the_url_block_renders_the_ts_instruction_frames() {
    let mut panel = AuthPanel::onboarding("Login to Linear");
    panel.show_auth_url(
        "https://fixture.example/authorize".to_string(),
        Some("Complete the OAuth flow.".to_string()),
    );
    let rows = frame_text(&mut panel);
    assert_eq!(rows[1], " https://fixture.example/authorize");
    assert_eq!(rows[3], " Complete the OAuth flow.");
    panel.show_auth_url(
        "https://fixture.example/authorize".to_string(),
        Some("Enter code: 4242-9911".to_string()),
    );
    let rows = frame_text(&mut panel);
    let code = rows
        .iter()
        .position(|row| row.contains("4242-9911"))
        .expect("the code row");
    assert_eq!(rows[code - 1], " Verification code");
    assert_eq!(rows[code - 2], "", "the blank separates link and code");
}

#[test]
fn multi_line_code_instructions_stay_provider_text() {
    assert_eq!(
        verification_code("Code: 4242-9911"),
        Some("4242-9911".to_string())
    );
    assert_eq!(
        verification_code("Code: 4242-9911\nMore instructions follow."),
        None,
        "the TS single-line regex matches no code over a newline"
    );
    assert_eq!(verification_code("code: a\r\nb"), None);
    let mut panel = AuthPanel::onboarding("Login to Linear");
    panel.show_auth_url(
        "https://fixture.example/authorize".to_string(),
        Some("Code: 4242-9911\nMore instructions follow.".to_string()),
    );
    let rows = frame_text(&mut panel);
    assert!(
        !rows.iter().any(|row| row.contains("Verification code")),
        "no code block over a multi-line payload: {rows:?}"
    );
    assert!(
        rows.iter().any(|row| row.contains("Code: 4242-9911")),
        "the whole instructions render as provider text: {rows:?}"
    );
}

#[test]
fn the_waiting_line_joins_the_url_block_in_the_accent_colour() {
    let mut panel = AuthPanel::onboarding("Login to GitHub Copilot");
    panel.show_auth_url("https://fixture.example/device".to_string(), None);
    panel.push_waiting("Waiting for browser authentication...");
    let rows = frame_text(&mut panel);
    let url = rows
        .iter()
        .position(|row| row.contains("fixture.example/device"))
        .expect("the url row");
    let waiting = rows
        .iter()
        .position(|row| row.contains("Waiting for browser authentication"))
        .expect("the waiting row");
    let actions = rows
        .iter()
        .position(|row| row.contains("cancel"))
        .expect("the actions row");
    assert!(waiting > url, "the waiting line rides below the URL block");
    assert!(
        waiting < actions,
        "the waiting line rides above the actions row"
    );
    assert_eq!(rows[waiting - 1], "", "the section spacer rides above");
    let lines = panel.render(&theme(), 90, &kb());
    let accent = theme().fg_style(ThemeColor::Accent);
    assert!(
        lines[waiting].iter().any(|span| span.style == accent),
        "the waiting line renders in the accent colour: {:?}",
        lines[waiting]
    );
}

#[test]
fn escape_on_a_url_screen_marks_the_flow_cancelled() {
    let mut panel = AuthPanel::onboarding("Login to Prime Inference");
    let handle = AuthPanelHandle::new(mpsc::unbounded_channel().0);
    let cancel = handle.cancel_signal();
    panel.set_cancel_signal(cancel.clone());
    panel.show_auth_url("https://fixture.example/authorize".to_string(), None);
    assert!(
        !cancel.cancelled(),
        "the flow starts live: the URL screen alone cancels nothing"
    );
    panel.handle_key("escape", &kb(), &mut sink());
    assert!(
        cancel.cancelled(),
        "Esc on the URL screen ends the running login (TS the dialog's abort)"
    );
}

#[test]
fn the_copy_binding_copies_the_mounted_url_into_the_actions_row() {
    let mut panel = AuthPanel::onboarding("Login to Prime Inference");
    panel.show_auth_url("https://fixture.example/authorize".to_string(), None);
    panel.handle_key("c", &kb(), &mut sink());
    let rows = frame_text(&mut panel);
    assert!(
        rows.iter().any(|row| row.contains("Copied sign-in link")
            || row.contains("Sign-in link sent to terminal clipboard (unconfirmed)")
            || row.contains("Failed to copy sign-in link")),
        "the copy outcome rides the actions row: {rows:?}"
    );
    // Without a mounted URL the copy binding does nothing: the plain `c` lands in the paste
    // field as input (the URL guard holds).
    let (mut panel, mut _answer) = mount_paste();
    panel.handle_key("c", &kb(), &mut sink());
    let rows = frame_text(&mut panel);
    assert!(
        !rows.iter().any(|row| row.contains("Copied sign-in link")),
        "no URL means no copy: {rows:?}"
    );
    let field = rows
        .iter()
        .find(|row| row.contains("Paste value") || row.contains('c'))
        .expect("the field row");
    assert!(
        field.contains('c'),
        "the plain key typed into the field: {rows:?}"
    );
}
