import { describe, expect, it } from "vitest";
// @ts-expect-error plain-JS release helper without type declarations
import { buildReleaseSection } from "../../../scripts/lib/changelog-fragments.mjs";

const build = buildReleaseSection as (
	changelogContent: string,
	fragments: { name: string; content: string }[],
	version: string,
	date: string,
) => { content: string; changed: boolean };

describe("buildReleaseSection", () => {
	it("aggregates fragments into the release section when [Unreleased] is empty", () => {
		const changelog = "# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n- Old entry.\n";
		const fragments = [
			{ name: "a.md", content: "- Added feature A.\n" },
			{ name: "b.md", content: "- Fixed bug B." },
		];
		const result = build(changelog, fragments, "1.1.0", "2026-02-01");
		expect(result.changed).toBe(true);
		expect(result.content).toBe(
			"# Changelog\n\n## [1.1.0] - 2026-02-01\n\n- Added feature A.\n- Fixed bug B.\n\n## [1.0.0] - 2026-01-01\n\n- Old entry.\n",
		);
	});

	it("merges existing [Unreleased] entries first, then fragments oldest-first", () => {
		const changelog =
			"# Changelog\n\n## [Unreleased]\n\n- Existing unreleased entry.\n\n## [1.0.0] - 2026-01-01\n\n- Old entry.\n";
		const fragments = [
			{ name: "old.md", content: "- Oldest fragment.\n" },
			{ name: "new.md", content: "- Newest fragment.\n" },
		];
		const result = build(changelog, fragments, "1.1.0", "2026-02-01");
		expect(result.content).toContain(
			"## [1.1.0] - 2026-02-01\n\n- Existing unreleased entry.\n- Oldest fragment.\n- Newest fragment.\n",
		);
	});

	it("reports changed=false when there is no [Unreleased] section and no fragments", () => {
		const changelog = "# Changelog\n\n## [1.0.0] - 2026-01-01\n\n- Old entry.\n";
		const result = build(changelog, [], "1.1.0", "2026-02-01");
		expect(result.changed).toBe(false);
		expect(result.content).toBe(changelog);
	});

	it("keeps multi-bullet fragments intact", () => {
		const changelog = "# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n- Old entry.\n";
		const fragments = [{ name: "multi.md", content: "- First bullet.\n- Second bullet.\n" }];
		const result = build(changelog, fragments, "1.1.0", "2026-02-01");
		expect(result.content).toContain("## [1.1.0] - 2026-02-01\n\n- First bullet.\n- Second bullet.\n");
	});
});
