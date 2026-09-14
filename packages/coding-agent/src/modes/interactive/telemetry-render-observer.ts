import { Container, ProcessTerminal } from "@earendil-works/pi-tui";

export class TelemetryStatusContainer extends Container {
	constructor(private readonly onStatusRendered: () => void) {
		super();
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length) {
			try {
				this.onStatusRendered();
			} catch {
				/* Observation must not interrupt rendering. */
			}
		}
		return lines;
	}
}

export class TelemetryTerminal extends ProcessTerminal {
	constructor(private readonly onFrameWritten: () => void) {
		super();
	}

	override write(data: string): void {
		super.write(data);
		if (data.endsWith("\x1b[?2026l")) {
			try {
				this.onFrameWritten();
			} catch {
				/* Observation must not interrupt terminal output. */
			}
		}
	}
}
