import type { HostRequestHandler } from "../../core/kernel/index.js";

interface AsyncBashCompletionRequest {
	pid: number;
	command: string;
	exitCode: number;
}

type AsyncBashCompletionHandler = (request: AsyncBashCompletionRequest) => void | Promise<void>;

interface AsyncBashConsumedRequest {
	pid: number;
	command: string;
}

type AsyncBashConsumedHandler = (request: AsyncBashConsumedRequest) => void | Promise<void>;
/** Adapt detached kernel bash completions into a validated host notification. */
export function createAsyncBashCompletionHostHandler(handler: AsyncBashCompletionHandler): HostRequestHandler {
	return async (payload) => {
		const { pid, command, exitCode } = payload;
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
			throw new Error("bash.completed pid must be a positive integer");
		}
		if (typeof command !== "string" || !command) {
			throw new Error("bash.completed command must be a non-empty string");
		}
		if (typeof exitCode !== "number" || !Number.isInteger(exitCode)) {
			throw new Error("bash.completed exitCode must be an integer");
		}
		await handler({ pid, command, exitCode });
		return {};
	};
}

/** The kernel read a finished command's result, so its completion notice is stale. */
export function createAsyncBashConsumedHostHandler(handler: AsyncBashConsumedHandler): HostRequestHandler {
	return async (payload) => {
		const { pid, command } = payload;
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
			throw new Error("bash.consumed pid must be a positive integer");
		}
		if (typeof command !== "string" || !command) {
			throw new Error("bash.consumed command must be a non-empty string");
		}
		await handler({ pid, command });
		return {};
	};
}
