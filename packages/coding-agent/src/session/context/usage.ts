import type { Usage } from "@earendil-works/pi-ai";

export interface SessionUsageSummary {
	inputTokens: number;
	outputTokens: number;
	cost: number;
}

export function sessionUsageSummaryFrom(usage: Usage): SessionUsageSummary | undefined {
	const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	if (inputTokens === 0 && usage.output === 0 && usage.cost.total === 0) {
		return undefined;
	}
	return { inputTokens, outputTokens: usage.output, cost: usage.cost.total };
}

export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

export function addAssistantUsage(total: Usage, usage: Usage): void {
	total.input += usage.input;
	total.output += usage.output;
	total.cacheRead += usage.cacheRead;
	total.cacheWrite += usage.cacheWrite;
	total.totalTokens += usage.totalTokens;
	total.cost.input += usage.cost.input;
	total.cost.output += usage.cost.output;
	total.cost.cacheRead += usage.cost.cacheRead;
	total.cost.cacheWrite += usage.cost.cacheWrite;
	total.cost.total += usage.cost.total;
}

/** Remove a previously added usage, clamping at zero to absorb attribution drift. */
export function subtractAssistantUsage(total: Usage, usage: Usage): void {
	total.input = Math.max(0, total.input - usage.input);
	total.output = Math.max(0, total.output - usage.output);
	total.cacheRead = Math.max(0, total.cacheRead - usage.cacheRead);
	total.cacheWrite = Math.max(0, total.cacheWrite - usage.cacheWrite);
	total.totalTokens = Math.max(0, total.totalTokens - usage.totalTokens);
	total.cost.input = Math.max(0, total.cost.input - usage.cost.input);
	total.cost.output = Math.max(0, total.cost.output - usage.cost.output);
	total.cost.cacheRead = Math.max(0, total.cost.cacheRead - usage.cost.cacheRead);
	total.cost.cacheWrite = Math.max(0, total.cost.cacheWrite - usage.cost.cacheWrite);
	total.cost.total = Math.max(0, total.cost.total - usage.cost.total);
}

export function cloneUsage(usage: Usage): Usage {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		cost: {
			input: usage.cost.input,
			output: usage.cost.output,
			cacheRead: usage.cost.cacheRead,
			cacheWrite: usage.cost.cacheWrite,
			total: usage.cost.total,
		},
	};
}
