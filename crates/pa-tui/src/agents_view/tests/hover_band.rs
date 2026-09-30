//! The hover affordance (operator directive 2026-09-29): the row under the mouse carries the
//! ONE light hover band — the "clickable" signal — on every row the click grammar covers. The
//! one-color ruling: the keyboard selection paints the SAME band color; the two states
//! distinguish by their cues (transient mouse vs sticky keyboard), never by color.

use super::*;

/// One buttonless motion report (`?1003` any-event tracking): the
/// hover affordance's input.
fn hover_motion(row: usize) -> crate::mouse::MouseEvent {
    crate::mouse::MouseEvent {
        button: crate::mouse::BUTTON_NONE,
        x: 3,
        y: (row + 1) as u16,
        press: true,
        motion: true,
        shift: false,
        alt: false,
        ctrl: false,
    }
}

/// The frame row of the line holding `needle`, if it renders.
fn row_of(lines: &[Line], needle: &str) -> Option<usize> {
    lines.iter().position(|line| flat(line).contains(needle))
}

/// A motion over one session row hovers it: the rendered row carries the light hover band
/// over its full width.
#[test]
fn a_motion_hovers_the_row_under_the_mouse() {
    let _guard = match crate::mouse_tracking::STATE_TEST_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    crate::mouse_tracking::enable(&mut std::io::stdout()).expect("enable");
    let (mut mode, index) = mode_with_row("hover over me", "mock-1");
    let (lines, _) = mode.render_frame(120, 24);
    let row = row_of(&lines, "hover over me").expect("the row renders");
    assert_eq!(
        mode.click_rows
            .iter()
            .find(|(click_row, _)| *click_row == row),
        Some(&(row, index)),
        "the hovered row is a click row"
    );
    mode.handle_mouse(&hover_motion(row));
    assert_eq!(mode.hover_row, Some(row), "the motion hovered the row");
    let (lines, _) = mode.render_frame(120, 24);
    let hovered = &lines[row];
    let band = mode.theme.hover_row_style().bg;
    assert!(
        hovered.iter().any(|span| span.style.bg == band),
        "the hovered row carries the light hover band: {hovered:?}"
    );
    assert!(
        hovered.iter().all(|span| span.style.bg == band),
        "the light band spans the hovered row: {hovered:?}"
    );
    crate::mouse_tracking::disable(&mut std::io::stdout()).expect("disable");
}

/// A motion over a non-row (the heading, the hint line, the splash)
/// never hovers: the band only rides rows the click grammar covers.
#[test]
fn a_motion_over_a_heading_or_hint_never_hovers() {
    let _guard = match crate::mouse_tracking::STATE_TEST_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    crate::mouse_tracking::enable(&mut std::io::stdout()).expect("enable");
    let (mut mode, _) = mode_with_row("plain roster", "mock-1");
    let (lines, _) = mode.render_frame(120, 24);
    let heading = row_of(&lines, "Idle (").expect("the section heading renders");
    mode.handle_mouse(&hover_motion(heading));
    assert_eq!(mode.hover_row, None, "a heading is not a click row");
    let row = row_of(&lines, "plain roster").expect("the row renders");
    mode.handle_mouse(&hover_motion(row));
    assert_eq!(mode.hover_row, Some(row));
    mode.handle_mouse(&hover_motion(lines.len() - 1));
    assert_eq!(mode.hover_row, None);
    crate::mouse_tracking::disable(&mut std::io::stdout()).expect("disable");
}

/// The ONE band color (the operator's 2026-09-29 one-color ruling): the hover and the keyboard
/// selection paint the SAME light band; the selected row keeps its band under the mouse.
#[test]
fn the_hover_and_the_selection_share_the_one_band_color() {
    let _guard = match crate::mouse_tracking::STATE_TEST_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    crate::mouse_tracking::enable(&mut std::io::stdout()).expect("enable");
    let (mut mode, _) = mode_with_row("hover me too", "mock-1");
    let (lines, _) = mode.render_frame(120, 24);
    let held = row_of(&lines, "holder").expect("the holder row renders");
    let other = row_of(&lines, "hover me too").expect("the hovered row renders");
    let light = mode.theme.hover_row_style().bg;
    let band = mode.theme.selection_row_style().bg;
    assert_eq!(
        band, light,
        "the selection paints the hover's own color — the one-color ruling"
    );
    mode.handle_mouse(&hover_motion(held));
    assert_eq!(mode.hover_row, Some(held));
    let (lines, _) = mode.render_frame(120, 24);
    let selected = &lines[held];
    assert!(
        selected.iter().all(|span| span.style.bg == band),
        "the hovered selected row keeps its band: {selected:?}"
    );
    mode.handle_mouse(&hover_motion(other));
    assert_eq!(mode.hover_row, Some(other));
    let (lines, _) = mode.render_frame(120, 24);
    let hovered = &lines[other];
    assert!(
        hovered.iter().all(|span| span.style.bg == band),
        "the hovered unselected row carries the one band color: {hovered:?}"
    );
    let still_selected = &lines[held];
    assert!(
        still_selected.iter().all(|span| span.style.bg == band),
        "the selection keeps its band while another row hovers: {still_selected:?}"
    );
    crate::mouse_tracking::disable(&mut std::io::stdout()).expect("disable");
}

/// The dropdown's own rows hover like every other row: the merged `N subagents (M running)`
/// summary and the children it expands both carry the light band under the mouse.
#[test]
fn the_merged_dropdown_rows_hover_like_every_row() {
    let _guard = match crate::mouse_tracking::STATE_TEST_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    crate::mouse_tracking::enable(&mut std::io::stdout()).expect("enable");
    let mut mode = mode_with_parent_and_child();
    let (lines, _) = mode.render_frame(120, 36);
    let summary = row_of(&lines, "1 subagents (1 running)").expect("the merged line renders");
    let light = mode.theme.hover_row_style().bg;
    mode.handle_mouse(&hover_motion(summary));
    assert_eq!(mode.hover_row, Some(summary));
    let (lines, _) = mode.render_frame(120, 36);
    assert!(
        lines[summary].iter().all(|span| span.style.bg == light),
        "the merged summary row carries the light band: {:?}",
        lines[summary]
    );
    mode.handle_key("down");
    mode.handle_key("enter");
    let (lines, _) = mode.render_frame(120, 36);
    let child = row_of(&lines, "worker one").expect("the expanded child renders");
    mode.handle_mouse(&hover_motion(child));
    assert_eq!(mode.hover_row, Some(child));
    let (lines, _) = mode.render_frame(120, 36);
    assert!(
        lines[child].iter().all(|span| span.style.bg == light),
        "the expanded child row carries the light band: {:?}",
        lines[child]
    );
    // A rebuild that scrolls the hovered row out of the window clears the band: content that
    // moved under the mouse re-aims it, and a row that left never stays bright.
    mode.handle_mouse(&hover_motion(2));
    mode.roster.clear();
    mode.rebuild_rows();
    let (lines, _) = mode.render_frame(120, 36);
    assert_eq!(
        mode.hover_row, None,
        "a hovered row that no longer renders clears with the rebuild"
    );
    assert!(row_of(&lines, "worker one").is_none());
    crate::mouse_tracking::disable(&mut std::io::stdout()).expect("disable");
}

/// The hover never disturbs the click grammar: motions across rows and headings, then a plain
/// click — the click still opens the row under it.
#[test]
fn hover_motions_never_disturb_the_click_grammar() {
    let _guard = match crate::mouse_tracking::STATE_TEST_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    crate::mouse_tracking::enable(&mut std::io::stdout()).expect("enable");
    let (mut mode, index) = mode_with_row("click through the hover", "mock-1");
    mode.rows[index].summary = serde_json::json!({
        "sessionName": "click through the hover",
        "activeSessionId": "s-hover-click",
    });
    let (lines, _) = mode.render_frame(120, 24);
    let row = row_of(&lines, "click through the hover").expect("the row renders");
    mode.handle_mouse(&hover_motion(0));
    mode.handle_mouse(&hover_motion(row));
    mode.handle_mouse(&hover_motion(1));
    mode.handle_mouse(&mouse_report(row, true, false));
    mode.handle_mouse(&mouse_report(row, false, false));
    let opened = mode.opened.expect("the click opened the row");
    assert_eq!(
        opened.selection,
        SessionSelection::Attach("s-hover-click".to_string())
    );
    crate::mouse_tracking::disable(&mut std::io::stdout()).expect("disable");
}
