# First-run onboarding + Prime login: frame-by-frame parity report (r3)

Scope: the Rust first-run flow (`crates/pa-tui`: `onboarding.rs`,
`onboarding_flow.rs`, `onboarding_choice.rs`, `auth_panel.rs`,
`interactive.rs`'s onboarding phase; `crates/pa-cli`:
`prime_inference_login.rs`) vs the TS surface
(`packages/coding-agent/src/modes/interactive`:
`prime-onboarding-splash.ts`, `onboarding-picker.ts`,
`onboarding-choice.ts`, `components/login-dialog.ts`,
`components/menu-panel.ts`, `auth-flows.ts`,
`interactive-mode.ts`'s onboarding phase). Base: `ec99d9452` (the
org/rust tip at the time of writing; `acabfc57` named by the mission
plus `cc48dfce9` and `ec99d9452`, neither touching the onboarding
frames). No TS files were modified.

Both sides were diffed source-level (no JS runtime and no host cargo on
the machine: the frames are reconstructed from the TS component renders
and the Rust render code); the corrections are pinned by cargo tests
(byte-level row pins in `auth_panel.rs`, `onboarding.rs`,
`provider_auth.rs`) and the live A/B harness
`scripts/battery/framediff_prime_login.py` (runs wherever both binaries
exist; the mock Prime API drives the full flow).

## The frame list (TS `runOnboardingFlow`)

1. **W — welcome.** blank, 7 animated mark rows, blank, `Welcome to
   PRIME Agent` (text/bold/italic, 1 column in), blank, two muted
   paragraphs (wrap 56), blank, `> Log in with Prime Intellect` (bold
   text on the selection wash, band 34).
2. **L0 — the login dialog mounts.** the splash keeps the mark band and
   swaps the heading for `Login with Prime Intellect` (bold). TS
   `loginDialogOptions()` onboarding: `topRule: false, hideTitle: true`
   — the panel carries NO rule, NO title; an empty dialog renders zero
   rows.
3. **L1 — the browser challenge URL block.** `showAuth` (TS
   `startContent`): blank, the URL (TEXT colour, OSC 8-linked), blank,
   instructions — default `Complete the sign-in in your browser.`
   (MUTED), provider text (TEXT), or `Code: <code>` → blank, muted
   `Verification code`, bold code — then the auth-actions row
   (`getAuthActionsText`: `C copy  Esc/Ctrl+C cancel`).
4. **L2 — the armed paste prompt.** `armManualInput`/`showManualInput`:
   blank, muted `Complete the sign-in in your browser, or paste an API
   key below:`, the plain `> Paste value` field (ONE row, no rules),
   blank, the actions row `Enter submit  Alt+C copy  Esc/Ctrl+C cancel`.
   `showPrompt` prompts (`Enter API key:`) render TEXT instead of muted
   and share the same field/actions grammar.
5. **L3 — progress.** onboarding drops the `onProgress` callback's step
   chatter entirely ("Onboarding narrates itself; step chatter stays in
   the chat flows"); the browser-fallback's direct line
   (`Browser sign-in unavailable (...)`) renders. The first progress on
   an empty panel renders `Preparing authentication` (TEXT) above the
   muted line.
6. **L4 — the team question.** TS `showPrimeTeamSelector`'s onboarding
   arm mounts the **OnboardingChoiceComponent** (NOT the `/login`
   team picker): the heading reverts to the brand line, prompt `Which
   account should Prime Agent use?`, rows `Personal account` then the
   teams with their slugs as the dim `@slug` identifiers, seeded on the
   stored team.
7. **M — default-model apply.** silent on success; the failure rows land
   in the transcript behind the overlay (visible only after dismissal).
8. **P — the connect-more picker.** brand line + `Connect other
   providers, or continue.`, the caret-on-placeholder `Search providers`
   field, `Continue` pinned row, provider rows (muted, `✓` on connected,
   bold wash on selection), `N more below`/`top of list`, dim `You can
   add providers anytime with /login.`
9. **T — the trace question.** brand line + the choice panel: prompt
   `Share agent traces with Prime Intellect?`, muted description, `Share`
   / `Not now`, dim `You can change this anytime with /traces.`
10. **G — the marker gate.** only a completed flow with a model-ready
    home sets the onboarding-shown marker (no frame of its own).

## Divergences found (Rust at `ec99d9452` vs the TS frames)

### W, P, T — already at parity
`OnboardingScreen::render`, the welcome rows/action band, the picker
(prompt, field, continue row, connected `✓`, scroll hints, note) and the
choice panel (prompt/description/note copy, row widths, wash) are careful
TS ports; no divergent cells were found.

### L0/L1/L2 — the login dialog frame (the operator's "looks nothing
like TS" report)
| # | TS | Rust (before) | Fix |
|---|----|---------------|-----|
| 1 | no rule/title on onboarding (`topRule: false, hideTitle: true`) | always a `border` rule + raw 2-space `Login to Prime Inference` title + leading blank + bottom rule | `AuthPanel` gains `PanelSurface` (`onboarding()` mounts chrome-less); the bottom rule is gone on BOTH surfaces (TS `MenuPanel` inline has none) |
| 2 | content rows indent ONE space (panel ` ` prefix) | 2-space indent | the content rows render `" {text}"` |
| 3 | URL in TEXT colour | ACCENT | text |
| 4 | default browser line MUTED (`addMutedText`) | always TEXT | muted; provider instructions stay TEXT |
| 5 | `Code:`/`Enter code:` instructions render the `Verification code` block (blank, muted label, bold code) | the raw line | the code arm renders |
| 6 | the auth-actions row `getAuthActionsText`: dim key + muted action, two-space joins: `C copy  Esc/Ctrl+C cancel` / `Enter submit  Alt+C copy  Esc/Ctrl+C cancel`; copy sets `Copied sign-in link` (success) / `Failed to copy sign-in link` (error), the hint turning to `retry` | a dim `enter submit  escape cancel` hint only under the paste field; no copy hint, no copy action at all | `auth_actions_row` mirrors TS (live keybindings, the text-entry filter for the plain keys while the field is visible) and `c`/`alt+c` copies the mounted URL through `clipboard.rs` (OSC 52 included) |
| 7 | the paste field is the plain `> Paste value` row (one line, no rules) | a bordered field (rule/field/rule) | the plain `login_field_row` (the masked arm renders the prompt-less plain field the TS token paste panel uses) |
| 8 | a blank rides between the field and the actions (`inputSpacer`) | none | added |
| 9 | `showAuth` clears the progress block (`startContent`) | progress lines stayed above the URL | cleared |
| 10 | `showPrompt`'s prompt renders TEXT (`addSectionTitle`), `showManualInput`'s renders MUTED | every prompt muted | `PastePromptTone { Muted, Text }` on the request; the API-key prompt, the MCP token label and the codex `onPrompt` use Text, the browser-arm prompts Muted |

### L3 — progress chatter
Rust rendered the login flow's progress lines on the onboarding block.
TS drops the `onProgress` callback's lines there and keeps only the
direct fallback line. `AuthPanelRequest::Progress` now carries
`chatter` (`AuthPanelHandle::progress` vs `progress_line`); the
onboarding fold drops chatter, `prime_inference_login.rs`'s fallback arm
uses the direct line (the `Checking…`/`Loading teams…` lines stay
chatter — TS guards them with `isOnboarding()` too). The section title
`Preparing authentication` renders TEXT (it was muted), and only when
the panel was still empty.

### L4 — the team question (the largest divergence)
The Rust flow folded the `SelectTeam` request into the auth panel's
MenuPanel-style team picker (rule, `Select a Prime Team:`, bordered
search field, menu rows, nav hint, bottom rule) and kept the
`Login with Prime Intellect` heading. TS onboarding mounts the
**choice question**: the brand line returns (no heading), the prompt
`Which account should Prime Agent use?`, `Personal account` + the teams
(slug as the dim `@detail`), seeded on the stored team, Enter answering
the flow's request. Fixed: the onboarding fold mounts
`OnboardingPanel::TeamQuestion` (the `/login` surface keeps the
`PrimeTeamSelectorComponent` frame — its own panel, no nav hint row, no
bottom rule now).

### The /login surfaces (the operator addendum)
* The "Connect with a subscription or API key." header: **TS renders
  it** (`OAuthSelectorComponent`: MenuPanel title `Providers` + that
  subtitle, muted, 1-space); the Rust `/login` list dropped it per the
  standing operator directive (#2774, 2026-09-25: the search bar is the
  frame's first row) and a test pins its absence. It is NOT Rust-only
  chrome; no change was made — this stays a documented,
  operator-directed divergence with the TS baseline cited here.
* The `/login` API-key prompt frame (the selector's `Mode::Prompt`)
  diverged the same way the login dialog did: raw `Sign In` title, a
  combined `Enter API key: {value}` row, no field, no actions row,
  `enter submit  escape back` hint, a bottom rule. It now renders the TS
  `showApiKeyLoginDialog` frame: borderMuted rule, muted
  ` Login to {provider}` title, blank, TEXT `Enter API key:`, the plain
  `> Paste value` field, blank, the auth-actions row (no bottom rule).
* The session-surface login dialogs (prime, codex, MCP, traces) render
  the same corrected frame (rule borderMuted, muted 1-space title,
  1-space content, no bottom rule) — TS `loginDialogOptions`'
  non-onboarding shape.

### Deliberate divergences kept (documented, not fixed)
* **The connect-more API-key prompt masks the typed key** (bullets,
  and the field reads the token panel's `Paste token` placeholder where
  TS shows `Paste value` — the masked arm is the token-panel treatment).
  TS renders the typed key (`showPrompt` over the plain `Input`). The
  port's #2770 decision: "a first-run screen is exactly the shared and
  recorded surface a secret must never render on." The frame matches TS
  everywhere else (prompt tone TEXT, the plain field shape, the
  actions row). Flipping this back needs the operator's call.
* **The unavailable-row annotation** (`{provider} · not available`,
  inert Enter): the onboarding picker states a dead-end row before
  selection instead of running a flow this build does not carry. TS has
  no such concept (its `getLoginProviderOptions` only lists flows it
  can run). A Rust-side affordance for unported flows; documented here.
* **The one-frame dialog re-show after the team answer**: TS pops the
  choice back onto the login dialog for a render tick before
  `closeDialog()`; the Rust pane keeps the question until the flow
  settles. No render separates the two in TS (the close is
  synchronous), so the visible frames match.
* **The `e.g. {placeholder}` row** (`showPrompt`'s optional muted
  `e.g., …` line): the Rust `on_prompt` paths fold the placeholder into
  the prompt string. None of the onboarding frames carry a placeholder;
  the codex/MCP prompt surfaces would need a placeholder field to match
  TS exactly (follow-up).

## Verification
* `auth_panel.rs`: `the_session_chrome_is_the_ts_inline_panel`,
  `the_onboarding_panel_is_chrome_less`,
  `the_url_block_renders_the_ts_instruction_frames`,
  `the_paste_prompt_submits_the_typed_value` (the plain field + the
  actions row), `the_copy_binding_copies_the_mounted_url_into_the_actions_row`,
  the notice now masked-only (`an_empty_paste_submit_shows_the_notice_only_on_the_token_panel`),
  plus the updated pins (progress title, URL block replacement, teams).
* `onboarding.rs`: `the_onboarding_fold_drops_step_chatter_keeps_direct_lines`,
  `the_team_selection_mounts_the_onboarding_choice_question` (the brand
  line, the prompt, the seeded team, the oneshot answer).
* `provider_auth.rs`:
  `the_api_key_prompt_renders_the_ts_login_dialog_frame` (the operator
  addendum pin).
* `scripts/battery/framediff_prime_login.py`: the live A/B harness
  (mock Prime API: pending challenge, permitted whoami, two teams)
  diffing welcome → url-block → team-question → picker → trace-question
  against the TS binary, `framediff_first_run.py`'s grammar.
