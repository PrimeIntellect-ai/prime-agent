//! Golden snapshot of the assembled layered system prompt. The prompt no
//! longer pins the TS text (the layered redesign supersedes TS-prompt
//! parity); the golden pins the Rust prompt itself so any layer edit is a
//! visible, reviewed change. Regenerate with `PA_UPDATE_GOLDEN=1 cargo test`.

use pa_core::prompts::system_prompt::{build_system_prompt, BuildSystemPromptOptions};
use pa_core::skills::load_skills_from_dir;
use std::path::Path;

const GOLDEN: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/golden/corpus/system-prompt.json"
);

#[derive(serde::Serialize, serde::Deserialize)]
struct GoldenCorpus {
    fixture: serde_json::Value,
    skill_count: usize,
    #[serde(rename = "systemPrompt")]
    system_prompt: String,
}

/// The workspace bundled skills directory (source-checkout layout):
/// pa-core lives at `<root>/crates/pa-core`.
fn bundled_skills_dir() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("workspace root")
        .join("skills")
}

/// Fixture-state prompt with the per-run values normalized: the skills
/// directory path, raw readdir skill order (both sides sort), and the date.
fn fixture_prompt() -> (String, usize) {
    let skills_dir = bundled_skills_dir();
    let mut loaded = load_skills_from_dir(&skills_dir, "package");
    // Skill enumeration is directory-order; pin content, not order.
    loaded
        .skills
        .sort_by(|left, right| left.name.cmp(&right.name));
    let count = loaded.skills.len();
    let prompt = build_system_prompt(&BuildSystemPromptOptions {
        cwd: "/w".to_string(),
        messages_path: Some("/w/sessions/fixture-session.jsonl".to_string()),
        skills: loaded.skills,
        selected_tools: Some(vec!["ipython"]),
        allow_recursion: Some(true),
        rlm_depth: Some(0),
        ..Default::default()
    })
    .replace(skills_dir.to_string_lossy().as_ref(), "<skills-dir>");
    let normalized = regex_lite_replace(&prompt);
    (normalized, count)
}

/// Replace `Current date: YYYY-MM-DD` with a placeholder (no chrono dep for
/// one substitution).
fn regex_lite_replace(text: &str) -> String {
    const MARKER: &str = "Current date: ";
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(MARKER) {
        out.push_str(&rest[..at + MARKER.len()]);
        let tail = &rest[at + MARKER.len()..];
        let date_len = tail
            .chars()
            .take_while(|ch| ch.is_ascii_digit() || *ch == '-')
            .count();
        let is_date = date_len == 10;
        if is_date {
            out.push_str("<date>");
            rest = &tail[date_len..];
        } else {
            rest = tail;
        }
    }
    out.push_str(rest);
    out
}

#[test]
fn system_prompt_matches_golden_snapshot() {
    let (prompt, skill_count) = fixture_prompt();
    if std::env::var("PA_UPDATE_GOLDEN").as_deref() == Ok("1") {
        let corpus = GoldenCorpus {
            fixture: serde_json::json!({
                "cwd": "/w",
                "messagesPath": "/w/sessions/fixture-session.jsonl",
                "selectedTools": ["ipython"],
                "skillsSource": "bundled skills directory (<skills-dir>)",
            }),
            skill_count,
            system_prompt: prompt,
        };
        std::fs::write(
            GOLDEN,
            serde_json::to_string_pretty(&corpus).expect("serialize golden") + "\n",
        )
        .expect("write golden");
        return;
    }
    let raw = std::fs::read_to_string(GOLDEN).expect("golden corpus");
    let golden: GoldenCorpus = serde_json::from_str(&raw).expect("golden corpus json");
    assert_eq!(
        skill_count, golden.skill_count,
        "bundled skill count changed; re-run with PA_UPDATE_GOLDEN=1 after updating the prompt layers"
    );
    assert_eq!(
        prompt, golden.system_prompt,
        "assembled prompt changed; if intended, re-run with PA_UPDATE_GOLDEN=1 and review the diff"
    );
}
