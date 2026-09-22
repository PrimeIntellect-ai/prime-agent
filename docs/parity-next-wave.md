# Parity next wave — plan

Planning deliverable from the `parity-survey-1` lane (no code). It turns the
[FEATURE_PARITY.md](FEATURE_PARITY.md) audit (main `64f66e3d`: 689 rows, 254 MISSING / 128 PARTIAL)
into a prioritized **next wave of 14 lanes** (each a closable 1–3 day unit), and recommends the
first three to spawn.

## Mission context

The box has flipped to the Rust port (the mission dogfoods its own binary). Kevin's mandate:
"everything works well, all these bugs are patched, and that we get closer to feature parity."
So this wave is ordered by **what the daily dogfood touches**, then by **what unblocks other
rows**, then by cheap wins. Wire-internal and exotic rows come last.

## How to read this doc

- All TS paths are relative to `~/prime-agent` (the parity ground truth). `interactive-mode.ts`
  = `packages/coding-agent/src/modes/interactive/interactive-mode.ts`; section-3 short paths
  (`utils.ts`, `editor.ts`, `tui.ts`, …) = `packages/tui/src/…`.
- All Rust paths are relative to the repo root (`crates/pa-tui/src/…`).
- "Rows" counts are from FEATURE_PARITY.md, status column included per row.
- Rows owned by the 13 **in-flight lanes** (clip-auth-cmds, info-commands, utility-commands,
  model-fix, heartbeats-menu, mouse-select, agent-message-ui, panel-nav, thinking-level,
  prompt-stash, mcp-view, av-bold, codex-id) are **excluded** — do not re-spawn them.
- Per repo rules, every user-visible feature ships its adoption telemetry event in the same PR
  (see AGENTS.md / docs/telemetry-events.md); suggested event names are listed per lane.

## Prioritization criteria

1. **Crash/correctness class first** — anything that breaks the editing loop itself
   (panics, swallowed input) outranks any feature.
2. **Daily dogfood surfaces** — editor input, abort/escape semantics, `!` bash, markdown/diff
   rendering, startup chrome.
3. **Unblockers** — rows whose absence blocks or distorts other rows
   (diff rendering reused 3 ways; transcript decode gaps that make replay diverge).
4. **Cheap wins** — small, self-contained, verifiable in a day.

## Wave at a glance

| # | Lane | Priority | Rows (M/P) | Est. | Verifier | Main risk |
|---|---|---|---|---|---| ---|
| 1 | `editor-wrap-unicode` | **P0** | 1 / 5 | 1 d | new `editor_unicode_parity.py` + golden Unicode corpus | subtle grapheme/width semantics |
| 2 | `term-enhanced-keys` | **P0** | 1 / 3 | 1.5 d | `scripts/bracketed_paste_parity.py` + new kitty-key harness | terminal-capability matrix |
| 3 | `interrupt-paths` (incl. `signal-handlers`) | **P1** | 4 / 2 | 1.5 d | new `interrupt_parity.py` (tmux ESC/Ctrl-C/SIGTERM) | race: abort vs in-flight tool result |
| 4 | `bash-mode` | **P1** | 3 / 3 | 1.5 d | existing `scripts/bang_parity.py` | live-event coalescing vs replay |
| 5 | `edit-diffs` | **P1** | 9 / 2 | 2 d | new `edit_diff_parity.py` + golden diff corpus | highlighter perf during stream |
| 6 | `md-render` (latex+blocks+inline+prefilter+cache) | **P1** | 6 / 5 | 2.5 d | new markdown golden-corpus frame-diff | tokenizer regressions on prose |
| 7 | `settings-menu` | **P1** | 9 / 0 | 1.5 d | tmux key-walk parity on `/settings` | 20+ callback surface breadth |
| 8 | `transcript-extras` (+ msg-card-gaps, re-attach fidelity) | **P2** | 17 / 0 | 2 d | `skill_invocation_parity.py` + golden session replay | wire semantics of resync events |
| 9 | `startup-notices` (+ update notices, OSC progress) | **P2** | 11 / 2 | 1.5 d | `attach_first_frame_parity.py` + `osc_parity.py` | noisy-terminal divergence |
| 10 | `extension-ui` (+ shortcuts, custom renderers) | **P2** | 21 / 3 | 3 d | `scripts/ts_faux_extension.js` driver in both binaries | largest lane; wire surface wide |
| 11 | `term-integration` | **P3** | 4 / 3 | 1 d | `osc_parity.py` (OSC 0/9;4/10/11, `?2026`) | background-probe flakiness |
| 12 | `loaded-resources` | **P3** | 7 / 0 | 1 d | new `loaded_resources_parity.py` (command output diff) | none serious |
| 13 | `mermaid-diagrams` | **P3** | 2 / 0 | 1 d | markdown corpus w/ mermaid fixtures | TS renderer is approximate — parity-first |
| 14 | `autocomplete-fd` | **P3** | 2 / 4 | 1 d | new tmux `@`/`/`-completion popup diff | fd binary presence matrix |

Row totals covered: **97 MISSING + 29 PARTIAL**. The remaining MISSING mass sits in the
in-flight lanes (~110 rows), 8 unassigned onboarding/event rows (see Deferred), and ~20 Tier-2
rows deliberately deferred (below).

## Lane details

### 1. `editor-wrap-unicode` — P0, crash class — **SHIPPED** (lane branch
lane/lane/editor-wrap-unicode; wrap core landed earlier in #269, the lane
closed the remaining rows: visibleWidth/tab+base classes, stripAnsi,
normalizeTerminalOutput, Input grapheme model, marker-scan strictness,
sliceByColumn, ASCII wrap replay goldens; verifier
`scripts/editor_unicode_parity.py` — CORE session gates, cluster states are
a root-caused non-gating known gap: the box tmux 3.2a predates grapheme
joining so the per-cell ratatui diff collides with TS-only on multi-char
clusters; the model/bytes are byte-exact via pty capture — needs a
paint-backend follow-up lane).

**Why first:** `word_wrap_line` mixes grapheme-ordinal `Segment.index` with byte slicing
(`crates/pa-tui/src/editor/wrap.rs:39-47`, slice at `wrap.rs:193`), so **any non-ASCII prompt
wider than the editor panics** (`byte index is not a char boundary`) — reproduced with a temp
integration test during the audit. CJK/emoji input crashes the daily dogfood.

**Scope (one correctness pass over indexing semantics):**


| TS (file:line) | Behavior | Status |
|---|---|---|
| `utils.ts:196` | `visibleWidth` (grapheme, east-asian, RGI emoji=2, regional=2, cache) | PARTIAL |
| `utils.ts:899` | `stripAnsi` (CSI/OSC/DCS/APC/two-char strip) | PARTIAL |
| `utils.ts:313` | `normalizeTerminalOutput` (Thai/Lao AM decomposition + tab→3) | MISSING |
| `components/editor.ts:119` | `wordWrapLine` (wrap opportunities, backtrack, atomic re-wrap) | PARTIAL |
| `components/editor.ts:44` | `segmentWithMarkers` (atomic paste/image markers by valid id) | PARTIAL |
| `components/input.ts:18` | `Input` single-line model: kill ring, undo, word motion, CSI-u paste | PARTIAL |

Plus the crash rows folded in from `wrap.rs` (verified during the audit): byte-index slicing,
and the `Input` char-vs-grapheme cursor model.

**Rust landing surface:** `crates/pa-tui/src/editor/wrap.rs`, `width.rs`, `editor/`, `input.rs`,
`ansi.rs` (`stripAnsi`).

**Verifier:** a new `scripts/editor_unicode_parity.py` that scripts both binaries in tmux with a
golden Unicode corpus (CJK, emoji + ZWJ, combining marks, Thai, zero-width, wide box chars),
compares frames via the `visual_parity.py` helpers; unit tests for `visibleWidth`/wrap against
the TS `string-width`/grapheme behavior (golden expected widths). Re-run the existing editor
regression corpus to catch wrap-opportunity changes on pure ASCII (cache-prefix-stable diffs
expected in editor render output are fine; behavior must not change).

**Risk:** low-medium. Width semantics (RGI emoji = 2, regional indicators, east-asian ambiguous)
have terminal-dependent expectations — match TS exactly, don't "improve".

**Telemetry:** none user-visible-action-specific beyond the existing editor input events; no new
event required unless wrap recovery diverges (then `editor_wrap_recovery`).

### 2. `term-enhanced-keys` — P0, input fidelity

**Why this high:** bracketed paste (`?2004`) enable and the kitty keyboard protocol exist in the
Rust port (`crates/pa-tui/src/enhanced_keys.rs`), but the audit's systemic finding stands for the
remainder: without kitty-printable dedup and the full `matchesKey`/`parseKey` matrix, real
multi-line pastes and shift-modified printables don't behave like TS in common terminals.

**Scope:**


| TS (file:line) | Behavior | Status |
|---|---|---|
| `keys.ts:788` | `matchesKey`/`parseKey`: kitty CSI-u, legacy tables, modifyOtherKeys | PARTIAL |
| `keys.ts:505` | `isKeyRelease`/`isKeyRepeat` (kitty event types) | PARTIAL |
| `stdin-buffer.ts:232` | `StdinBuffer`: complete-sequence splitting (CSI/OSC/APC/DCS), timeout flush | PARTIAL |
| `stdin-buffer.ts:307` | Kitty-printable dedup (`pendingKittyPrintableCodepoint`) | MISSING |

Plus, from the systemic finding: the raw multiline paste heuristic (marker-less burst coalescing
in `input.rs`) and `drainInput` on surface switches.

**Rust landing surface:** `crates/pa-tui/src/enhanced_keys.rs`, `keys.rs`, `input.rs`.

**Verifier:** extend `scripts/bracketed_paste_parity.py` (already covers `?2004`): add a kitty
sequence matrix — send the same raw byte streams (CSI-u codes, release/repeat events, paste
chunks) to both binaries and byte-compare editor state; a tmux harness under a kitty-capable
terminal for end-to-end shift+enter/newLine and ctrl+shift+letter.

**Known divergence to resolve (flagged, see Kevin's-call list):** TS arms xterm modifyOtherKeys
mode 2 and parses `CSI 27;…` itself (`keys.ts` `parseModifyOtherKeysSequence`); the Rust port
deliberately does NOT arm it because crossterm can't parse the result (documented in
`enhanced_keys.rs`). Net effect: on non-kitty terminals, shift-modified printables stay
indistinguishable from plain keys. Options: arm it and parse raw bytes ourselves (parity), or
keep the divergence and document. Needs a decision.

**Risk:** medium. Terminal-capability matrix (kitty/foot/iTerm/legacy xterm) is where this
regresses; keep the probe/enable sequences byte-identical to TS.

**Telemetry:** `enhanced_keys_mode` (protocol detected: kitty/modifyOtherKeys/none — primitives
only) shipped with the feature.

### 3. `interrupt-paths` (incl. `signal-handlers`) — P1, abort safety

**Why this high:** the dogfood escapes constantly. Today only `Abort`/`AbortCompaction` are ever
sent; `AbortBash`/`AbortRetry`/`AbortBranchSummary` exist on the wire but are never sent from the
UI, pending tool cards never get their error result on abort, and SIGTERM/SIGHUP have no
handler. Symptoms: stuck spinner cards after Escape, detached children surviving exit.

**Scope:**


| TS (file:line) | Behavior | Status |
|---|---|---|
| `packages/coding-agent/src/modes/interactive/components/tool-execution.ts:248-274 + packages/coding-agent/src/modes/interactive/interactive-mode.ts:5913-5923` | Aborted/error assistant: every pending tool card gets the error result | MISSING |
| `interactive-mode.ts:7322` | emergencyTerminalExit (EIO/dead terminal, exit 129) | MISSING |
| `interactive-mode.ts:7339` | registerSignalHandlers (SIGTERM/SIGHUP, stdout/stderr error) | MISSING |
| `interactive-mode.ts:7332` | killTrackedDetachedChildren (detached child kill) | MISSING |

Plus the two PARTIAL escape rows: `handleEscape` (arm + interrupt-or-clear) and
`interruptOrClearInput` (abort retry/bash/compaction/branch-summary/side-question/stream).

**Rust landing surface:** `crates/pa-tui/src/session_ui.rs`, `exit_guard.rs`, `crates/pa-cli`
(signal registration), `crates/pa-daemon/src/user_bash.rs` (abort ack shapes).

**Verifier:** new `scripts/interrupt_parity.py`: drive both binaries in tmux through a scripted
turn with live bash + a side question, send ESC / double-ESC / Ctrl-C / SIGTERM / SIGHUP at
fixed delays, byte-compare frames and the wire commands emitted (log both daemon sockets);
assert no orphaned children after exit.

**Risk:** medium — the race between abort and an in-flight tool result landing is the classic
source of stuck UI; the daemon's abort ack shape must match TS before the client renders the
settled card.

**Telemetry:** `interrupt_issued` (target: bash/retry/compaction/branch-summary/side-question —
primitive enum only) and `signal_shutdown`.

### 4. `bash-mode` — P1, the `!` / `!!` bang surface

**Why:** `!cmd` bash-from-chat is a daily dogfood feature; `crates/pa-tui/src/bash_bang.rs`
exists but the live-event mount and the `/btw`-pane arm are missing.

**Scope:**


| TS (file:line) | Behavior | Status |
|---|---|---|
| `packages/coding-agent/src/modes/interactive/components/bash-execution.ts:16-205` | BashExecutionComponent (! bang runs): DynamicBorder box, $ cmd header, Running... loader, 20-line tail preview, "... N more lines", (cancelled)/(exit N)/(failed: …), truncation notice | PARTIAL |
| `packages/coding-agent/src/modes/interactive/components/custom-editor.ts:118` | getBashPromptInfo: ! / !! prompt prefix + hidden prefix length | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:4752-4782` | finishSideQuestionBash (side ! bash seeds follow-up turns) | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:5269-5315` | ! bash inside side pane (transient runId, excludeFromContext, abort guard) | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:5765-5846` | bash_start/bash_output/bash_end (BashExecutionComponent, pending while streaming, failure rows) | PARTIAL |
| `interactive-mode.ts:7881` | flushPendingBashComponents / pendingMessagesContainer (live bash above indicator) | PARTIAL |

(`bash_bang.rs` already implements the submit-path prefix; the gaps are the live
`bash_start`/`bash_output`/`bash_end` mounting above the indicator, the
BashExecutionComponent box: `$ cmd` header, `Running…` loader, 20-line tail preview,
`(cancelled)/(exit N)/(failed: …)` markers, the `!`/`!!` editor prompt prefix via
`getBashPromptInfo`, and the `!` arm inside the `/btw` side pane: transient runId,
excludeFromContext, seeds follow-up turns.)

**Rust landing surface:** `crates/pa-tui/src/bash_bang.rs`, `side_question.rs`, `session_ui.rs`,
`crates/pa-daemon/src/user_bash.rs`.

**Verifier:** `scripts/bang_parity.py` already exists and covers the bang surface — extend it
with the live-event cases (long output, truncation notice, cancel mid-run, bang inside the side
pane) and frame-diff against the TS binary.

**Risk:** low-medium. Main divergence risk: live coalescing (`bash_output` deltas) vs the replay
path that already renders; keep one card component for both, as the audit row notes.

**Telemetry:** `bash_bang_executed` (duration bucket, exit-code class — primitives only).

### 5. `edit-diffs` — P1, one diff renderer reused three ways

**Why:** the edit tool runs constantly in the dogfood; its results currently render without the
TS file-summary + diff rows, and the turn-recap is missing. Porting `renderRichDiff` once unblocks
three surfaces (audit's explicit unblocker lane).

**Scope:**


| TS (file:line) | Behavior | Status |
|---|---|---|
| `packages/coding-agent/src/modes/interactive/components/edit-summary.ts:87-115` | formatFileChangeSummaryLine: "    ╰─ <path> +N -M" (used by edit tool + ipython diffs) | MISSING |
| `packages/coding-agent/src/modes/interactive/components/edit-summary.ts:40-80` | getToolFileChanges / mergeTurnFileChanges (edit + ipython diff accounting) | MISSING |
| `packages/coding-agent/src/modes/interactive/components/edit-summary.ts:117-124` | formatTotalChangeSummary turn recap ("N files changed · +a -b" above the prompt) | MISSING |
| `packages/coding-agent/src/modes/interactive/components/ipython-cell.ts:684-729` | renderDiffs/renderFileDiff: per-path "╰─ path +N -M" summary + rich diff rows gated by editDiffsExpanded | MISSING |
| `packages/coding-agent/src/modes/interactive/components/tool-execution.ts:45-75 + core/tools/edit.ts:248-303` | edit tool dedicated renderer (file summary line + renderDiff rows, expanded detail) | MISSING |
| `packages/coding-agent/src/modes/interactive/components/diff.ts:80` | renderDiff: unified diff colors + intra-line word inverse | MISSING |
| `packages/coding-agent/src/modes/interactive/components/diff.ts:220` | renderDiffSeparator: ⋮ hunk separator row | MISSING |
| `packages/coding-agent/src/modes/interactive/components/diff.ts:228` | renderRichDiff: full-width + / - blocks, wrapped continuation rows, 256-color fallback | PARTIAL |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:5498-5502` | session_status event -> recap line + top-bar cost | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:5710-5714` | message_start user: clear shortcut guide + file changes + recap | PARTIAL |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:5985-5987` | turn_end -> mergeTurnFileChanges (file-change recap above editor) | MISSING |

**Rust landing surface:** `crates/pa-tui/src/tool_card/` (edit renderer),
`crates/pa-tui/src/chat.rs` (ipython `renderDiffs`), the turn-recap row in the prompt-context
line (`chrome.rs`/`view.rs`), plus a `diff.rs` module for `renderDiff`/`renderRichDiff`/
`renderDiffSeparator`.

**Verifier:** new `scripts/edit_diff_parity.py`: run the same edit tool call (via scripted
ipython/edit invocations) against both binaries over a golden fixture set (rename/UTF-8/empty
hunk/no-change), frame-diff the cards and the recap row; include the `editDiffsExpanded` gate in
both states.

**Risk:** low-medium. Syntax highlighting in rich diffs must not regress plain-code rendering
(shiki-parity work from #296 is the base); watch stream-time perf on large diffs (TS truncates).

**Telemetry:** `edit_diff_expanded` (toggle action) rides the feature PR.

### 6. `md-render` — P1, latex + block gaps + render polish (batched small lanes)

**Why:** formulas currently render as raw prose (often mangled by emphasis parsing) — visible
every day in a coding-agent dogfood. This lane absorbs the small section-3 polish lanes the audit
suggested batching (`render-inline`, `input-prefilter`, `render-cache`).

**Scope:**


| TS (file:line) | Behavior | Status |
|---|---|---|
| `tui.ts:1548` | Inline differential renderer on the primary screen (scrollback mode, viewport-preserving repaint, clearOnShrink) | PARTIAL |
| `tui.ts:631` | `addInputListener` prefilter chain | MISSING |
| `render-cache.ts:1` | `VersionedRenderCache` (width+version keyed) | MISSING |
| `latex.ts:829` | `latexToUnicode` (symbols, scripts, accents, frac/sqrt, alphabets) | MISSING |
| `components/markdown.ts:475` | Inline math `$...$` → `latexToUnicode` | MISSING |
| `components/markdown.ts:495` | Blockquote: nested blocks, quote style, `│ ` border, trailing blank | PARTIAL |
| `components/markdown.ts:778` | `renderMathBlock` (`$$`/`\[...\]` display math) | MISSING |
| `components/markdown.ts:556` | `renderList`: nesting depth indent, ordered start, code/math in items | PARTIAL |
| `components/markdown.ts:641` | hr (`─` × min(width,80)) | PARTIAL |
| `components/markdown.ts:566` | HTML block/inline tokens (raw passthrough) | MISSING |
| `components/markdown.ts:41` | Strict strikethrough tokenizer regex | PARTIAL |

**Rust landing surface:** `crates/pa-tui/src/markdown.rs` (tokenizers, math block, list/blockquote/hr/html rules), a new `latex.rs` (port of TS `latex.ts`), `render-cache.rs`, `tui.rs` inline-render and input-prefilter seams.

**Verifier:** a new markdown golden-corpus harness (`scripts/markdown_corpus_parity.py`): one
directory of .md fixtures (math: `$…$`, `$$…$$`, `\(…\)`, `\[…\]`, symbols/accents/frac;
nested lists, nested blockquotes, hr clamp, inline html) rendered by both binaries via a scripted
assistant turn, frame-diffed. This corpus also serves lane 13 (mermaid) and future markdown
PRs — build it once here.

**Risk:** medium. The strict-strikethrough and emphasis-vs-`$` tokenizer precedence rules are
where prose regressions creep in; the corpus is the safety net. `latexToUnicode` is a large pure
port (symbols table) — mechanical, but cache-prefix stability matters (new module, low churn).

**Telemetry:** none beyond existing markdown render events; no new action surface.

### 7. `settings-menu` — P1

**Why:** `/settings` and its submenus are the main user-config surface; `settings_menu.rs` exists
but the audit leaves 9 rows (selector, theme submenu with live preview, show-images selector,
`InteractiveModeUiServices`, runtime-apply of editor settings).

**Scope:**


| TS (file:line) | Behavior | Status |
|---|---|---|
| `packages/coding-agent/src/modes/interactive/components/settings-selector.ts:187` | settings menu (SettingsList, submenus, enableSearch) | MISSING |
| `packages/coding-agent/src/modes/interactive/components/settings-selector.ts:275` | thinking-level and theme submenus (SelectSubmenu, live theme preview) | MISSING |
| `packages/coding-agent/src/modes/interactive/components/show-images-selector.ts:19` | Yes/No list for terminal.showImages metadata | MISSING |
| `packages/coding-agent/src/modes/interactive/components/theme-selector.ts:25` | theme list with "(current)" mark + live preview on selection change | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode-services.ts:31-68` | InteractiveModeUiServices (settings/model-registry/theme services for the mode) | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:1590-1592` | footer branch-change re-render | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:2790-2805` | applyRuntimeSettings (editor padding, autocomplete max, hardware cursor, clearOnShrink) | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:4912-4921` | /settings -> showSettingsSelector | MISSING |
| `interactive-mode.ts:7910` | showSettingsSelector (/settings menu + 20+ settings callbacks) | MISSING |

**Rust landing surface:** `crates/pa-tui/src/settings_menu.rs`, `theme.rs`, `client_settings.rs`,
`menu_panel.rs`.

**Verifier:** tmux key-walk parity: open `/settings` in both binaries, walk every submenu
(thinking-level, theme with live preview, show-images), toggle items, frame-diff at each step
(extend `tui_polish_parity.py`); verify runtime settings actually apply (editor padding,
autocomplete max, hardware cursor, clearOnShrink) in the Rust binary and produce the same visible
changes as TS.

**Risk:** low. Mostly plumbing over existing menu infrastructure; the one broad bit is the
20+ settings callbacks in `showSettingsSelector`.

**Telemetry:** `settings_opened` + `settings_changed` (setting key primitive only).

### 8. `transcript-extras` (incl. `msg-card-gaps`, re-attach fidelity) — P2

**Why:** replay/attach fidelity gaps make the dogfood's `--resume` experience visibly diverge:
missing `[branch]`/`[skill]` cards, no limit-transcript banner or compaction count, no
per-message render-failure placeholder, and re-attach state (elapsed anchor, expand hints)
lost. The audit's coordination note already merges `msg-card-gaps` into this lane.

**Scope (audit rows):**


| TS (file:line) | Behavior | Status |
|---|---|---|
| `packages/coding-agent/src/modes/interactive/components/branch-summary-message.ts:10-55` | [branch] expandable box (collapsed "Branch summary" line, expanded markdown + header) | MISSING |
| `packages/coding-agent/src/modes/interactive/components/skill-invocation-message.ts:8-35` | [skill] expandable box (collapsed name line, expanded **name** + content) | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:6745-6788` | User-message special forms: legacy heartbeat prompt rows, skill-block cards | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:623-710` | initialRenderMessages (400-message render limit + orphan tool-result pairing) | MISSING |
| `interactive-mode.ts:6876` | preloadToolDefinitions failure warning row | MISSING |
| `interactive-mode.ts:6907` | limitTranscript "Showing latest N of M messages for faster open." | MISSING |
| `interactive-mode.ts:6983` | per-message "Failed to render a <role> message" placeholder | MISSING |
| `interactive-mode.ts:6899` | populateHistory (session user messages into editor history) | MISSING |
| `interactive-mode.ts:7032` | compactionCount "Session compacted N times" status | MISSING |
| `interactive-mode.ts:6550` | heartbeat legacy prompt detection (user msg -> InjectedPrompt) | MISSING |
| `interactive-mode.ts:6568` | isTextOnlyUserMessage | MISSING |
| `interactive-mode.ts:6765` | skill invocation message block (parseSkillBlock) | MISSING |
| `interactive-mode.ts:6650` | addMessageToEditorHistory | MISSING |

Plus four unassigned rows adopted here (they are the same replay/attach surface):

- `interactive-mode.ts:3284-3299` + `3401-3418` — `preloadToolDefinitions` (daemon tool-definition
  cache) — the §4 arm of the preload warning row above.
- `interactive-mode.ts:3541-3556` — `restoreTurnStartFromMessages` (elapsed anchor survives
  re-attach).
- `interactive-mode.ts:3362` — `selectLatestToolExpandHint` (expand-hint carries to newest tool).
- `interactive-mode.ts:5483-5497` — `session_resynced` event (mid-run resync without re-attach).

**Rust landing surface:** `crates/pa-tui/src/snapshot.rs`, `custom_message/`, `session_ui.rs`,
`compaction_row.rs`; `session_resynced` needs a `pa-daemon` emit point (see risk).

**Verifier:** `scripts/skill_invocation_parity.py` covers the skill-block half; extend to the
`[branch]` box and legacy heartbeat rows with a golden session jsonl replayed through both
binaries' attach path (frame-diff). For the event rows, wire-compare the TS daemon's
`session_resynced` traffic first (wire parity rule) before porting.

**Risk:** medium. `session_resynced` vs the existing `session_replaced`/`session_resumed` paths
in the Rust client can double-render if both fire; the daemon's event semantics need a spec read
against TS before any client work (this is the one wire-protocol row in the lane).

**Telemetry:** `transcript_banner_shown` (banner kind primitive) if any.

### 9. `startup-notices` (incl. `update-notices`, `terminal-progress`) — P2

**Why:** the first minute of every dogfood session shows the gap: no terminal title, no
keybinding cheat-sheet under splash, no version/package-update notices, no live theme re-render,
no auth/model-fallback warning rows.

**Scope:**


| TS (file:line) | Behavior | Status |
|---|---|---|
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:1509-1544` | verbose startup: keybinding cheat-sheet under splash / quietStartup skip | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:886-936` | InteractiveModeOptions (migratedProviders/modelFallback/startupNotice/initialPrompts/verbose/promptStash...) | PARTIAL |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:1498-1501,1580-1582` | ensureTool fd/rg + missing-ripgrep warning | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:1584-1588` | onThemeChange watcher (live re-render on theme file change) | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:1634-1642` | updateTerminalTitle (terminal window title from session name/cwd) | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:1680-1682` | startupNotice option warning | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:1684-1687` | models.json error row | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:1771-1808` | deferred startup notifications (new version + package updates + tmux notice, new-chat only) | PARTIAL |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:2994-2996` | session_info_changed -> title/topbar/cost refresh | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:5723-5724,5990,6026` | terminal setProgress (OSC 9;4) on activity | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:5747-5752` | session_info_changed -> title/topbar refresh | MISSING |
| `interactive-mode.ts:7838` | showNewVersionNotification | MISSING |
| `interactive-mode.ts:7843` | showPackageUpdateNotification | MISSING |

**Rust landing surface:** `crates/pa-tui/src/chrome.rs`, `onboarding.rs`, `session_ui.rs`;
OSC title/progress ride `term-integration` (coordinate — see lane 11).

**Verifier:** `attach_first_frame_parity.py` (first-frame diff, incl. quiet/verbose variants) +
`osc_parity.py` for title/progress bytes. For version-check notices: golden response fixtures
(no network in tests).

**Risk:** low. Update/version notifications should not hit the network in the verifier — stub
fixtures. Coordinate `updateTerminalTitle` with `term-integration`'s `setTitle` so the OSC 0
write lives in one place.

**Telemetry:** `startup_notice_shown` (notice kind primitive).

### 10. `extension-ui` (incl. `ext-shortcuts`, custom renderers) — P2, largest lane

**Why:** the single largest gap in section 4 (~24 rows): the whole extension UI surface —
widgets above/below the editor, custom footer/header, the selector/input/editor/confirm/notify/
error/custom components, and the `extension_ui_request` wire methods. The daemon-side extension
runner exists (`crates/pa-core/src/extensions/`), so this is feasible — but it is the widest wire
surface in the wave and needs a real driver to verify.

**Scope:**


| TS (file:line) | Behavior | Status |
|---|---|---|
| `packages/coding-agent/src/modes/interactive/components/custom-message.ts:52-63` | Extension customRenderer (message renderer from the extension runner) | MISSING |
| `packages/coding-agent/src/modes/interactive/components/tool-execution.ts:29-39,149-188,484-539` | Custom tool renderer definitions (renderCall/renderResult/renderShell self, labels, replayBuiltInToolName) | MISSING |
| `packages/coding-agent/src/modes/interactive/components/extension-selector.ts:36` | extension selector: title/description split, timeout countdown, j/k nav | PARTIAL |
| `packages/coding-agent/src/modes/interactive/components/extension-editor.ts:20` | extension editor panel: prefill, hints, external $EDITOR flow | PARTIAL |
| `packages/coding-agent/src/modes/interactive/components/extension-input.ts:16` | extension text input with timeout countdown title | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode-services.ts:70-116` | InteractiveModeLocalSessionHost + extension binding glue | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:2710-2788` | bindCurrentSessionExtensions (UI context + command-context actions + shutdown handler) | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:3420-3466` | setupExtensionShortcuts + editor onExtensionShortcut dispatch | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:3468-3471` | setExtensionStatus (footer status slots) | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:3732-3782` | extension widgets above/below editor (10-line cap, placement, dispose) | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:3829-3871` | renderWidgets/renderWidgetContainer | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:3873-3935` | setExtensionFooter / setExtensionHeader (custom chrome swap) | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:3937-3953` | extension terminal-input listeners | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:3955-4010` | createExtensionUIContext (select/confirm/input/notify/editor/widget/theme/editorText hooks) | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:4012-4157` | extension selector/input/editor components (timeout, abort signal, focus restore) | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:4255-4263` | showExtensionNotify (info/warning/error tones) | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:4265-4342` | showExtensionCustom (overlay or inline custom component, done callback) | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:4347-4363` | showExtensionError (chat row + dim stack trace) | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:5526-5699` | connection extension_ui_request wire methods (select/confirm/input/editor/notify/setStatus/setWorkingMessage/setWorkingVisible/setWorkingIndicator/setHiddenThinkingLabel/setWidget/setTitle/setEditorText) | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:5573-5586` | cancelActiveConnectionExtensionUiRequests (respond cancelled on reset) | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:3372-3399` | createToolExecutionDefinition (connection + local renderer merge) | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:3708-3720` | setWorkingVisible | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:3722-3726` | setWorkingIndicator (custom frames/interval) | MISSING |
| `interactive-mode.ts:10460` | getHotkeysGuide (full reference tables) | PARTIAL |

**Rust landing surface:** `crates/pa-tui/src/app.rs` (widget/header/footer swap), a new
`extension_ui.rs` component family, `crates/pa-types/src/daemon/command.rs` (wire methods already
partially typed — `extension_ui_request/response`), `crates/pa-core/src/extensions/` bindings.

**Verifier:** `scripts/ts_faux_extension.js` already exists as a TS-side faux extension driver —
run it against both binaries and frame-diff every UI method (select/confirm/input/editor/notify/
custom/status/working indicators/title/editorText). Wire-parity first: byte-compare the TS
daemon's `extension_ui_request` traffic (repo merge gate for protocol changes), then render
parity. Interactive behavior: same keys abort the same dialogs.

**Risk:** high. 14 wire methods + 8 component types + focus restore + timeout/abort semantics;
recommend splitting the lane PR into (a) wire methods + select/confirm/notify, (b) widgets +
custom chrome, (c) custom renderers — one lane, three PRs. Do NOT start before lane 1 lands
(non-ASCII extension strings go straight through the editor).

**Telemetry:** `extension_ui_used` (method primitive).

### 11. `term-integration` — P3

**Scope:**


| TS (file:line) | Behavior | Status |
|---|---|---|
| `tui.ts:327` | `PI_HARDWARE_CURSOR` opt-in gate for hardware cursor | PARTIAL |
| `fullscreen.ts:658` | `paint`: absolute row-diff, `\x1b[2K` per row, cursor address, ?2026 sync | PARTIAL |
| `terminal.ts:130` | `setTitle` (OSC 0) | MISSING |
| `terminal.ts:126` | `setProgress` (OSC 9;4 + 1s keepalive) | MISSING |
| `terminal.ts:173` | Default-color probe (OSC 10/11 query + response parse) | MISSING |
| `terminal-colors.ts:193` | `getTerminalBackgroundKind` (probed colors + `COLORFGBG`) | MISSING |
| `terminal-colors.ts:138` | `bestAnsiColor` / color-mode gating | PARTIAL |

**Rust landing surface:** a `crates/pa-tui/src/terminal.rs` seam (title/progress/background-probe
writes) consumed by `theme.rs` (background kind → theme contrast) and lane 9.

**Verifier:** `osc_parity.py` extended with OSC 0 / 9;4 / 10/11 probe sequences and the `?2026`
sync byte order; a dark/light-terminal matrix for the background probe (COLORFGBG fallback).

**Risk:** medium — the OSC 10/11 background probe depends on terminal answers and has no
answer from many terminals (TS falls back to COLORFGBG; keep the same fallback ladder and the
same 1s keepalive for OSC 9;4 progress or it lingers in some terminals — see Kevin's-call list).

**Telemetry:** none (no user action).

### 12. `loaded-resources` — P3, cheap and self-contained

**Scope:**


| TS (file:line) | Behavior | Status |
|---|---|---|
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:2101-2171` | formatDisplayPath/formatExtensionDisplayPath/getShortPath helpers | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:2173-2272` | compact extension labels (npm/git source labels, unique suffix) | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:2274-2315` | getDisplaySourceInfo/getScopeGroup/isPackageSource | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:2317-2386` | buildScopeGroups/formatScopeGroups (user/project/path listing) | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:2388-2475` | findSourceInfoForPath/formatPathWithSource/formatDiagnostics (collision ✓/✗ groups) | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:2477-2705` | showLoadedResources ([Context]/[Skills]/[Prompts]/[Extensions]/[Themes] + diagnostics sections) | MISSING |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts:1379-1393` | built-in command conflict diagnostics | MISSING |

**Rust landing surface:** `crates/pa-tui/src/tree_display.rs`/`config_selector.rs`-adjacent new
module for the path/source-labeling helpers + `showLoadedResources` panel.

**Verifier:** new `scripts/loaded_resources_parity.py`: same resource tree on both binaries
(fixture dirs: npm/git/user/project sources, colliding names), command-output diff + the
collision ✓/✗ diagnostics diff.

**Risk:** low. Pure display logic over the existing resource-resolution code in `pa-core`.

**Telemetry:** `loaded_resources_opened`.

### 13. `mermaid-diagrams` — P3

**Scope:**


| TS (file:line) | Behavior | Status |
|---|---|---|
| `packages/coding-agent/src/modes/interactive/components/assistant-message.ts:24,268-283` | Mermaid code blocks replaced with unicode diagrams while streaming/final | MISSING |
| `packages/coding-agent/src/modes/interactive/components/mermaid.ts:52` | mermaid code blocks rendered as Unicode diagrams (off/final/streaming) | MISSING |

**Rust landing surface:** new `crates/pa-tui/src/mermaid.rs` (port of TS `mermaid.ts`), hooked
into `chat.rs` block rendering (streaming + final).

**Verifier:** the markdown corpus from lane 6 with mermaid fixtures (flowchart/sequence/state)
rendered by both binaries, frame-diffed in off/final/streaming modes.

**Risk:** low-medium. TS's unicode-diagram rendering is approximate (see Kevin's-call list —
parity-first, match TS output even where a "better" layout exists).

**Telemetry:** none (rendering only).

### 14. `autocomplete-fd` — P3

**Scope:**


| TS (file:line) | Behavior | Status |
|---|---|---|
| `autocomplete.ts:124` | fd-backed fuzzy `@`-file search (`walkDirectoryWithFd`, scoring) | MISSING |
| `autocomplete.ts:238` | Slash-command argument completions (`getArgumentCompletions`) | MISSING |
| `components/editor.ts:2389` | Autocomplete trigger matrix (/, @, #, word chars, refresh-after-edit cancel rules) | PARTIAL |
| `components/editor.ts:2205` | Async suggestion request (AbortController, 20ms symbol debounce, staleness checks) | PARTIAL |
| `components/select-list.ts:189` | Metadata item: argumentHint + sourceTag columns | PARTIAL |
| `components/select-list.ts:60` | `setFilter` (prefix filter, reset selection) | PARTIAL |

**Rust landing surface:** `crates/pa-tui/src/autocomplete.rs` (fd-backed `@` search,
`getArgumentCompletions` dispatch, sourceTag columns).

**Verifier:** tmux harness typing `@` and `/cmd <arg>` prefixes in both binaries over a fixture
repo, popup frame-diff; the argument-completion dispatch is best verified with the existing
`command_dispatch_parity.py` pattern.

**Risk:** low. fd binary absence must degrade exactly like TS (plain walk fallback).
**Telemetry:** `autocomplete_source` (fd/walk — primitive).

## Questionable TS behavior — Kevin's call, do not port blindly

Per the brief: parity beats taste, but these are flagged rather than silently ported:

1. **xterm modifyOtherKeys arming** (lane 2): TS arms mode 2 and hand-parses `CSI 27;…`; the
   Rust port's deliberate divergence exists because crossterm can't parse it. Deciding factor:
   do we want byte-level parity (arm + parse raw) or keep the cleaner kitty-only path and document
   the divergence? **Needs a call before lane 2 starts.**
2. **`normalizeTerminalOutput` tab→3 and Thai/Lao AM decomposition** (lane 1): hardcoded tab
   width 3 and script-specific decomposition are TS heuristics, not terminal standards. Port
   them as-is (parity), but they are candidates for a later joint divergence fix.
3. **400-message `initialRenderMessages` cap** (lane 8): a TS perf workaround with orphan
   tool-result pairing heuristics. Port as-is; a joint divergence (configurable cap) could be
   proposed after the wave.
4. **OSC 9;4 progress keepalive** (lane 9/11): some terminals keep the progress spinner visible
   after the session ends if the final `0` write is missed; TS rewrites it every 1s. Match TS
   but verify teardown writes the reset.
5. **`session_resynced` vs `session_replaced`** (lane 8): two overlapping resync events on the
   wire; the Rust client already handles `session_replaced`. Wire-compare the TS daemon first;
   if TS's `session_resynced` is redundant for our daemon's semantics, flag for a divergence
   note rather than double-rendering.
6. **Easter eggs (deferred tier)**: `armin`, `demented delves`, `daxnuts` (triggers on a specific
   vendor model), and the "pi has joined Earendil" announcement — internal jokes and
   brand-wrong ("pi"). Recommend NOT porting until Kevin explicitly wants them; if ported, the
   Earendil announcement must be rebranded.
7. **`/nightly`, in-place `tryExecUpdateRelaunch`**: owned by the in-flight
   `utility-commands` lane, but worth restating: the TS execve self-replacement is the riskiest
   command in the surface; the lane should keep the Rust relaunch helper rather than literal
   execve port.

## Deferred (not this wave) — with reasons

- **`provider-auth-ui`** (3 rows: oauth-selector, login-dialog, prime-team-selector): the UI
  components overlap the in-flight `clip-auth-cmds` lane (auth-flows.ts is entirely theirs).
  Sequence it the moment `clip-auth-cmds` merges — the selector/dialog components are the
  natural follow-up PR.
- **`scoped-models`** (2 rows): must coordinate with in-flight `model-fix`; also owns the Alt+M
  cycling. Defer until `model-fix` merges.
- **`kitty-image-lifecycle`** (3 rows), **`tui-debug-tools`** (3), **`resume-selector`**,
  **`queue-images`**, **`tray-followup-hint`**, **`tree-summary-loader`**,
  **`shell-completion-attach`**, **`editor-chrome`**: Tier-2 polish; none are dogfood-blockers.
  Batch as one or two "tui-polish-2" lanes after the wave.
- **`easter-eggs`** (7 rows): see questionable-behavior #6.
- **Unassigned onboarding rows** (3: `prime-onboarding-splash.ts` panels, `onboarding-picker.ts`):
  coordinate with the in-flight `clip-auth-cmds` onboarding branch before assigning.

## Sequencing and parallelism

- Lanes 1–3 (crash, input, abort) are **the first three to spawn**; they are independent of all
  in-flight lanes and unblock everything touching the editor/session loop. They can run in
  parallel.
- Lane 4 (`bash-mode`) shares `session_ui.rs` with lane 3 — land 3 first, or coordinate the two
  to avoid churn in the same file.
- Lane 6 builds the markdown golden corpus that lane 13 reuses — schedule 13 after 6 (or fold 13
  into 6 if one worker takes both).
- Lane 9 and lane 11 share the OSC write seams — one owner for the `terminal.rs` seam, the other
  lane consumes it.
- Lane 10 (extension-ui) is three PRs; start after lane 1 to inherit the unicode fixes.
- Merge gates per AGENTS.md apply to every lane PR: fmt/clippy/test + the parity-diff evidence
  section + telemetry event + ownership statement.

## Top-3 recommended first lanes

1. **`editor-wrap-unicode`** — P0 crash class: any CJK/emoji prompt wider than the editor panics
   the dogfood binary today. Small (~1 day), fully verifiable with a Unicode corpus, and every
   other lane benefits from a correct width/index model. Nothing about it needs coordination.
2. **`term-enhanced-keys`** — P0 input fidelity: real-terminal pastes and shift-modified keys
   don't behave like TS until the kitty-printable dedup + paste heuristic land. Cheap verifier
   (the bracketed-paste harness already exists). One decision needed first: modifyOtherKeys
   (Kevin's-call #1).
3. **`interrupt-paths`** — P1 abort safety: Escape/Ctrl-C don't reach `AbortBash`/`AbortRetry`/
   `AbortBranchSummary`, pending tool cards hang on abort, and SIGTERM/SIGHUP leak children.
   Kevin escapes mid-turn daily; this removes a whole stuck-state class plus the
   `signal-handlers` shutdown net (3 rows folded in).

Next in line: `bash-mode` (its verifier, `bang_parity.py`, already exists), then `edit-diffs`
(the audit's explicit unblocker lane).

---

*Source: FEATURE_PARITY.md at main `64f66e3d` (689 rows; 254 MISSING / 128 PARTIAL), the
consolidated lane-grouping proposal, and a row-level re-walk of the MISSING tables. This doc
cites 97 MISSING + 29 PARTIAL rows into 14 lanes; ~110 MISSING rows remain owned by the 13
in-flight lanes and are out of scope here.*
