import { type BashResult, executeBashWithOperations } from "../../core/bash-executor.js";
import type { UserBashEvent, UserBashEventResult } from "../../core/extensions/types.js";
import type { BashExecutionMessage } from "../../core/messages.js";
import { type BashOperations, createLocalBashOperations } from "../../core/tools/bash.js";

export interface ExecuteBashOptions {
	excludeFromContext?: boolean;
	operations?: BashOperations;
	transient?: boolean;
}

export interface RunUserBashOptions {
	excludeFromContext?: boolean;
	transient?: boolean;
	runId?: string;
}

type UserBashEndDetails = {
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	errorMessage?: string;
};

export type SessionBashEvent =
	| {
			type: "bash_start";
			command: string;
			excludeFromContext: boolean;
			transient?: boolean;
			runId?: string;
	  }
	| { type: "bash_output"; chunk: string }
	| ({ type: "bash_end"; transient?: boolean; runId?: string } & UserBashEndDetails);

export interface SessionBashHost {
	getCwd(): string;
	getShellCommandPrefix(): string | undefined;
	getShellPath(): string | undefined;
	isStreaming(): boolean;
	intercept(event: UserBashEvent): Promise<UserBashEventResult | undefined>;
	emit(event: SessionBashEvent): void;
	appendMessage(message: BashExecutionMessage): void;
	onStateChange(): void;
	onUserBashEnd(): Promise<void>;
	executeBash(command: string, onChunk?: (chunk: string) => void, options?: ExecuteBashOptions): Promise<BashResult>;
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void;
}

export class SessionBash {
	private _bashAbortControllers = new Set<AbortController>();
	private _userBashRunning = false;
	private _userBashAbortRequested = false;
	private _pendingBashMessages: BashExecutionMessage[] = [];

	constructor(private readonly _host: SessionBashHost) {}

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.operations Custom BashOperations for remote execution
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: ExecuteBashOptions,
	): Promise<BashResult> {
		// Each invocation owns its controller so abortBash reaches every in-flight command.
		const abortController = new AbortController();
		this._bashAbortControllers.add(abortController);

		const prefix = this._host.getShellCommandPrefix();
		const shellPath = this._host.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			const result = await executeBashWithOperations(
				resolvedCommand,
				this._host.getCwd(),
				options?.operations ?? createLocalBashOperations({ shellPath }),
				{
					onChunk,
					signal: abortController.signal,
				},
			);

			if (!options?.transient) {
				this._host.recordBashResult(command, result, options);
			}
			return result;
		} finally {
			this._bashAbortControllers.delete(abortController);
			this._host.onStateChange();
		}
	}

	/**
	 * Run a user-initiated bash command (! / !! prefix), emitting bash_start,
	 * bash_output, and bash_end session events so any attached client can render
	 * streaming output. Extensions can intercept execution via the user_bash event.
	 * Execution failures are reported through bash_end rather than a rejected promise;
	 * only the already-running guard and extension dispatch errors reject.
	 * @param command The bash command to execute
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 */
	async runUserBash(command: string, options?: RunUserBashOptions): Promise<void> {
		if (this.isBashRunning) {
			throw new Error("A bash command is already running");
		}
		// Claim the bash slot synchronously: isBashRunning is otherwise false until
		// executeBash installs its abort controller, which would let a second command
		// slip through during the user_bash extension dispatch below.
		this._userBashRunning = true;
		this._userBashAbortRequested = false;
		// Echoed on bash_start/bash_end so the requesting client can tell its own
		// run apart from other clients' runs broadcast on the same session.
		const identity = {
			...(options?.transient ? { transient: true } : {}),
			...(options?.runId !== undefined ? { runId: options.runId } : {}),
		};
		let end: UserBashEndDetails;
		try {
			end = await this.runUserBashLocked(
				command,
				options?.excludeFromContext ?? false,
				options?.transient ?? false,
				identity,
			);
		} finally {
			this._userBashRunning = false;
			this._host.onStateChange();
		}
		// Emitted after the slot is released so clients never observe a bash_end
		// while the session still rejects new commands as already running.
		this._host.emit({ type: "bash_end", ...end, ...identity });
		void this._host.onUserBashEnd().catch(() => undefined);
	}

	private async runUserBashLocked(
		command: string,
		excludeFromContext: boolean,
		transient: boolean,
		identity: { transient?: boolean; runId?: string },
	): Promise<UserBashEndDetails> {
		const eventResult = await this._host.intercept({
			type: "user_bash",
			command,
			excludeFromContext,
			cwd: this._host.getCwd(),
		});

		// Transient runs (side-conversation bash) live only in their pane: they
		// are never recorded, so reloads and rebuilds cannot resurface them.
		const record = transient
			? () => {}
			: (result: BashResult) => this._host.recordBashResult(command, result, { excludeFromContext });

		this._host.emit({
			type: "bash_start",
			command,
			excludeFromContext,
			...identity,
		});
		try {
			// If an extension returned a full result, surface it without executing
			if (eventResult?.result) {
				const result = eventResult.result;
				if (result.output) {
					this._host.emit({ type: "bash_output", chunk: result.output });
				}
				record(result);
				return {
					exitCode: result.exitCode,
					cancelled: result.cancelled,
					truncated: result.truncated,
					fullOutputPath: result.fullOutputPath,
				};
			}

			// An abort that arrived before the process spawned (during extension
			// dispatch) has no abort controller to act on; honor it here instead.
			if (this._userBashAbortRequested) {
				record({
					output: "",
					exitCode: undefined,
					cancelled: true,
					truncated: false,
				});
				return { exitCode: undefined, cancelled: true, truncated: false };
			}

			const result = await this._host.executeBash(
				command,
				(chunk) => this._host.emit({ type: "bash_output", chunk }),
				{
					excludeFromContext,
					operations: eventResult?.operations,
					transient,
				},
			);
			return {
				exitCode: result.exitCode,
				cancelled: result.cancelled,
				truncated: result.truncated,
				fullOutputPath: result.fullOutputPath,
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			// Persist the failure like every other outcome so replayed transcripts
			// and the LLM context reflect that the command did not run.
			record({
				output: `bash failed: ${errorMessage}`,
				exitCode: undefined,
				cancelled: false,
				truncated: false,
			});
			return {
				exitCode: undefined,
				cancelled: false,
				truncated: false,
				errorMessage,
			};
		}
	}

	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this._host.isStreaming()) {
			this._pendingBashMessages.push(bashMessage);
		} else {
			this._host.appendMessage(bashMessage);
		}
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		// A user bash command may not have spawned yet (extension dispatch in
		// progress); flag the request so runUserBash cancels before executing.
		// runUserBash clears the flag at each start, so a stale flag is harmless.
		if (this._userBashRunning) {
			this._userBashAbortRequested = true;
		}
		for (const controller of this._bashAbortControllers) {
			controller.abort();
		}
	}

	get isBashRunning(): boolean {
		return this._bashAbortControllers.size > 0 || this._userBashRunning;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	flushPendingMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		for (const bashMessage of this._pendingBashMessages) {
			this._host.appendMessage(bashMessage);
		}

		this._pendingBashMessages = [];
	}
}
