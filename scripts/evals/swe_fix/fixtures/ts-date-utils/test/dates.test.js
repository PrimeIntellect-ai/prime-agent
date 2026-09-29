import { test } from "node:test";
import assert from "node:assert/strict";
import { daysInMonth, addDays } from "../src/dates.js";

test("returns 31 for January", () => {
	assert.equal(daysInMonth(2024, 1), 31);
});

test("returns 29 for February in a leap year", () => {
	assert.equal(daysInMonth(2024, 2), 29);
});

test("returns 28 for February in a non-leap century year", () => {
	assert.equal(daysInMonth(1900, 2), 28);
});

test("addDays rolls over into the next month", () => {
	assert.deepEqual(addDays(2024, 1, 31, 1), { year: 2024, month: 2, day: 1 });
});
