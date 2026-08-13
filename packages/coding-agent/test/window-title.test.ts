import { describe, expect, it } from "vitest";
import { APP_TITLE, formatWindowTitle } from "../src/config.js";

describe("formatWindowTitle", () => {
	it("puts the working directory first and the app name last", () => {
		expect(formatWindowTitle("magic-journey")).toBe(`magic-journey - ${APP_TITLE}`);
	});

	it("keeps the session name between directory and app name", () => {
		expect(formatWindowTitle("magic-journey", "review")).toBe(`magic-journey - review - ${APP_TITLE}`);
	});

	it("formats the agents view the same way", () => {
		expect(formatWindowTitle("Agents")).toBe(`Agents - ${APP_TITLE}`);
	});
});
