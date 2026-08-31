import { describe, expect, it } from "vitest";
import { QueueSelection } from "../src/modes/interactive/queue-selection.js";

const queue = { steering: ["s1", "s2"], followUp: ["f1", "f2"] };

describe("QueueSelection", () => {
	it("browses newest-first from the draft and back", () => {
		const selection = new QueueSelection();
		expect(selection.move(queue, "draft", 1)).toBeUndefined();
		expect(selection.move(queue, "draft", -1)).toBe("f2");
		expect(selection.selected).toEqual({ lane: "followUp", index: 1, text: "f2" });
		expect(selection.move(queue, "", -1)).toBe("f1");
		expect(selection.move(queue, "", -1)).toBe("s2");
		expect(selection.move(queue, "", -1)).toBe("s1");
		expect(selection.move(queue, "", -1)).toBeUndefined();
		expect(selection.selected).toEqual({ lane: "steering", index: 0, text: "s1" });
		for (const expected of ["s2", "f1", "f2", "draft"]) {
			expect(selection.move(queue, "", 1)).toBe(expected);
		}
		expect(selection.isBrowsing).toBe(false);
	});

	it("does not enter browse mode when the queue is empty", () => {
		const selection = new QueueSelection();
		expect(selection.move({ steering: [], followUp: [] }, "draft", -1)).toBeUndefined();
		expect(selection.isBrowsing).toBe(false);
	});

	it("reset returns the stashed draft once", () => {
		const selection = new QueueSelection();
		selection.move(queue, "my draft", -1);
		expect(selection.reset()).toBe("my draft");
		expect(selection.isBrowsing).toBe(false);
		expect(selection.reset()).toBe("");
	});
});
