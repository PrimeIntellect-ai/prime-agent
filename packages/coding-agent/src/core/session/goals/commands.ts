import { validateGoalBudget, validateGoalObjective } from "../../goals.js";
import { parseSessionSlashCommand } from "../../slash-commands.js";

type GoalSlashCommand =
	| { kind: "status" }
	| { kind: "clear" }
	| { kind: "pause" }
	| { kind: "resume" }
	| { kind: "start"; objective: string; tokenBudget?: number };

export function parseGoalSlashCommand(text: string): GoalSlashCommand | undefined {
	const command = parseSessionSlashCommand(text);
	if (command?.name !== "goal") return undefined;

	const rest = command.args;
	const normalized = rest.toLowerCase();
	if (!rest || normalized === "status") {
		return { kind: "status" };
	}
	if (normalized === "clear" || normalized === "stop") {
		return { kind: "clear" };
	}
	if (normalized === "pause") {
		return { kind: "pause" };
	}
	if (normalized === "resume") {
		return { kind: "resume" };
	}

	let tokenBudget: number | undefined;
	let objective = rest;
	const firstToken = rest.split(/\s+/, 1)[0] ?? "";
	if (
		firstToken === "--budget" ||
		firstToken === "--token-budget" ||
		firstToken.startsWith("--budget=") ||
		firstToken.startsWith("--token-budget=")
	) {
		let valueText: string;
		if (firstToken === "--budget" || firstToken === "--token-budget") {
			const withoutFlag = rest.slice(firstToken.length).trimStart();
			const nextSpace = withoutFlag.search(/\s/);
			if (nextSpace < 0) {
				throw new Error("Usage: /goal [--budget <tokens>] <objective>");
			}
			valueText = withoutFlag.slice(0, nextSpace);
			objective = withoutFlag.slice(nextSpace + 1).trim();
		} else {
			const separator = firstToken.indexOf("=");
			valueText = firstToken.slice(separator + 1);
			objective = rest.slice(firstToken.length).trim();
		}
		tokenBudget = parseGoalBudgetValue(valueText);
	}

	return {
		kind: "start",
		objective: validateGoalObjective(objective),
		tokenBudget,
	};
}

function parseGoalBudgetValue(value: string): number {
	if (!/^[1-9]\d*$/.test(value)) {
		throw new Error("Goal token budget must be a positive integer.");
	}
	const budget = validateGoalBudget(Number(value));
	if (budget === undefined) {
		throw new Error("Goal token budget must be a positive integer.");
	}
	return budget;
}
