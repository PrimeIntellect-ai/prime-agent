/**
 * Calendar helpers. Months are 1-based (January = 1).
 */

export function daysInMonth(year, month) {
	if (month < 1 || month > 12) {
		throw new RangeError("month must be between 1 and 12");
	}
	if (month === 2) {
		const leap = year % 4 === 0;
		return leap ? 29 : 28;
	}
	return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

export function addDays(year, month, day, delta) {
	// Walks month boundaries; assumes the input date is valid.
	let y = year;
	let m = month;
	let d = day + delta;
	while (d > daysInMonth(y, m)) {
		d -= daysInMonth(y, m);
		m += 1;
		if (m > 12) {
			m = 1;
			y += 1;
		}
	}
	return { year: y, month: m, day: d };
}
