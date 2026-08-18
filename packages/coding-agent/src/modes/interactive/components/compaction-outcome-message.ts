import { Box, Container, Text } from "@earendil-works/pi-tui";
import type { CompactionOutcomeMessage } from "../../../core/messages.js";
import { theme } from "../theme/theme.js";

/** Renders a durable unsuccessful automatic-compaction outcome. */
export class CompactionOutcomeMessageComponent extends Container {
	constructor(message: CompactionOutcomeMessage) {
		super();
		const color = message.details.outcome === "skipped" ? "warning" : "error";
		const contentBox = new Box(2, 1, (text: string) => theme.getUserMessageBackgroundColor()(text));
		contentBox.addChild(new Text(theme.fg(color, message.content), 0, 0));
		this.addChild(contentBox);
	}

	setExpanded(_expanded: boolean): void {}
}

export class MalformedCompactionOutcomeMessageComponent extends Container {
	constructor() {
		super();
		const contentBox = new Box(2, 1, (text: string) => theme.getUserMessageBackgroundColor()(text));
		contentBox.addChild(new Text(theme.fg("error", "[Malformed compaction outcome message]"), 0, 0));
		this.addChild(contentBox);
	}

	setExpanded(_expanded: boolean): void {}
}
