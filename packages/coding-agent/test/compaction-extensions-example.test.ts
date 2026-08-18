import { describe, expect, it } from "vitest";
import type { ExtensionAPI, SessionBeforeCompactEvent, SessionCompactEvent } from "../src/core/extensions/index.js";

describe("Documentation example", () => {
	it("custom compaction example should type-check correctly", () => {
		const exampleExtension = (pi: ExtensionAPI) => {
			pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx) => {
				const { preparation, branchEntries } = event;
				const { sessionManager, modelRegistry } = ctx;
				const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, isSplitTurn } =
					preparation;

				expect(Array.isArray(messagesToSummarize)).toBe(true);
				expect(Array.isArray(turnPrefixMessages)).toBe(true);
				expect(typeof isSplitTurn).toBe("boolean");
				expect(typeof tokensBefore).toBe("number");
				expect(typeof sessionManager.getEntries).toBe("function");
				expect(typeof modelRegistry.getApiKeyAndHeaders).toBe("function");
				expect(typeof firstKeptEntryId).toBe("string");
				expect(Array.isArray(branchEntries)).toBe(true);

				const summary = messagesToSummarize
					.filter((m) => m.role === "user")
					.map((m) => `- ${typeof m.content === "string" ? m.content.slice(0, 100) : "[complex]"}`)
					.join("\n");

				return {
					compaction: {
						summary: `User requests:\n${summary}`,
						firstKeptEntryId,
						tokensBefore,
					},
				};
			});
		};

		expect(typeof exampleExtension).toBe("function");
	});

	it("compact event should have correct fields", () => {
		const checkCompactEvent = (pi: ExtensionAPI) => {
			pi.on("session_compact", async (event: SessionCompactEvent) => {
				const entry = event.compactionEntry;
				const fromExtension = event.fromExtension;

				expect(entry.type).toBe("compaction");
				expect(typeof entry.summary).toBe("string");
				expect(typeof entry.tokensBefore).toBe("number");
				expect(typeof fromExtension).toBe("boolean");
			});
		};

		expect(typeof checkCompactEvent).toBe("function");
	});
});
