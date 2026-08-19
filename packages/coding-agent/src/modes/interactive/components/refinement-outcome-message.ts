import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { RefinementOutcomeMessage } from "../../../core/messages.js";
import type { AppliedRefinementEdit, HarnessEntry } from "../../../core/refinement/refinement.js";
import { generateDiffString } from "../../../core/tools/edit-diff.js";
import { theme } from "../theme/theme.js";
import { renderDiff } from "./diff.js";
import { expandCollapseHint } from "./keybinding-hints.js";

function editableEntry(entry: HarnessEntry): Record<string, unknown> {
	return {
		title: entry.title,
		content: entry.content,
		path: entry.path,
		reference: entry.reference,
		arguments: entry.arguments,
		metadata: entry.metadata,
	};
}

function proposedEntry(edit: AppliedRefinementEdit): Record<string, unknown> {
	return {
		...(edit.title === undefined ? {} : { title: edit.title }),
		...(edit.content === undefined ? {} : { content: edit.content }),
		...(edit.path === undefined ? {} : { path: edit.path }),
		...(edit.reference === undefined ? {} : { reference: edit.reference }),
		...(edit.arguments === undefined ? {} : { arguments: edit.arguments }),
		...(edit.metadata === undefined ? {} : { metadata: edit.metadata }),
	};
}

function entryText(entry: Record<string, unknown> | undefined): string {
	return entry === undefined ? "" : `${JSON.stringify(entry, null, 2)}\n`;
}

function editDiff(edit: AppliedRefinementEdit): string {
	const before = edit.before ? editableEntry(edit.before) : undefined;
	const after = edit.after ? editableEntry(edit.after) : edit.action === "delete" ? undefined : proposedEntry(edit);
	return generateDiffString(entryText(before), entryText(after), 4).diff;
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

export class RefinementOutcomeMessageComponent extends Container {
	private readonly content = new Container();
	private editDiffsExpanded = false;

	constructor(private readonly message: RefinementOutcomeMessage) {
		super();
		this.addChild(new Spacer(1));
		this.addChild(this.content);
		this.rebuild();
	}

	setExpanded(_expanded: boolean): void {}

	setEditDiffsExpanded(expanded: boolean): void {
		if (this.editDiffsExpanded === expanded) return;
		this.editDiffsExpanded = expanded;
		this.rebuild();
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		this.content.clear();
		this.content.addChild(
			new Text(theme.fg("success", `✓ Refinement complete: ${this.message.details.summary}`), 0, 0),
		);

		const edits = this.message.details.edits;
		const applied = edits.filter((edit) => edit.applied).length;
		const count =
			edits.length === applied
				? `${applied} edit${applied === 1 ? "" : "s"} applied`
				: `${applied}/${edits.length} edits applied`;
		const hint = edits.length === 0 ? "" : ` · ${expandCollapseHint("app.edits.expand", this.editDiffsExpanded)}`;
		this.content.addChild(new Text(`Refined continual harness state: ${count}${hint}`, 0, 0));

		for (const edit of edits) {
			this.content.addChild(
				new Text(`${theme.fg("dim", "    ╰─ ")}${editLabel(edit, this.message.details.scope)}`, 0, 0),
			);
			if (this.editDiffsExpanded) {
				const diff = editDiff(edit);
				if (diff) this.content.addChild(new Text(renderDiff(diff), 4, 0));
			}
		}
	}
}

export class MalformedRefinementOutcomeMessageComponent extends Container {
	constructor() {
		super();
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("error", "[Malformed refinement outcome message]"), 0, 0));
	}

	setExpanded(_expanded: boolean): void {}
	setEditDiffsExpanded(_expanded: boolean): void {}
}
