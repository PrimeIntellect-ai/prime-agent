import { getKeybindings } from "@earendil-works/pi-tui";

/**
 * Onboarding owns the screen before the editor exists, so its panels answer the
 * exit keys themselves; otherwise Ctrl+C does nothing and the user is trapped.
 */
export function isOnboardingExitKey(keyData: string): boolean {
	const kb = getKeybindings();
	return kb.matches(keyData, "app.clear") || kb.matches(keyData, "app.exit");
}
