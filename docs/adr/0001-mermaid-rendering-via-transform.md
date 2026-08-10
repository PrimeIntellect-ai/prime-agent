# ADR-0001: Mermaid rendering via Markdown transform callback

Status: Proposed

## Context

We need to render Mermaid diagrams as Unicode box-drawing art inline in chat
messages during streaming. The upstream pi project (v0.84.1) solved this with
a `MarkdownOptions.transform` callback on the TUI `Markdown` component — a
pre-processing step that replaces mermaid code blocks with styled art before
marked parses the markdown.

Two approaches were considered:

1. **Transform callback** (pi's approach): Add `transform?: (md, width) => string`
   to `MarkdownOptions`. The coding-agent creates a mermaid transformer that
   lexes markdown, finds mermaid code blocks, renders them via grok-mermaid,
   and returns modified markdown with diagram rows wrapped in inline code spans.

2. **renderCodeBlock modification**: Add a `renderMermaid?(src, width)` callback
   to `MarkdownTheme`. The TUI's `renderCodeBlock` method calls it when
   `token.lang === "mermaid"`, returning styled lines instead of the default
   code block rendering.

## Decision

Adopt approach 1: **transform callback**.

## Rationale

- **Upstream alignment**: pi v0.84.1 already uses this approach. Matching it
  simplifies future upgrades and keeps the mental model consistent.

- **Robustness**: Transform operates on raw markdown before parsing. It does
  not depend on internal `renderCodeBlock` mechanics, per-block caching, or
  token processing details. Changes to TUI rendering internals do not affect it.

- **Minimal coupling**: The TUI gains one optional interface field and one
  optional constructor parameter. The coding-agent owns all mermaid-specific
  logic (grok-mermaid dependency, color mapping, mode handling, fallback).

- **Simplicity**: `renderCodeBlock` approach would need width threading
  (currently not passed to it), theme coupling for a rendering concern, and
  coordination with the per-block cache. Transform avoids all three.

## Consequences

- The `Markdown` constructor gains a 6th optional parameter. All existing
  call sites (50+) remain backward compatible.

- `Markdown.render()` applies `transform(this.text, contentWidth)` before
  parsing. If transform returns the same text, behavior is identical to today.

- Only 4 of 15 `new Markdown()` src call sites pass a transform (assistant
  text blocks, user messages). Thinking blocks and static content (changelog,
  hotkeys) do not.

- Mermaid rendering happens at the markdown-source level, not the token level.
  This means grok-mermaid's `render()` is called during transform, and the
  result is re-parsed by marked. The double-parse cost is negligible because
  the transformed mermaid blocks are simple inline code spans.
