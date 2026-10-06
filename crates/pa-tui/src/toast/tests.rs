use super::*;

fn now() -> Instant {
    Instant::now()
}

#[test]
fn toasts_expire_on_their_ttl() {
    let mut toasts = Toasts::default();
    toasts.push("Copied");
    assert_eq!(toasts.active(now()).len(), 1);
    toasts.age_by(TOAST_TTL + Duration::from_millis(1));
    assert!(toasts.active(now()).is_empty());
    assert!(toasts.prune_expired(now()));
    assert!(toasts.entries.is_empty());
}

#[test]
fn pruning_a_fresh_stack_reports_no_change() {
    let mut toasts = Toasts::default();
    toasts.push("Again");
    assert!(!toasts.prune_expired(now()));
    assert_eq!(toasts.entries.len(), 1);
}

#[test]
fn the_stack_caps_at_the_limit() {
    let mut toasts = Toasts::default();
    for index in 0..=TOAST_STACK_LIMIT {
        toasts.push(format!("toast {index}"));
    }
    let texts: Vec<String> = toasts.active(now());
    assert_eq!(texts, vec!["toast 1", "toast 2", "toast 3"]);
}

#[test]
fn consecutive_repeats_coalesce_into_one_toast() {
    let mut toasts = Toasts::default();
    toasts.push("Copied to clipboard");
    toasts.push("Copied to clipboard");
    toasts.push("Copied to clipboard");
    let labels = toasts.active(now());
    assert_eq!(labels.len(), 1, "three copies are one toast, not rows");
    assert_eq!(labels[0], "Copied to clipboard (x3)");
    assert_eq!(toasts.entries.len(), 1);
    // Half the TTL twice stays inside a refreshed window (unrefreshed
    // expires before the second half).
    toasts.age_by(TOAST_TTL / 2);
    toasts.push("Copied to clipboard");
    toasts.age_by(TOAST_TTL / 2);
    assert_eq!(
        toasts.active(now()),
        vec!["Copied to clipboard (x4)"],
        "the refresh keeps the coalesced toast alive"
    );
}

#[test]
fn a_repeat_after_the_ttl_starts_a_fresh_toast() {
    let mut toasts = Toasts::default();
    toasts.push("Copied to clipboard");
    toasts.age_by(TOAST_TTL + Duration::from_millis(1));
    toasts.push("Copied to clipboard");
    assert_eq!(
        toasts.active(now()),
        vec!["Copied to clipboard"],
        "the fresh toast carries no count bump"
    );
}

#[test]
fn distinct_actions_stack_and_a_repeat_coalesces_into_its_own_toast() {
    let mut toasts = Toasts::default();
    toasts.push("Copied last agent message to clipboard");
    toasts.push("Copied selection to clipboard");
    let labels = toasts.active(now());
    assert_eq!(
        labels,
        vec![
            "Copied last agent message to clipboard",
            "Copied selection to clipboard",
        ],
        "distinct actions are separate toasts"
    );
    toasts.push("Copied last agent message to clipboard");
    assert_eq!(
        toasts.active(now()),
        vec![
            "Copied selection to clipboard",
            "Copied last agent message to clipboard (x2)",
        ],
        "the repeat refreshes its own toast, newest at the bottom"
    );
}

#[test]
fn the_pill_keeps_the_covered_rows_content() {
    let mut frame = vec![line_of("row content that stays visible underneath")];
    overlay_toasts(
        &mut frame,
        0,
        1,
        &["Copied to clipboard".to_string()],
        60,
        Style::default(),
    );
    let rendered: String = frame[0].iter().map(|span| span.content.clone()).collect();
    assert!(
        rendered.starts_with("row content"),
        "the row keeps its leading content: {rendered:?}"
    );
    assert!(
        rendered.contains(" Copied to clipboard "),
        "the pill lands on the row: {rendered:?}"
    );
    assert_eq!(
        crate::width::str_width(&rendered),
        60,
        "the composited row keeps the frame width"
    );
}

#[test]
fn the_pill_lands_right_aligned_and_leaves_other_rows_alone() {
    let width = 20;
    let pill = " Copied the answer ".to_string();
    let mut frame = vec![line_of(&"x".repeat(width)); 6];
    overlay_toasts(
        &mut frame,
        2,
        6,
        &["Copied the answer".to_string()],
        width,
        Style::default(),
    );
    let rendered: Vec<String> = frame
        .iter()
        .map(|line| {
            line.iter()
                .map(|span| span.content.clone())
                .collect::<String>()
        })
        .collect();
    let col = width - crate::width::str_width(&pill);
    // The unconditional close rides ahead of the pill (a zero-width
    // sequence: the visible columns stay the pill at the right edge).
    assert_eq!(
        rendered[2],
        format!(
            "{}{}{}",
            "x".repeat(col),
            crate::hyperlinks::OSC8_CLOSE,
            pill
        ),
        "the pill lands at the row's right edge"
    );
    assert_eq!(rendered[1], "x".repeat(width));
    assert_eq!(rendered[3], "x".repeat(width));
}

#[test]
fn an_overlong_pill_truncates_to_the_frame_width() {
    let mut frame = vec![line_of("row")];
    overlay_toasts(
        &mut frame,
        0,
        1,
        &["a very long toast label that cannot fit".to_string()],
        10,
        Style::default(),
    );
    let rendered: String = frame[0].iter().map(|span| span.content.clone()).collect();
    assert!(
        crate::width::str_width(&rendered) <= 10,
        "row: {rendered:?}"
    );
}

#[test]
fn a_tall_stack_overlays_only_what_fits() {
    let mut frame = vec![line_of("row"); 2];
    let toasts = vec!["one".to_string(), "two".to_string()];
    overlay_toasts(&mut frame, 1, 2, &toasts, 10, Style::default());
    assert!(frame[1].iter().any(|span| span.content.contains("two")));
}

#[test]
fn a_covered_row_keeps_its_zone_markers() {
    let mut frame = vec![line_of("row"); 2];
    crate::osc133::mark_start(&mut frame[1]);
    overlay_toasts(
        &mut frame,
        1,
        2,
        &["Copied".to_string()],
        20,
        Style::default(),
    );
    let row_text: String = frame[1].iter().map(|span| span.content.as_str()).collect();
    assert!(
        row_text.contains(crate::osc133::ZONE_START),
        "the zone marker survives the overlay: {row_text:?}"
    );
    assert!(row_text.contains("Copied"));
}

#[test]
fn the_end_bound_keeps_the_newest_inside_the_window() {
    let mut frame = vec![line_of("row"); 4];
    let toasts = vec!["one".to_string(), "two".to_string(), "three".to_string()];
    overlay_toasts(&mut frame, 1, 3, &toasts, 10, Style::default());
    assert!(
        !frame[1].iter().any(|span| span.content.contains("one")),
        "the oldest toast drops: {:?}",
        frame[1]
    );
    assert!(frame[1].iter().any(|span| span.content.contains("two")));
    assert!(frame[2].iter().any(|span| span.content.contains("three")));
    assert!(
        !frame[3].iter().any(|span| span.content.contains("three")),
        "the dock row stays untouched: {:?}",
        frame[3]
    );
}

#[test]
fn the_pill_carries_its_style() {
    use ratatui::style::Color;
    let mut frame = vec![line_of("row")];
    let style = Style::default().fg(Color::Green);
    overlay_toasts(&mut frame, 0, 1, &["Copied".to_string()], 10, style);
    let pill = frame[0]
        .iter()
        .find(|span| span.content.contains("Copied"))
        .expect("the pill renders");
    assert_eq!(pill.style, style);
}

#[test]
fn a_short_covered_row_keeps_the_pill_at_the_right_edge() {
    let width = 60;
    let pill = " Copied to clipboard ".to_string();
    let mut frame = vec![line_of("short row")];
    overlay_toasts(
        &mut frame,
        0,
        1,
        &["Copied to clipboard".to_string()],
        width,
        Style::default(),
    );
    let rendered: String = frame[0].iter().map(|span| span.content.clone()).collect();
    assert!(
        rendered.starts_with("short row"),
        "the covered content stays: {rendered:?}"
    );
    assert!(
        rendered.ends_with(&pill),
        "the pill lands at the right edge: {rendered:?}"
    );
    assert_eq!(
        crate::width::str_width(&rendered),
        width,
        "the composited row spans the frame width"
    );
}

/// A wide cluster clipping at the pill's column pads to the column
/// (the Bugbot straddle finding).
#[test]
fn a_wide_cluster_at_the_pill_column_still_places_the_pill_at_the_edge() {
    let width = 20;
    // Four double-width clusters cover columns 0..8; the pill column is
    // 18 minus the pill width, so the prefix clips mid-cluster and pads.
    let pill = " ok ".to_string();
    let col = width - crate::width::str_width(&pill);
    let clusters = "\u{65e5}".repeat(col / 2 + 1);
    let mut frame = vec![line_of(&clusters)];
    overlay_toasts(
        &mut frame,
        0,
        1,
        &["ok".to_string()],
        width,
        Style::default(),
    );
    let rendered: String = frame[0].iter().map(|span| span.content.clone()).collect();
    assert_eq!(
        crate::width::str_width(&rendered),
        width,
        "the pill lands at its column over a clipped cluster: {rendered:?}"
    );
    assert!(
        rendered.ends_with(&pill),
        "the pill rides the right edge: {rendered:?}"
    );
}

/// A covered hyperlink keeps its OSC 8 pair while the toast is up (the
/// Macroscope escape-stripping finding).
#[test]
fn a_covered_hyperlink_keeps_its_osc8_pair() {
    let url = "https://example.invalid/docs";
    let row_text = format!(
        "see {}the docs{} for the details{}",
        crate::hyperlinks::osc8_open(url),
        crate::hyperlinks::OSC8_CLOSE,
        " ".repeat(40)
    );
    let mut frame = vec![line_of(&row_text)];
    overlay_toasts(
        &mut frame,
        0,
        1,
        &["Copied to clipboard".to_string()],
        80,
        Style::default(),
    );
    let rendered: String = frame[0].iter().map(|span| span.content.clone()).collect();
    assert!(
        rendered.contains(&crate::hyperlinks::osc8_open(url)),
        "the link's open sequence survives: {rendered:?}"
    );
    assert!(
        rendered.contains(crate::hyperlinks::OSC8_CLOSE),
        "the link's close sequence survives: {rendered:?}"
    );
    assert!(rendered.contains("the docs"));
}

#[test]
fn a_link_cut_open_by_the_pill_closes_before_the_pill() {
    // The close is unconditional, so an unclosed in-row link and a
    // carried wrapped-link region behave the same.
    let url = "https://example.invalid/long";
    let row_text = format!(
        "{}the linked words{}",
        crate::hyperlinks::osc8_open(url),
        " ".repeat(60)
    );
    let width = 80;
    let pill = " Copied to clipboard ".to_string();
    let col = width - crate::width::str_width(&pill);
    let mut frame = vec![line_of(&row_text)];
    overlay_toasts(
        &mut frame,
        0,
        1,
        &["Copied to clipboard".to_string()],
        width,
        Style::default(),
    );
    let rendered: String = frame[0].iter().map(|span| span.content.clone()).collect();
    let close = crate::hyperlinks::OSC8_CLOSE;
    let close_at = rendered
        .find(close)
        .expect("the dangling link region closes");
    let pill_at = rendered.find(&pill).expect("the pill renders");
    assert!(
        close_at < pill_at,
        "the link closes before the pill: {rendered:?}"
    );
    let before_pill = &rendered[..pill_at];
    assert_eq!(
        crate::width::str_width(before_pill),
        col,
        "the close rides at the pill column: {rendered:?}"
    );
}

/// A link region CARRIED in from the row above (the writer's regions
/// resume at the next row's column 0) never leaks into the pill.
#[test]
fn a_carried_link_region_closes_before_the_pill() {
    let width = 80;
    let pill = " Copied to clipboard ".to_string();
    let col = width - crate::width::str_width(&pill);
    // Continuation text of a link opened on the row above: no OSC 8
    // escapes in this row.
    let mut frame = vec![line_of("continuation of the wrapped link's label text")];
    overlay_toasts(
        &mut frame,
        0,
        1,
        &["Copied to clipboard".to_string()],
        width,
        Style::default(),
    );
    let rendered: String = frame[0].iter().map(|span| span.content.clone()).collect();
    let close_at = rendered
        .find(crate::hyperlinks::OSC8_CLOSE)
        .expect("the composite closes the region before the pill");
    let pill_at = rendered.find(&pill).expect("the pill renders");
    assert!(
        close_at < pill_at,
        "the close precedes the pill over a carried region: {rendered:?}"
    );
    assert_eq!(
        crate::width::str_width(&rendered[..pill_at]),
        col,
        "the close rides at the pill column: {rendered:?}"
    );
}

fn line_of(text: &str) -> Line {
    vec![Span::raw(text.to_string())]
}
