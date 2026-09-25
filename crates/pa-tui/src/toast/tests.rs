use super::*;

fn now() -> Instant {
    Instant::now()
}

/// A toast starts active, expires after its TTL, and pruning drops it.
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

/// Pruning with nothing to drop reports no change.
#[test]
fn pruning_a_fresh_stack_reports_no_change() {
    let mut toasts = Toasts::default();
    toasts.push("Again");
    assert!(!toasts.prune_expired(now()));
    assert_eq!(toasts.entries.len(), 1);
}

/// The stack keeps the newest toasts and caps at the limit.
#[test]
fn the_stack_caps_at_the_limit() {
    let mut toasts = Toasts::default();
    for index in 0..=TOAST_STACK_LIMIT {
        toasts.push(format!("toast {index}"));
    }
    let texts: Vec<String> = toasts.active(now());
    assert_eq!(texts, vec!["toast 1", "toast 2", "toast 3"]);
}

/// Consecutive repeats of the same action COALESCE: the toast stack
/// holds one entry, its TTL resets (the repeat keeps it alive), and
/// its label carries the count bump.
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
    // The TTL reset: half the TTL twice stays inside a refreshed
    // window (an unrefreshed toast expires before the second half).
    toasts.age_by(TOAST_TTL / 2);
    toasts.push("Copied to clipboard");
    toasts.age_by(TOAST_TTL / 2);
    assert_eq!(
        toasts.active(now()),
        vec!["Copied to clipboard (x4)"],
        "the refresh keeps the coalesced toast alive"
    );
}

/// A repeat AFTER the previous toast's TTL starts a fresh window: no
/// count bump for a confirmation the user has already seen expire.
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

/// Distinct actions keep their own toasts; a repeat of one of them
/// coalesces into THAT toast (it is the toast the user last triggered)
/// and moves it to the bottom of the stack.
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

/// The overlay composites a compact right-aligned pill over the row:
/// the covered row's own content survives outside the pill's columns
/// — the toast never spans the whole row.
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
    let rendered: String = frame[0]
        .iter()
        .map(|span| span.content.to_string())
        .collect();
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

/// Right-aligned: the pill sits at the row's right edge and the rows
/// outside the stack stay untouched.
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
                .map(|span| span.content.to_string())
                .collect::<String>()
        })
        .collect();
    let col = width - crate::width::str_width(&pill);
    assert_eq!(
        rendered[2],
        format!("{}{}", "x".repeat(col), pill),
        "the pill lands at the row's right edge"
    );
    assert_eq!(rendered[1], "x".repeat(width));
    assert_eq!(rendered[3], "x".repeat(width));
}

/// A label wider than the frame truncates instead of wrapping past
/// the frame edge.
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
    let rendered: String = frame[0]
        .iter()
        .map(|span| span.content.to_string())
        .collect();
    assert!(
        crate::width::str_width(&rendered) <= 10,
        "row: {rendered:?}"
    );
}

/// A stack taller than the frame's rows overlays only what fits.
#[test]
fn a_tall_stack_overlays_only_what_fits() {
    let mut frame = vec![line_of("row"); 2];
    let toasts = vec!["one".to_string(), "two".to_string()];
    overlay_toasts(&mut frame, 1, 2, &toasts, 10, Style::default());
    assert!(frame[1].iter().any(|span| span.content.contains("two")));
}

/// A covered row keeps its leading OSC 133 zone markers: shell
/// integration's turn-boundary jumps keep working while the toast is
/// visible over the row (the follow-hint composite's rule).
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

/// The end bound keeps the overlay inside the transcript window, and a
/// window shorter than the stack keeps the NEWEST toasts: the third
/// toast never lands on the dock's first row, and the latest
/// acknowledgment is the one that stays visible.
#[test]
fn the_end_bound_keeps_the_newest_inside_the_window() {
    let mut frame = vec![line_of("row"); 4];
    let toasts = vec!["one".to_string(), "two".to_string(), "three".to_string()];
    // Transcript window: rows 1..3 (end 3); the window holds two
    // toasts, so the NEWEST two overlay and the dock row stays
    // untouched.
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

/// A styled span keeps the pill's style (the composite must not restyle
/// the covered row's own spans).
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

/// A short covered row keeps the pill at the right edge: the composited
/// prefix pads up to the pill column (the Macroscope short-row
/// finding), so the row spans the full width with the pill at its end.
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
    let rendered: String = frame[0]
        .iter()
        .map(|span| span.content.to_string())
        .collect();
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
/// (the Bugbot straddle finding): the pill never shifts off the right
/// edge.
#[test]
fn a_wide_cluster_at_the_pill_column_still_places_the_pill_at_the_edge() {
    let width = 20;
    // Four double-width clusters cover columns 0..8; the pill column
    // is 18 minus the pill width, so the prefix clips mid-cluster and
    // pads the rest of the way.
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
    let rendered: String = frame[0]
        .iter()
        .map(|span| span.content.to_string())
        .collect();
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

/// A covered hyperlink keeps its OSC 8 pair while the toast is up
/// (the Macroscope escape-stripping finding): the prefix slice keeps
/// the zero-width escapes in its column range.
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
    let rendered: String = frame[0]
        .iter()
        .map(|span| span.content.to_string())
        .collect();
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

/// A link region the pill cuts OPEN closes before the pill: the
/// pill's cells must not inherit the hyperlink.
#[test]
fn a_link_cut_open_by_the_pill_closes_before_the_pill() {
    // (The close is unconditional, so a row whose link never closes
    // in-row and a row carrying a wrapped link's region behave the
    // same - see the carried-region test below.)
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
    let rendered: String = frame[0]
        .iter()
        .map(|span| span.content.to_string())
        .collect();
    let close = crate::hyperlinks::OSC8_CLOSE;
    let close_at = rendered
        .find(close)
        .expect("the dangling link region closes");
    let pill_at = rendered.find(&pill).expect("the pill renders");
    assert!(
        close_at < pill_at,
        "the link closes before the pill: {rendered:?}"
    );
    // The closing sequence rides at the pill's column: the covered
    // content ends at the column and the region closes exactly there.
    let before_pill = &rendered[..pill_at];
    assert_eq!(
        crate::width::str_width(before_pill),
        col,
        "the close rides at the pill column: {rendered:?}"
    );
}

/// A link region CARRIED in from the row above (a wrapped link: the
/// covered row holds the continuation text without its own OSC 8
/// pair, and the writer's regions resume at the next row's column 0)
/// never leaks into the pill: the composite's close lands before the
/// pill's cells whatever the covered row itself says (Macroscope's
/// wrapped-continuation finding).
#[test]
fn a_carried_link_region_closes_before_the_pill() {
    let width = 80;
    let pill = " Copied to clipboard ".to_string();
    let col = width - crate::width::str_width(&pill);
    // Continuation text of a link opened on the row above: no OSC 8
    // escapes inside this row at all.
    let mut frame = vec![line_of("continuation of the wrapped link's label text")];
    overlay_toasts(
        &mut frame,
        0,
        1,
        &["Copied to clipboard".to_string()],
        width,
        Style::default(),
    );
    let rendered: String = frame[0]
        .iter()
        .map(|span| span.content.to_string())
        .collect();
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
