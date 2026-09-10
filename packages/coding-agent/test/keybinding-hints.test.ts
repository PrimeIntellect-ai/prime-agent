import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { expandCollapseHint, formatKeyText } from "../src/modes/interactive/components/keybinding-hints.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

describe("keybinding hint formatting", () => {
	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("omits inline conversation detail hints for both expansion states", () => {
		for (const expanded of [false, true]) {
			expect(expandCollapseHint("app.tools.expand", expanded)).toBe("");
		}
		setKeybindings(new KeybindingsManager({ "app.tools.expand": "ctrl+e" }));
		expect(expandCollapseHint("app.tools.expand", false)).toBe("");
	});

	it("omits inline message expansion hints even when remapped", () => {
		expect(expandCollapseHint("app.messages.expand", false)).toBe("");
		expect(expandCollapseHint("app.messages.expand", true)).toBe("");
		setKeybindings(new KeybindingsManager({ "app.messages.expand": "ctrl+e" }));
		expect(expandCollapseHint("app.messages.expand", false)).toBe("");
	});

	it("uses macOS modifier names on darwin but keeps Ctrl literal", () => {
		expect(formatKeyText("ctrl+p", "darwin")).toBe("Ctrl+P");
		expect(formatKeyText("alt+enter", "darwin")).toBe("Option+Enter");
		expect(formatKeyText("shift+ctrl+p/alt+up", "darwin")).toBe("Shift+Ctrl+P/Option+↑");
	});

	it("keeps canonical modifier names on linux", () => {
		expect(formatKeyText("ctrl+p", "linux")).toBe("Ctrl+P");
		expect(formatKeyText("alt+enter", "linux")).toBe("Alt+Enter");
		expect(formatKeyText("shift+ctrl+p/alt+up", "linux")).toBe("Shift+Ctrl+P/Alt+↑");
	});

	it("keeps canonical modifier names on Windows", () => {
		expect(formatKeyText("ctrl+p", "win32")).toBe("Ctrl+P");
		expect(formatKeyText("alt+enter", "win32")).toBe("Alt+Enter");
		expect(formatKeyText("ctrl+backspace/pageUp", "win32")).toBe("Ctrl+Backspace/PageUp");
	});

	it("formats escape as Esc", () => {
		expect(formatKeyText("escape", "linux")).toBe("Esc");
		expect(formatKeyText("esc", "linux")).toBe("Esc");
		expect(formatKeyText("ctrl+escape", "linux")).toBe("Ctrl+Esc");
	});

	it("formats arrow keys as symbols", () => {
		expect(formatKeyText("up/down/left/right", "linux")).toBe("↑/↓/←/→");
	});
});
