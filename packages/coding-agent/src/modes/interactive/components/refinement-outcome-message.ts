import { type Component, Spacer, Text, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { RefinementOutcomeMessage } from "../../../core/messages.js";
import type { AppliedRefinementEdit, HarnessEntry } from "../../../core/refinement/refinement.js";
import { theme } from "../theme/theme.js";
import { ExpandableEventMessage } from "./expandable-event-message.js";

type EditFieldKey = (typeof EDIT_FIELDS)[number]["key"];

/** Editable harness entry fields shown per edit, in display order. */
const EDIT_FIELDS = [
	{ key: "title", label: "Title" },
	{ key: "content", label: "Content" },
	{ key: "path", label: "Path" },
	{ key: "reference", label: "Reference" },
	{ key: "arguments", label: "Arguments" },
	{ key: "metadata", label: "Metadata" },
] as const;

/** Column layout of one expanded edit section, measured from the chat edge. */
const LABEL_INDENT = 4; // aligns field rows under the ` ╰─ ` label text
const KEY_WIDTH = 9; // "Arguments"/"Reference"
const VALUE_COLUMN = LABEL_INDENT + KEY_WIDTH + 2;

interface EditFieldRows {
	label: string;
	/** Rendered value lines; empty values produce no rows. */
	value: string[];
	/** Changed fields render -/+ rows instead of a plain value. */
	change?: { removed: string[]; added: string[] };
}

type FieldColor = "toolDiffRemoved" | "toolDiffAdded" | "customMessageText";

interface FieldRow {
	text: string;
	color: FieldColor;
	marker?: "-" | "+";
}

function editScope(edit: AppliedRefinementEdit, fallback: "local" | "global"): "local" | "global" {
	return edit.after?.scope ?? edit.before?.scope ?? fallback;
}

function editLabel(edit: AppliedRefinementEdit, fallbackScope: "local" | "global"): string {
	const scope = editScope(edit, fallbackScope);
	if (!edit.applied) {
		const error = edit.error ? `: ${edit.error}` : "";
		return theme.fg("error", `Failed to ${edit.action} ${scope} ${edit.kind} \`${edit.id}\`${error}`);
	}
	const verb = edit.action === "create" ? "Created" : edit.action === "update" ? "Updated" : "Deleted";
	return `${theme.fg("success", verb)} ${scope} ${edit.kind} \`${edit.id}\``;
}

function editCount(edits: AppliedRefinementEdit[]): string {
	const applied = edits.filter((edit) => edit.applied).length;
	return edits.length === applied
		? `${applied} edit${applied === 1 ? "" : "s"} applied`
		: `${applied}/${edits.length} edits applied`;
}

function fieldValueLines(value: unknown): string[] {
	if (typeof value === "string") {
		return value.length === 0 ? [] : value.split("\n");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return [];
	}
	return Object.keys(value).length === 0 ? [] : [JSON.stringify(value)];
}

function proposedRecord(edit: AppliedRefinementEdit): Record<string, unknown> {
	const proposed: Record<string, unknown> = {};
	for (const { key } of EDIT_FIELDS) {
		if (edit[key] !== undefined) {
			proposed[key] = edit[key];
		}
	}
	return proposed;
}

function entryFieldRows(entry: Partial<Record<EditFieldKey, unknown>> | undefined): EditFieldRows[] {
	if (!entry) {
		return [];
	}
	const rows: EditFieldRows[] = [];
	for (const { key, label } of EDIT_FIELDS) {
		const value = fieldValueLines(entry[key]);
		if (value.length > 0) {
			rows.push({ label, value });
		}
	}
	return rows;
}

/** Update edits show one plain row per unchanged field and -/+ rows for changed ones. */
function updateFieldRows(before: HarnessEntry, after: HarnessEntry): EditFieldRows[] {
	const rows: EditFieldRows[] = [];
	for (const { key, label } of EDIT_FIELDS) {
		const removed = fieldValueLines(before[key]);
		const added = fieldValueLines(after[key]);
		if (removed.length === 0 && added.length === 0) {
			continue;
		}
		if (removed.length === 0 || added.length === 0) {
			rows.push({ label, value: removed.length > 0 ? removed : added });
			continue;
		}
		if (removed.join("\n") === added.join("\n")) {
			rows.push({ label, value: added });
			continue;
		}
		rows.push({ label, value: [], change: { removed, added } });
	}
	return rows;
}

function editFieldRows(edit: AppliedRefinementEdit): EditFieldRows[] {
	if (edit.before && edit.after) {
		return updateFieldRows(edit.before, edit.after);
	}
	return entryFieldRows(edit.after ?? edit.before ?? proposedRecord(edit));
}

function fieldRows(field: EditFieldRows): FieldRow[] {
	if (field.change) {
		return [
			...field.change.removed.map((text): FieldRow => ({ text, color: "toolDiffRemoved", marker: "-" })),
			...field.change.added.map((text): FieldRow => ({ text, color: "toolDiffAdded", marker: "+" })),
		];
	}
	return field.value.map((text): FieldRow => ({ text, color: "customMessageText" }));
}

/**
 * One refinement edit as a ` ╰─ ` label row plus readable key-value rows for
 * the entry's fields, matching the agent-message layout language.
 */
class RefinementEditSection implements Component {
	constructor(
		private readonly label: string,
		private readonly fields: EditFieldRows[] = [],
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		if (width < 1) return [];
		const lines: string[] = [];
		for (const [index, line] of wrapTextWithAnsi(this.label, Math.max(1, width - LABEL_INDENT)).entries()) {
			const prefix = index === 0 ? theme.fg("dim", " ╰─ ") : " ".repeat(LABEL_INDENT);
			lines.push(`${prefix}${line}`);
		}
		for (const field of this.fields) {
			if (width >= VALUE_COLUMN) {
				this.renderWideField(field, width, lines);
			} else {
				this.renderNarrowField(field, width, lines);
			}
		}
		return lines;
	}

	private renderWideField(field: EditFieldRows, width: number, lines: string[]): void {
		const keyColumn =
			" ".repeat(LABEL_INDENT) + theme.fg("muted", field.label) + " ".repeat(KEY_WIDTH - field.label.length);
		const keyIndent = " ".repeat(LABEL_INDENT + KEY_WIDTH);
		const valueWidth = Math.max(1, width - VALUE_COLUMN);
		let keyShown = false;
		for (const row of fieldRows(field)) {
			for (const [index, segment] of wrapTextWithAnsi(row.text, valueWidth).entries()) {
				const marker = index === 0 && row.marker ? theme.fg(row.color, `${row.marker} `) : "  ";
				const prefix = keyShown ? keyIndent : keyColumn;
				keyShown = true;
				lines.push(`${prefix}${marker}${theme.fg(row.color, segment)}`);
			}
		}
	}

	// Terminals narrower than the value column fall back to stacked rows.
	private renderNarrowField(field: EditFieldRows, width: number, lines: string[]): void {
		const valueWidth = Math.max(1, width - LABEL_INDENT);
		const indent = " ".repeat(LABEL_INDENT);
		for (const line of wrapTextWithAnsi(theme.fg("muted", field.label), valueWidth)) {
			lines.push(`${indent}${line}`);
		}
		for (const row of fieldRows(field)) {
			const marker = row.marker ? `${row.marker} ` : "";
			for (const line of wrapTextWithAnsi(theme.fg(row.color, `${marker}${row.text}`), valueWidth)) {
				lines.push(`${indent}${line}`);
			}
		}
	}
}

/** Durable refinement outcome with per-edit details available on demand. */
export class RefinementOutcomeMessageComponent extends ExpandableEventMessage {
	constructor(private readonly message: RefinementOutcomeMessage) {
		super();
		this.updateDisplay();
	}

	protected updateDisplay(): void {
		this.clear();

		const { summary, edits, scope } = this.message.details;
		this.addChild(new Spacer(1));
		this.addSummary(summary, `Refinement · ${editCount(edits)}`);
		if (!this.expanded) {
			for (const edit of edits) {
				this.addChild(new RefinementEditSection(editLabel(edit, scope)));
			}
			return;
		}

		this.addChild(new Spacer(1));
		for (const [index, edit] of edits.entries()) {
			if (index > 0) {
				this.addChild(new Spacer(1));
			}
			this.addChild(new RefinementEditSection(editLabel(edit, scope), editFieldRows(edit)));
		}
	}
}

export class MalformedRefinementOutcomeMessageComponent extends ExpandableEventMessage {
	constructor() {
		super();
		this.updateDisplay();
	}

	protected updateDisplay(): void {
		this.clear();
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("error", "[Malformed refinement outcome message]"), 1, 0));
	}
}
