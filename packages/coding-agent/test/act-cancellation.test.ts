import { describe, expect, it } from "vitest";
import {
	actCancellationCapability,
	actCancellationPromptBoundary,
	actContextLabel,
} from "../src/core/act-cancellation.js";

describe("Act cancellation capability", () => {
	it("publishes the POSIX managed boundary", () => {
		expect(actCancellationCapability("linux")).toBe("posix-managed");
		expect(actCancellationCapability("darwin")).toBe("posix-managed");
		expect(actCancellationPromptBoundary("linux")).toContain("correlated interrupt");
		expect(actCancellationPromptBoundary("linux")).toContain("Detached, daemonized, remote, and completed effects");
		expect(actContextLabel("linux")).toBe("Act lane");
	});

	it("publishes the native Windows cooperative-only boundary", () => {
		expect(actCancellationCapability("win32")).toBe("cooperative-only");
		expect(actCancellationPromptBoundary("win32")).toContain("no prompt-stop guarantee");
		expect(actCancellationPromptBoundary("win32")).toContain("do not claim they stopped");
		expect(actContextLabel("win32")).toBe("Act lane (cooperative cancellation only)");
	});
});
