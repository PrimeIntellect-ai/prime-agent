import type { Component } from "@earendil-works/pi-tui";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.js";

/**
 * Footer component for the prime brand TUI.
 *
 * Renders nothing by default — token counters, cost, model name, cwd, and context %
 * are intentionally hidden. The setters and invalidate/dispose hooks are kept so the
 * existing call sites in interactive-mode keep working without modification, and so
 * `/usage` can expose telemetry without re-plumbing.
 */
export class FooterComponent implements Component {
	constructor(private footerData: ReadonlyFooterDataProvider) {
		void this.footerData;
	}

	setAutoCompactEnabled(_enabled: boolean): void {
		// no-op while the footer is empty
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	render(_width: number): string[] {
		// Footer is intentionally empty in the prime brand TUI. Telemetry (cost, tokens, model,
		// cwd, context %) is hidden by default; bring it back via /usage when needed.
		return [];
	}
}
