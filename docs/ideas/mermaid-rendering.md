# Mermaid Rendering — Inline Unicode Diagrams

## Problem Statement
Render Mermaid diagrams as Unicode box-drawing art inline in the chat,
during streaming, without modifying agent behavior.

## Architecture Decision

**Transform approach** (matching upstream pi v0.84.1): pre-process raw
markdown before parsing, replacing mermaid code blocks with styled Unicode
diagrams via a `MarkdownOptions.transform` callback on the TUI `Markdown`
component.

Not the 8-layer pipeline from the original idea. No Extension API changes.
No markdown-transform composer. One transformer function passed directly.

### Scope — 4 files modified, 1 new, 2 packages

**packages/tui/src/components/markdown.ts**
- Add `MarkdownOptions` interface: `{ transform?: (md: string, availableWidth: number) => string }`
- Add 6th optional constructor parameter `options?: MarkdownOptions`
- In `render()`: `const text = this.options.transform?.(this.text, contentWidth) ?? this.text;`
- Backward compatible — all existing 50+ call sites unchanged

**packages/coding-agent/src/modes/interactive/components/mermaid.ts** (new)
- `createMermaidMarkdownTransformer({ getMode, theme }): (md, width) => string`
- Lex markdown → find `token.type === "code"` with `lang === "mermaid"` →
  `render()` from grok-mermaid → replace block with styled Unicode art
- Each diagram row wrapped in `codeSpan()` for whitespace preservation
- Modes: `off` → passthrough, `streaming` → always render (grok-mermaid
  handles partial diagrams natively via retry-without-last-line)
- Color mapping: iterate `art.styled`, map each `Span.cls` to `theme.fg()`:
  - `border` → `dim`
  - `text` → default (no explicit color)
  - `edge` → `accent`
  - `edgeLabel` → `accent`
  - `title` → `dim` + `bold`
  - `none` → no styling
- Fallback: `render(src)` returns `null` or `art.width > contentWidth` →
  leave original code block untouched (raw mermaid source via `token.raw`)

**packages/coding-agent/src/modes/interactive/components/assistant-message.ts**
- Add `markdownTransform?` to `AssistantMessageComponentOptions`
- In `rebuild()` line 216: pass `{ transform: this.markdownTransform }`
  to text block Markdown
- NOT in thinking blocks (line 237) — thinking is draft, mermaid is noise

**packages/coding-agent/src/modes/interactive/components/user-message.ts**
- Add `markdownTransform?` param to both constructors
- Pass `{ transform }` to Markdown at lines 31 and 72

**packages/coding-agent/src/modes/interactive/interactive-mode.ts**
- Create `mermaidMarkdownTransformer` field:
  `createMermaidMarkdownTransformer({ getMode: () => settingsManager.getMermaidRenderingMode(), theme })`
- Pass to AssistantMessageComponent and UserMessageComponent constructors
- Handle `onMermaidRenderingModeChange` → invalidate + re-render

**packages/coding-agent/src/core/settings-manager.ts**
- Add `mermaid?: MermaidRenderingMode` to `MarkdownSettings`
  (`type MermaidRenderingMode = "off" | "streaming"`)
- Add `getMermaidRenderingMode()` / `setMermaidRenderingMode()`
- Default: `"streaming"`

**packages/coding-agent/src/modes/interactive/components/settings-selector.ts**
- Add `mermaidRenderingMode` to `SettingsConfig`
- Add `onMermaidRenderingModeChange` to `SettingsCallbacks`
- Toggle: "Mermaid diagrams" with values `off | streaming`

**packages/coding-agent/package.json**
- `"grok-mermaid": "0.2.2"` — install with `--min-release-age=0` override

**packages/coding-agent/CHANGELOG.md** + **packages/tui/CHANGELOG.md**
- Add entry under `[Unreleased]`

## Settled Design Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D1 | Architecture | Transform approach (pi backport) | Matches upstream; pre-processing is robust against TUI internals |
| D2 | Dependency age | Override `--min-release-age=0` | grok-mermaid 0.2.2 published 6 days ago; user-approved override |
| D3 | Package owner | coding-agent owns grok-mermaid | TUI stays generic; theme + mode + fallback all in one place |
| D4 | Modes | `off` / `streaming` (default: streaming) | `final` dropped — prime-agent's incremental reconcile + per-block cache makes streaming→complete cache invalidation expensive; grok-mermaid handles partial diagrams natively |
| D5 | Fallback | Plain code block | `render()===null` or `art.width > contentWidth` → leave `token.raw` unchanged |
| D6 | Color mapping | Span→theme (not `toAnsi`) | Raw ANSI in pi pipeline would break; `theme.fg()` integration is native |
| D7 | Settings location | `MarkdownSettings.mermaid` | Mermaid is markdown rendering; no separate interface |
| D8 | Coverage | assistant text + user messages | NOT thinking blocks, NOT static content |
| D9 | Composer | None | Single transformer passed directly as `(md, width) => string` |
| D10 | isStreaming in render path | Not needed | No `final` mode → grok-mermaid partial rendering suffices |

## Why Not `final` Mode

Upstream pi supports `off | final | streaming`. We implement `off | streaming`.

Pi's `AssistantMessageComponent.updateContent()` does a **full rebuild** on
every call — `contentContainer.clear()` + new Markdown components. The
`isStreaming` flag is baked into a fresh transform closure each time. When
`message_end` fires with `isStreaming=false`, new components get empty caches,
and the transform renders mermaid art on the first `render()`.

Prime-agent's `AssistantMessageComponent` uses **incremental reconcile**:
`computeSignature()` → `setText()` only on changed blocks → per-block render
cache. When `message_end` fires, the signature doesn't change (same content
structure), so `setText()` is never called, and the cached result (without
mermaid art) is returned. Implementing `final` mode would require:
invalidating all `blockMarkdowns` on streaming state change, propagating
`isStreaming` through the component tree, and forcing rebuilds. That's
~15-20 lines of plumbing for a mode whose primary benefit (avoiding partial
flicker) is already handled by grok-mermaid's retry-without-last-line.

## Not Doing
- Extension API `registerMarkdownTransformer` — no second consumer; YAGNI
- `outputPad` / `preserveOrderedListMarkers` / `preserveBackslashEscapes` —
  unrelated pi features
- `toAnsi()` — raw ANSI conflicts with pi rendering pipeline
- Mermaid in thinking blocks — draft content, visual noise
- Theme spans in `custom-message.ts` — mermaid.ts uses `theme.fg()` directly
