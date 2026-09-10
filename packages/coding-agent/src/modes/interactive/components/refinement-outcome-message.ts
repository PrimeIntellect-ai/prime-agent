import { type Component, Spacer, Text } from "@earendil-works/pi-tui";
import type { RefinementOutcomeMessage } from "../../../core/messages.js";
import type { AppliedRefinementEdit, HarnessEntry } from "../../../core/refinement/refinement.js";
import { generateDiffString } from "../../../core/tools/edit-diff.js";
import { theme } from "../theme/theme.js";
import { renderRichDiff } from "./diff.js";
import { ExpandableEventMessage } from "./expandable-event-message.js";

type EditFieldKey = (typeof EDIT_FIELDS)[number]["key"];

/** Editable harness entry fields shown per edit, in display order. */
const EDIT_FIELDS = [
	{ key: "title", label: "Title" },
	{ key: "content", label: "Description" },
	{ key: "path", label: "Path" },
	{ key: "reference", label: "Reference" },
	{ key: "arguments", label: "Arguments" },
	{ key: "metadata", label: "Metadata" },
] as const;

interface EditFieldRows {
	label: string;
	/** Rendered value lines; empty values produce no rows. */
	value: string[];
	/** Changed fields render -/+ rows instead of a plain value. */
	change?: { removed: string[]; added: string[] };
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

function refinementHeader(message: RefinementOutcomeMessage): string {
	const { edits, rollbackOf } = message.details;
	const applied = edits.filter((edit) => edit.applied);
	const operation = rollbackOf ? "Harness rollback" : "Harness refinement";
	if (edits.length === 0)
		return `${rollbackOf ? "Harness rollback unchanged" : "Harness unchanged"} · no edits applied`;
	if (applied.length === 0) return `${operation} failed · 0/${edits.length} edits applied`;
	if (applied.length < edits.length) {
		return `${rollbackOf ? "Harness partially rolled back" : "Harness partially refined"} · ${applied.length}/${edits.length} edits applied`;
	}
	if (rollbackOf)
		return `Harness rollback completed · ${applied.length} edit${applied.length === 1 ? "" : "s"} applied`;
	const first = applied[0]!;
	if (applied.every((edit) => edit.kind === first.kind)) {
		const kind =
			first.kind === "memory"
				? applied.length === 1
					? "memory"
					: "memories"
				: `${first.kind}${applied.length === 1 ? "" : "s"}`;
		const action = applied.every((edit) => edit.action === first.action)
			? { create: "created", update: "updated", delete: "deleted" }[first.action]
			: "changed";
		return `Harness refined · ${applied.length} ${kind} ${action}`;
	}
	return `Harness refined · ${applied.length} edits applied`;
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
		if (removed.join("\n") === added.join("\n")) {
			rows.push({ label, value: added });
			continue;
		}
		rows.push({ label, value: [], change: { removed, added } });
	}
	return rows;
}

function editFieldRows(edit: AppliedRefinementEdit): EditFieldRows[] {
	if (!edit.applied) {
		const proposed = entryFieldRows(edit.after ?? proposedRecord(edit));
		if (!edit.before) return proposed;
		return [
			...entryFieldRows(edit.before).map((field) => ({ ...field, label: `Before ${field.label}` })),
			...proposed.map((field) => ({ ...field, label: `Proposed ${field.label}` })),
		];
	}
	if (edit.before && edit.after) {
		return updateFieldRows(edit.before, edit.after);
	}
	const fields = entryFieldRows(edit.after ?? edit.before ?? proposedRecord(edit));
	if (edit.action === "update") return fields;
	return fields.map((field) => ({
		label: field.label,
		value: [],
		change: {
			removed: edit.action === "delete" ? field.value : [],
			added: edit.action === "create" ? field.value : [],
		},
	}));
}

/** Expanded fields share the same line gutters and background blocks as file edits. */
class RefinementEditSection implements Component {
	constructor(
		private readonly label: string,
		private readonly fields: EditFieldRows[] = [],
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		if (width < 1) return [];
		const lines = new Text(this.label, 1, 0).render(width);
		for (const field of this.fields) {
			lines.push(...new Text(theme.fg("muted", field.label), 1, 0).render(width));
			if (field.change) {
				const { diff } = generateDiffString(
					field.change.removed.join("\n"),
					field.change.added.join("\n"),
					Number.MAX_SAFE_INTEGER,
				);
				const inset = width > 1 ? " " : "";
				for (const row of renderRichDiff(diff, width - inset.length)) lines.push(`${inset}${row}`);
			} else {
				for (const row of new Text(field.value.join("\n"), 1, 0).render(width)) lines.push(row);
			}
		}
		return lines;
	}
}

/** Durable refinement outcome with per-edit details available on demand. */
export class RefinementOutcomeMessageComponent extends ExpandableEventMessage {
	private summaryExpanded = false;
	constructor(private readonly message: RefinementOutcomeMessage) {
		super();
		this.updateDisplay();
	}

	setEditDiffsExpanded(expanded: boolean): void {
		if (this.summaryExpanded === expanded) return;
		this.summaryExpanded = expanded;
		this.updateDisplay();
	}

	protected updateDisplay(): void {
		this.clear();

		const { summary, edits, scope, rollbackOf, refinementId } = this.message.details;
		this.addChild(new Spacer(1));
		const outcome = refinementHeader(this.message);
		const header = outcome.startsWith("Harness refined ·") ? "Harness refined" : outcome;
		this.addChild(new Text(theme.fg("refinementHeader", `◆ ${header}`), 1, 0));
		if (this.summaryExpanded || this.expanded) {
			this.addSummary(
				summary.trim() || "No summary was recorded for this harness change.",
				undefined,
				"refinementSummary",
			);
		}
		if (this.expanded) {
			this.addChild(new Spacer(1));
			this.addChild(
				new Text(
					theme.fg(
						"dim",
						`${outcome} · Refinement ${refinementId} · ${scope}${rollbackOf ? ` · rollback of ${rollbackOf}` : ""}`,
					),
					1,
					0,
				),
			);

			for (const edit of edits) {
				this.addChild(new Spacer(1));
				this.addChild(new RefinementEditSection(editLabel(edit, scope), editFieldRows(edit)));
				if (edit.reason) this.addChild(new Text(theme.fg("muted", `Reason: ${edit.reason}`), 1, 0));
			}
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
