import { Box, Container, Text } from "@earendil-works/pi-tui";
import type { SessionSlashCommandResultMessage } from "../../../core/messages.js";
import { theme } from "../theme/theme.js";

/** Renders a durable session-command outcome with user-message spacing. */
export class SlashCommandResultMessageComponent extends Container {
	constructor(message: SessionSlashCommandResultMessage) {
		super();
		const contentBox = new Box(2, 1, (text: string) => theme.getUserMessageBackgroundColor()(text));
		contentBox.addChild(new Text(message.content, 0, 0));
		this.addChild(contentBox);
	}

	setExpanded(_expanded: boolean): void {}
}
