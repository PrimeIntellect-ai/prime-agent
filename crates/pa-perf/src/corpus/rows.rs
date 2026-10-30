//! One session file's rows: the entry builders over the product's own
//! serializers (pa-types payloads inside pa-daemon's `SessionEntry`), the
//! conversation turn generator, and the marker discipline the bench
//! needles read from the corpus manifest.

use std::io::Write;
use std::path::Path;

use pa_daemon::session_store::{session_header_line, SessionEntry};
use pa_types::ai::{
    AssistantContentBlock, AssistantMessage, StopReason, TextContent, ThinkingContent, ToolCall,
    ToolResultMessage, Usage, UsageCost, UserContent, UserContentBlock, UserMessage,
};
use pa_types::session::{
    CompactionEntry, CustomMessageEntry, ModelChangeEntry, ServiceTierChangeEntry, SessionHeader,
    SessionState, SessionStateEntry, SessionStateStatus, ThinkingLevelChangeEntry,
};

use crate::rng::{iso_from_millis, Rng};

/// The top-level tools the product exposes to the model.
const TOOLS: [&str; 5] = ["bash", "edit", "python_repl", "websearch", "attach_image"];
/// The `custom_message` customType bank (a measured real-session mix).
const CUSTOM_TYPES: [&str; 8] = [
    "async_bash_completion",
    "heartbeat_prompt",
    "agent_message",
    "rlm_child_terminal_notice",
    "session_slash_command",
    "ipython_state",
    "provider_retry_outcome",
    "session_renamed",
];
/// Providers and models a real store carries. No id contains the letter
/// z: the switch-b row's `zqmark` name must be the only z in the corpus so
/// the switch query can never fuzzy-match another row.
const MODELS: [(&str, &str); 5] = [
    ("prime-inference", "glm-5.2"),
    ("prime-inference", "openai/gpt-5.6-sol"),
    ("anthropic", "claude-5-sonnet"),
    ("openai", "gpt-5.4"),
    ("google", "gemini-4-pro"),
];
/// The user-message word bank: plain lowercase words, joined into sentences.
const WORDS: [&str; 49] = [
    "the",
    "quick",
    "bench",
    "corpus",
    "session",
    "kernel",
    "worker",
    "daemon",
    "roster",
    "scan",
    "window",
    "cache",
    "entry",
    "branch",
    "leaf",
    "header",
    "row",
    "fold",
    "usage",
    "token",
    "model",
    "provider",
    "stream",
    "turn",
    "tool",
    "result",
    "call",
    "prompt",
    "context",
    "compaction",
    "summary",
    "refine",
    "harness",
    "memory",
    "skill",
    "label",
    "tree",
    "spawn",
    "child",
    "depth",
    "fanout",
    "seed",
    "profile",
    "median",
    "p95",
    "latency",
    "paint",
    "frame",
    "needle",
];
/// Bash-output shapes for tool results.
const TOOL_OUTPUTS: [&str; 6] = [
    "warning: unused variable: `baseline`\n  --> src/lib.rs:42:13\n",
    "test result: ok. 96 passed; 0 failed; 3 ignored\n",
    "commit 33da15a2c (HEAD -> main)\nAuthor: dev <dev@example.com>\n",
    "total 24\ndrwxr-xr-x  7 user  staff  224 Oct 14 09:02 .\n",
    "updating crates.io index\n   Compiling pa-perf v0.10.0\n",
    "{\"median_ms\": 812.3, \"p95_ms\": 941.0, \"runs\": 10}\n",
];

/// One session to generate.
pub(crate) struct SessionSpec {
    pub id: String,
    /// Session-start unix milliseconds; entry timestamps derive from it.
    pub start_ms: u64,
    pub cwd: String,
    pub rows: usize,
    pub name: Option<String>,
    /// A unique string placed in the LAST user message (the bench needle:
    /// the transcript paints the session tail on open). Its reply is one
    /// short text line, so rows the product appends at attach cannot push
    /// the marker off screen.
    pub marker: Option<String>,
    pub parent_session: Option<String>,
    pub rlm_depth: Option<u64>,
    /// Prefix every generated text block with its ordinal (`ORDINAL_PREFIX` +
    /// n, counting up in transcript order) so a scrolled screen names how far
    /// up it is; the marker turn stays untagged.
    pub ordinals: bool,
}

/// The block-ordinal token: `ord` + the ordinal's digits. No generated
/// word contains `ord`, so the token is unambiguous on any screen.
pub const ORDINAL_PREFIX: &str = "ord";

/// What one generated session produced.
pub(crate) struct Written {
    pub rows: usize,
    /// The final user-message text (the marker, when one was requested).
    pub last_user_text: String,
}

/// The deterministic uuid-v7-shaped id stream: timestamp prefix + rng tail
/// with the version/variant nibbles v7 carries.
pub(crate) fn session_id(rng: &mut Rng, start_ms: u64) -> String {
    let rand_a = (rng.next_u64() & 0xFFFF) as u32;
    let rand_b = rng.next_u64();
    let tail = rng.next_u64();
    let a = (start_ms & 0xFFFF_FFFF) as u32;
    format!(
        "{a:08x}-{rand_a:04x}-7{:03x}-8{:03x}-{:05x}{:07x}",
        (rand_b >> 20) & 0xFFF,
        (tail >> 52) as u32 & 0xFFF,
        (rand_b & 0x000F_FFFF) as u32,
        (tail & 0x0FFF_FFFF) as u32,
    )
}

fn sentence(rng: &mut Rng, words: usize) -> String {
    (0..words)
        .map(|_| WORDS[rng.below(WORDS.len() as u64) as usize])
        .collect::<Vec<_>>()
        .join(" ")
}

fn user_text(rng: &mut Rng) -> String {
    (0..(1 + rng.below(3)))
        .map(|_| {
            let words = 6 + rng.below(12);
            let mut text = sentence(rng, words as usize);
            if rng.chance(12) {
                text.push_str(&format!(" ({})", sentence(rng, 2)));
            }
            text.push('.');
            text
        })
        .collect::<String>()
}

fn assistant_text(rng: &mut Rng) -> String {
    let mut text = String::new();
    for _ in 0..(1 + rng.below(3)) {
        for _ in 0..(2 + rng.below(4)) {
            let words = 8 + rng.below(16);
            text.push_str(&sentence(rng, words as usize));
            text.push_str(". ");
        }
        text.push('\n');
    }
    text
}

fn tool_output(rng: &mut Rng) -> String {
    let mut text = TOOL_OUTPUTS[rng.below(TOOL_OUTPUTS.len() as u64) as usize].to_string();
    text.push_str(&sentence(rng, 3));
    text.push('\n');
    text
}

fn usage(rng: &mut Rng) -> Usage {
    let input = 500 + rng.below(8000);
    let cache_read = input * (50 + rng.below(46)) / 100;
    let output = 50 + rng.below(2000);
    let cache_write = rng.below(500);
    let total = input + output + cache_read + cache_write;
    let cost = |n: u64| pa_types::JsNumber::from(n as f64 / 1000.0);
    Usage {
        input,
        output,
        cache_read,
        cache_write,
        total_tokens: total,
        cost: UsageCost {
            input: cost(input),
            output: cost(output),
            cache_read: cost(cache_read),
            cache_write: cost(cache_write),
            total: cost(total),
        },
    }
}

/// The row writer: one `SessionEntry` line, exactly as the product's store
/// serializes it (`type`, `id`, `parentId`, `timestamp`, then the payload).
struct Rows {
    writer: std::io::BufWriter<std::fs::File>,
    counter: u64,
    millis: u64,
    parent: Option<String>,
}

impl Rows {
    fn next_id(&mut self) -> String {
        let id = format!("{:08x}", self.counter);
        self.counter += 1;
        id
    }

    fn push(
        &mut self,
        type_: &str,
        fields: serde_json::Value,
        rng: &mut Rng,
    ) -> anyhow::Result<()> {
        self.millis += 20 + rng.below(400);
        let entry = SessionEntry {
            type_: type_.to_string(),
            id: self.next_id(),
            parent_id: self.parent.clone(),
            timestamp: iso_from_millis(self.millis),
            fields,
        };
        let mut line = serde_json::to_string(&entry).expect("the entry serializes");
        line.push('\n');
        self.writer.write_all(line.as_bytes())?;
        self.parent = Some(entry.id);
        Ok(())
    }

    fn rows_written(&self) -> u64 {
        self.counter
    }
}

/// One session file: the header line, then the chained entries. Returns the
/// row count and the last user-message text.
///
/// # Errors
///
/// Propagates serialization and filesystem failures.
pub(crate) fn write_session_file(
    path: &Path,
    spec: &SessionSpec,
    rng: &mut Rng,
) -> anyhow::Result<Written> {
    let (provider, model) = MODELS[rng.below(MODELS.len() as u64) as usize];
    let header = SessionHeader {
        version: Some(3),
        id: spec.id.clone(),
        timestamp: iso_from_millis(spec.start_ms),
        cwd: spec.cwd.clone(),
        parent_session: spec.parent_session.clone(),
        rlm_depth: spec.rlm_depth,
        git: None,
        rest: serde_json::Map::new(),
    };
    let file = std::fs::File::create(path)?;
    let mut rows = Rows {
        writer: std::io::BufWriter::new(file),
        counter: 0,
        millis: spec.start_ms,
        parent: None,
    };
    let mut header_line =
        serde_json::to_string(&session_header_line(&header)).expect("the header serializes");
    header_line.push('\n');
    rows.writer.write_all(header_line.as_bytes())?;

    rows.push(
        "model_change",
        serde_json::to_value(ModelChangeEntry {
            provider: provider.to_string(),
            model_id: model.to_string(),
        })?,
        rng,
    )?;
    rows.push(
        "thinking_level_change",
        serde_json::to_value(ThinkingLevelChangeEntry {
            thinking_level: if rng.chance(70) { "high" } else { "medium" }.to_string(),
        })?,
        rng,
    )?;
    rows.push(
        "service_tier_change",
        serde_json::to_value(ServiceTierChangeEntry {
            service_tier: Some(pa_types::ai::ServiceTier::Default),
        })?,
        rng,
    )?;
    rows.push(
        "session_state",
        serde_json::to_value(SessionStateEntry {
            state: SessionState {
                status: SessionStateStatus::Active,
            },
        })?,
        rng,
    )?;
    if let Some(name) = &spec.name {
        rows.push("session_info", serde_json::json!({ "name": name }), rng)?;
    }

    // The conversation: fill to `rows`, keeping a compaction boundary near
    // 60% for long sessions and the marker on the final user message.
    let target = spec.rows as u64;
    let mut ordinals = spec.ordinals.then_some(0u64..);
    let mut tag = |text: String| match ordinals.as_mut().and_then(Iterator::next) {
        Some(ordinal) => format!("{ORDINAL_PREFIX}{ordinal} {text}"),
        None => text,
    };
    let mut compaction_at = (target >= 1500).then(|| target * 6 / 10);
    let mut last_user_text = String::new();
    while rows.rows_written() < target {
        if compaction_at.is_some_and(|threshold| rows.rows_written() >= threshold) {
            compaction_at = None;
            let summary = format!("Compacted earlier entries: {}.", sentence(rng, 6));
            rows.push(
                "compaction",
                serde_json::to_value(CompactionEntry {
                    summary: summary.clone(),
                    first_kept_entry_id: format!("{:08x}", rows.counter),
                    tokens_before: 40_000 + rng.below(60_000),
                    details: None,
                    from_hook: Some(false),
                    custom_instructions: None,
                    usage: Some(usage(rng)),
                    harness_digest: None,
                    harness_state_fingerprint: None,
                })?,
                rng,
            )?;
            continue;
        }

        let marker_turn = spec.marker.is_some() && target - rows.rows_written() <= 4;
        let text = match &spec.marker {
            Some(marker) if marker_turn => marker.clone(),
            _ => tag(user_text(rng)),
        };
        let content = if rng.chance(30) {
            UserContent::Blocks(vec![UserContentBlock::Text(TextContent {
                text: text.clone(),
                text_signature: None,
                rest: serde_json::Map::new(),
            })])
        } else {
            UserContent::Text(text.clone())
        };
        rows.push(
            "message",
            serde_json::json!({
                "message": pa_types::session::AgentMessage::User(UserMessage {
                    content,
                    timestamp: rows.millis,
                    rest: serde_json::Map::new(),
                })
            }),
            rng,
        )?;
        last_user_text = text;

        // The assistant turn: thinking + text + a tool call, then the result.
        let tool = (!marker_turn && rng.chance(45)).then(|| {
            let name = TOOLS[rng.below(TOOLS.len() as u64) as usize];
            let id = format!("call-{:08x}", rows.counter);
            let mut arguments = serde_json::Map::new();
            arguments.insert(
                "path".to_string(),
                serde_json::json!(format!("src/mod{}.rs", rng.below(400))),
            );
            arguments.insert("query".to_string(), serde_json::json!(sentence(rng, 3)));
            (id, name)
        });
        let mut blocks = Vec::new();
        if !marker_turn && rng.chance(60) {
            blocks.push(AssistantContentBlock::Thinking(ThinkingContent {
                thinking: tag(assistant_text(rng)),
                thinking_signature: None,
                redacted: None,
                rest: serde_json::Map::new(),
            }));
        }
        blocks.push(AssistantContentBlock::Text(TextContent {
            text: if marker_turn {
                "Done.".to_string()
            } else {
                tag(assistant_text(rng))
            },
            text_signature: None,
            rest: serde_json::Map::new(),
        }));
        if let Some((id, name)) = &tool {
            blocks.push(AssistantContentBlock::ToolCall(ToolCall {
                id: id.clone(),
                name: (*name).to_string(),
                arguments: {
                    let mut map = serde_json::Map::new();
                    map.insert(
                        "path".to_string(),
                        serde_json::json!(format!("src/mod{}.rs", rng.below(400))),
                    );
                    map.insert("query".to_string(), serde_json::json!(sentence(rng, 3)));
                    map
                },
                thought_signature: None,
                rest: serde_json::Map::new(),
            }));
        }
        let stop_reason = if tool.is_some() {
            StopReason::ToolUse
        } else if !marker_turn && rng.chance(2) {
            StopReason::Error
        } else {
            StopReason::Stop
        };
        rows.push(
            "message",
            serde_json::json!({
                "message": pa_types::session::AgentMessage::Assistant(AssistantMessage {
                    content: blocks,
                    api: "openai".to_string(),
                    provider: provider.to_string(),
                    model: model.to_string(),
                    response_model: None,
                    response_id: None,
                    diagnostics: None,
                    usage: usage(rng),
                    stop_reason,
                    stop_reason_raw: None,
                    error_message: None,
                    timestamp: rows.millis,
                    rest: serde_json::Map::new(),
                })
            }),
            rng,
        )?;

        if let Some((call_id, name)) = tool {
            rows.push(
                "message",
                serde_json::json!({
                    "message": pa_types::session::AgentMessage::ToolResult(ToolResultMessage {
                        tool_call_id: call_id,
                        tool_name: name.to_string(),
                        content: vec![UserContentBlock::Text(TextContent {
                            text: tag(tool_output(rng)),
                            text_signature: None,
                            rest: serde_json::Map::new(),
                        })],
                        details: None,
                        is_error: rng.chance(10),
                        timestamp: rows.millis,
                        rest: serde_json::Map::new(),
                    })
                }),
                rng,
            )?;
        }

        if !marker_turn && rng.chance(7) {
            let custom = CUSTOM_TYPES[rng.below(CUSTOM_TYPES.len() as u64) as usize];
            rows.push(
                "custom_message",
                serde_json::to_value(CustomMessageEntry {
                    custom_type: custom.to_string(),
                    content: UserContent::Text(format!("[{custom}] {}", sentence(rng, 8))),
                    details: None,
                    display: false,
                    rest: serde_json::Map::new(),
                })?,
                rng,
            )?;
        }
    }

    rows.writer.flush()?;
    Ok(Written {
        rows: rows.counter as usize,
        last_user_text,
    })
}

#[cfg(test)]
mod tests {
    fn spec(rows: usize) -> super::SessionSpec {
        super::SessionSpec {
            id: "corpus-regression".to_string(),
            start_ms: 1_700_000_000_000,
            cwd: "/tmp".to_string(),
            rows,
            name: Some("regression".to_string()),
            marker: Some("final user marker".to_string()),
            parent_session: None,
            rlm_depth: Some(0),
            ordinals: false,
        }
    }

    #[test]
    fn final_user_marker_survives_all_small_turn_shapes() {
        let directory = tempfile::tempdir().expect("session directory");
        for seed in 0..16 {
            for target in 9..32 {
                let written = super::write_session_file(
                    &directory.path().join("session.jsonl"),
                    &spec(target),
                    &mut crate::rng::Rng::new(seed),
                )
                .expect("write session");
                assert_eq!(
                    written.last_user_text, "final user marker",
                    "seed={seed}, target={target}"
                );
            }
        }
    }

    #[test]
    fn long_sessions_crossing_compaction_threshold_have_exactly_one_boundary() {
        let directory = tempfile::tempdir().expect("session directory");
        let path = directory.path().join("session.jsonl");
        for seed in 0..8 {
            super::write_session_file(&path, &spec(1500), &mut crate::rng::Rng::new(seed))
                .expect("write long session");
            let rows: Vec<serde_json::Value> = std::fs::read_to_string(&path)
                .expect("read session")
                .lines()
                .map(|line| serde_json::from_str(line).expect("valid row"))
                .collect();
            assert_eq!(
                rows.iter()
                    .filter(|row| row["type"] == "compaction")
                    .count(),
                1,
                "seed={seed}"
            );
            let entries = pa_core::session::parse_session_entries(
                &std::fs::read_to_string(&path).expect("read generated session"),
            );
            let context = pa_core::session::build_session_context(&entries, None);
            assert_eq!(
                context
                    .messages
                    .iter()
                    .filter(|message| matches!(
                        message,
                        pa_types::session::AgentMessage::CompactionSummary(_)
                    ))
                    .count(),
                1,
                "the real context builder must not duplicate the summary; seed={seed}"
            );
        }
    }
}
