import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test, vi } from "vitest";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const config: SettingsConfig = {
	autoCompact: true,
	idleEvictionMinutes: 90,
	showImages: true,
	autoResizeImages: true,
	blockImages: false,
	enableSkillCommands: true,
	enableBuiltinSkills: true,
	steeringMode: "one-at-a-time",
	followUpMode: "one-at-a-time",
	transport: "sse",
	thinkingLevel: "off",
	availableThinkingLevels: ["off"],
	currentTheme: "dark",
	availableThemes: ["dark"],
	hideThinkingBlock: false,
	mermaidRenderingMode: "streaming",
	treeFilterMode: "user-only",
	showHardwareCursor: false,
	editorPaddingX: 0,
	autocompleteMaxVisible: 5,
	quietStartup: false,
	clearOnShrink: false,
	showTerminalProgress: false,
	fullscreen: true,
	warnings: {},
};

const callbacks: SettingsCallbacks = {
	onAutoCompactChange: () => {},
	onIdleEvictionMinutesChange: () => {},
	onShowImagesChange: () => {},
	onAutoResizeImagesChange: () => {},
	onBlockImagesChange: () => {},
	onEnableSkillCommandsChange: () => {},
	onEnableBuiltinSkillsChange: () => {},
	onSteeringModeChange: () => {},
	onFollowUpModeChange: () => {},
	onTransportChange: () => {},
	onThinkingLevelChange: () => {},
	onThemeChange: () => {},
	onHideThinkingBlockChange: () => {},
	onMermaidRenderingModeChange: () => {},
	onTreeFilterModeChange: () => {},
	onShowHardwareCursorChange: () => {},
	onEditorPaddingXChange: () => {},
	onAutocompleteMaxVisibleChange: () => {},
	onQuietStartupChange: () => {},
	onClearOnShrinkChange: () => {},
	onShowTerminalProgressChange: () => {},
	onFullscreenChange: () => {},
	onWarningsChange: () => {},
	onCancel: () => {},
};

describe("SettingsSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("shows the image metadata toggle without a terminal graphics protocol", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		try {
			const component = new SettingsSelectorComponent(config, callbacks);
			const rendered = stripAnsi(component.render(120).join("\n"));

			expect(rendered).toContain("Show image metadata");
			expect(rendered).toContain("Auto-resize images");
			for (const character of "idle") component.getSettingsList().handleInput(character);
			expect(stripAnsi(component.render(120).join("\n"))).toContain("Idle worker eviction");
		} finally {
			resetCapabilitiesCache();
		}
	});

	test("cycles a custom idle eviction value to the next numeric option", () => {
		const onIdleEvictionMinutesChange = vi.fn();
		const component = new SettingsSelectorComponent(
			{ ...config, idleEvictionMinutes: 120 },
			{ ...callbacks, onIdleEvictionMinutesChange },
		);
		const list = component.getSettingsList();
		for (const character of "idle") list.handleInput(character);

		list.handleInput("\r");

		expect(onIdleEvictionMinutesChange).toHaveBeenCalledWith(180);
	});

	test.each([0.5, 1.5])("round-trips a fractional idle eviction value of %s", (value) => {
		const onIdleEvictionMinutesChange = vi.fn();
		const component = new SettingsSelectorComponent(
			{ ...config, idleEvictionMinutes: value },
			{ ...callbacks, onIdleEvictionMinutesChange },
		);
		const list = component.getSettingsList();
		for (const character of "idle") list.handleInput(character);

		// Cycle through every option and back onto the custom fractional value.
		for (let index = 0; index < 7; index++) list.handleInput("\r");

		expect(onIdleEvictionMinutesChange).toHaveBeenLastCalledWith(value);
		expect(stripAnsi(component.render(120).join("\n"))).toContain(String(value));
	});
});
