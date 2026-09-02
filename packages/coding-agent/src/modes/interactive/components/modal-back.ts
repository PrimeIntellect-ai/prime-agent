/**
 * Shared helper for treating the left arrow as "go back" inside dialogs.
 *
 * The left arrow is bound to `app.modal.back` so that, like Esc, it dismisses a
 * dialog and returns to the previous screen. Dialogs that contain a text field
 * (model filter, login input, session search) must not steal the left arrow
 * while the user is editing: it only acts as back when the field is empty or the
 * cursor is already at the start (column 0). This mirrors the chat editor's
 * existing `onAgentsBack` guard so behaviour stays consistent across the app.
 */

import { getKeybindings } from "@prime-intellect/prime-agent-tui";

/** A text input whose cursor position can be inspected. */
export interface BackGuardInput {
	getCursor(): number;
}

/**
 * Returns true when `data` should dismiss the current dialog (act like Esc).
 *
 * Pass the dialog's text input to keep the left arrow available for cursor
 * movement: back only triggers when the cursor sits at column 0. Omit `input`
 * for dialogs that have no text field, where left is always back.
 */
export function shouldTreatAsBack(data: string, input?: BackGuardInput): boolean {
	if (!getKeybindings().matches(data, "app.modal.back")) {
		return false;
	}
	return input === undefined || input.getCursor() === 0;
}
