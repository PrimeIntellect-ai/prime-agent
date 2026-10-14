# Slack (desktop app)

## Compose without sending

- Fill the message box with `set_value(element_index, text)`: it writes the
  draft and never sends. Multiline text is safe this way — newlines become
  draft lines, not Return presses.
- `type_text` is the hazard: a newline presses Return, and in the composer
  Return sends the message. Never type multiline content directly.
- To send on purpose: `set_value` the draft, then `press_key("Return")` or
  click the send button. Sending is a mode-2 action — confirm first
  ([safety.md](../safety.md)).
- The composer shows a hint line about which chord adds a newline; read it in
  the AX state before any Return press to learn what Return will do here.

## Formatting and editing

- After `set_value`, `press_key("cmd+shift+f")` re-applies Slack's markdown
  formatting to the draft when the user wants rich formatting.
- To edit a sent message, open it via `click(index, button="right")` and the
  Edit item, or its message actions; the composer reopens with the old text
  as a draft. Re-observe afterwards.

## Navigation

- Search: `set_value` the search box, then act on results by `element_index`.
- Re-observe after every navigation. Channel switches rewrite the whole
  element list and stale every index.
