# Notion (desktop app)

## The block model

- A page is a list of blocks; each block is one AX element. Typing lands in
  the focused block, and `get_ax_state` shows each block's text.
- `Return` ends a block and starts a new one — some block types (code) insert
  a line instead. Re-observe after every Return; block boundaries shift.
- Markdown-style prefixes typed at a block start (`-`, `1.`, `>`) convert the
  block, and `/` opens the insert menu. Expect immediate role changes and
  re-observe.

## Placeholder text is not content

- Empty blocks and new pages show placeholder text. It is interface chrome:
  do not select or delete it. Click into the block and start typing (or
  `set_value`); the placeholder disappears on its own.

## Multiline and structured input

- For long or structured content prefer `set_value`: it writes the whole
  block in one action. `paste(text, format="md")` pastes the markdown
  source as plain text — only `format="html"` writes rich data — and the
  clipboard is restored afterwards when it still holds the payload.
- `set_value` on a text block writes its content directly; prefer it over
  typing when the text is long or contains newlines.

## Selection semantics

- `select_text(element_index, text)` highlights an exact run inside one
  block; pass `prefix` and `suffix` when the same words appear twice.
- `press_key("cmd+a")` expands the selection in steps — block text, then
  more of the page. Each press changes what the next keystroke hits.

## Safety

Notion holds the user's notes and shared workspaces: deletions and shares
are mode-2 actions; moving or renaming pages the user explicitly named is
mode-3 ([safety.md](../safety.md)).
