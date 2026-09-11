import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "../../core/agent-session.js";
import {
	type AgentAutonomousConfig,
	type AgentAutonomousStatus,
	type AutonomousRuntimeState,
	addAutonomousContinuation,
	addAutonomousUsage,
	autonomousStatus,
	createAutonomousRuntimeState,
	isUnlimitedAutonomousLimit,
	nextAutonomousContinuation,
	refreshAutonomousQualityGates,
	setAutonomousEnabled,
	setAutonomousLimits,
	UNLIMITED_AUTONOMOUS_LIMIT,
} from "../../core/autonomous.js";
import { parseCommandArgs } from "../../core/prompt-templates.js";
import type { SessionManager } from "../../core/session-manager.js";
import { parseSessionSlashCommand } from "../../core/slash-commands.js";
import type { SessionCompaction } from "../compaction/controller.js";
import type { CustomMessage } from "../context/messages.js";
import type { SessionInputAdmission } from "../input/input-admission.js";
import { createPreparedTurnAction, primaryDeliveryRecord, type QueuedSessionAction } from "../prepared-actions.js";
import type { SessionContinuation } from "./continuation.js";

type AutonomousSlashCommand = { kind: "status" } | { kind: "on"; config?: AgentAutonomousConfig } | { kind: "off" };
type AutonomousRuntimeSnapshot = Pick<
	AutonomousRuntimeState,
	"continuationsUsed" | "gateAttempts" | "lastGateFailure" | "lastGateFailureSnapshot"
>;

const AUTONOMOUS_STATUS_NUMBER_FORMAT = new Intl.NumberFormat("en-US");

const AUTONOMOUS_BUDGET_USAGE =
	"Usage: /autonomous [status|off] or /autonomous on [--max-continuations <n|unlimited>] [--max-turns <n|unlimited>] [--max-tokens <n|unlimited>] [--timeout-ms <n|unlimited>] [--gate <command>] [--gate-retries <n>] [--gate-timeout-ms <n>]";

// `/autonomous` budget flags mirror the `--autonomous-*` CLI options. The CLI
// spelling (`--autonomous-max-continuations`) is accepted as an alias so the
// exact CLI budget flags also work from the slash command.
const AUTONOMOUS_BUDGET_FLAGS: ReadonlySet<string> = new Set([
	"max-continuations",
	"max-turns",
	"max-tokens",
	"timeout-ms",
	"gate",
	"gate-retries",
	"gate-timeout-ms",
]);

function parseAutonomousBudgetInt(flag: string, value: string, allowUnlimited = false): number {
	if (allowUnlimited && value.toLowerCase() === "unlimited") {
		return UNLIMITED_AUTONOMOUS_LIMIT;
	}
	// Commas and underscores are accepted as digit separators (100,000,000).
	const digits = value.replace(/[,_]/g, "");
	if (!/^[1-9]\d*$/.test(digits)) {
		throw new Error(
			`--${flag} must be a positive integer${allowUnlimited ? ' or "unlimited"' : ""}. ${AUTONOMOUS_BUDGET_USAGE}`,
		);
	}
	return Number(digits);
}

function parseAutonomousBudgetOptions(tokens: string[]): AgentAutonomousConfig {
	const config: AgentAutonomousConfig = {};
	const gateCommands: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (!token.startsWith("--")) {
			throw new Error(`Unexpected autonomous argument: ${token}. ${AUTONOMOUS_BUDGET_USAGE}`);
		}
		const equalsIndex = token.indexOf("=");
		const rawFlag = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
		const inlineValue = equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);
		const flag = rawFlag.startsWith("--autonomous-") ? rawFlag.slice("--autonomous-".length) : rawFlag.slice(2);
		if (!AUTONOMOUS_BUDGET_FLAGS.has(flag)) {
			throw new Error(`Unknown autonomous budget flag: ${rawFlag}. ${AUTONOMOUS_BUDGET_USAGE}`);
		}
		let value = inlineValue;
		if (value === undefined) {
			const next = tokens[i + 1];
			if (next === undefined || next.startsWith("--")) {
				throw new Error(`Missing value for ${rawFlag}. ${AUTONOMOUS_BUDGET_USAGE}`);
			}
			value = next;
			i++;
		}
		if (value === "") {
			throw new Error(`Missing value for ${rawFlag}. ${AUTONOMOUS_BUDGET_USAGE}`);
		}
		switch (flag) {
			case "gate":
				gateCommands.push(value);
				break;
			case "gate-retries":
				config.gates = config.gates ?? {};
				config.gates.maxRetries = parseAutonomousBudgetInt(flag, value);
				break;
			case "gate-timeout-ms":
				config.gates = config.gates ?? {};
				config.gates.timeoutMs = parseAutonomousBudgetInt(flag, value);
				break;
			case "max-continuations":
				config.maxContinuations = parseAutonomousBudgetInt(flag, value, true);
				break;
			case "max-turns":
				config.maxTurns = parseAutonomousBudgetInt(flag, value, true);
				break;
			case "max-tokens":
				config.maxTokens = parseAutonomousBudgetInt(flag, value, true);
				break;
			case "timeout-ms":
				config.timeoutMs = parseAutonomousBudgetInt(flag, value, true);
				break;
		}
	}
	if (gateCommands.length > 0) {
		config.gates = { ...config.gates, commands: gateCommands };
	}
	// Named budget flags define the whole budget: any limit the user did not
	// name stops cutting the run short. With no budget flags at all, the
	// configured or default limits still apply.
	if (
		config.maxContinuations !== undefined ||
		config.maxTurns !== undefined ||
		config.maxTokens !== undefined ||
		config.timeoutMs !== undefined
	) {
		config.maxContinuations ??= UNLIMITED_AUTONOMOUS_LIMIT;
		config.maxTurns ??= UNLIMITED_AUTONOMOUS_LIMIT;
		config.maxTokens ??= UNLIMITED_AUTONOMOUS_LIMIT;
		config.timeoutMs ??= UNLIMITED_AUTONOMOUS_LIMIT;
	}
	return config;
}

export interface SessionAutonomousContinuationHost {
	getStatus(): AgentAutonomousStatus;
	getCwd(): string;
	getAgent(): Pick<Agent, "state" | "signal" | "removeQueuedMessages" | "hasQueuedMessages">;
	getStore(): Pick<SessionManager, "appendCustomMessageEntry">;
	emit(event: AgentSessionEvent): void;
	getContinuation(): Pick<SessionContinuation, "messages" | "track" | "remove">;
	getArrivalEpoch(): number;
	admit: SessionInputAdmission["admitSessionInput"];
	cancelActions(predicate: (action: QueuedSessionAction) => boolean, error: Error): QueuedSessionAction[];
	emitQueueUpdate(): void;
	getCompaction(): Pick<SessionCompaction, "resetContinuation">;
	getUnfinishedActionCount(): number;
	cancelContinuation(): void;
}
export class SessionAutonomousContinuation {
	private readonly state: AutonomousRuntimeState;
	private suppressionDepth = 0;
	private readonly suppressedMessages = new WeakSet<AgentMessage>();
	private readonly thresholdContinuations = new WeakMap<AssistantMessage, AgentMessage>();
	private readonly snapshots = new WeakMap<AgentMessage, AutonomousRuntimeSnapshot>();
	private pendingThresholdMessages: AgentMessage[] = [];
	constructor(
		config: AgentAutonomousConfig | undefined,
		private readonly host: SessionAutonomousContinuationHost,
	) {
		this.state = createAutonomousRuntimeState(config, { cwd: host.getCwd() });
	}
	forgetSnapshot(message: AgentMessage): void {
		this.snapshots.delete(message);
	}

	takePendingThresholdMessages(): AgentMessage[] {
		return this.pendingThresholdMessages.splice(0);
	}

	recordUsage(usage: Usage): void {
		addAutonomousUsage(this.state, usage);
	}
	isSuppressed(messages: AgentMessage[]): boolean {
		return this.suppressionDepth > 0 || messages.some((message) => this.suppressedMessages.has(message));
	}
	next(message: AssistantMessage, signal?: AbortSignal): Promise<AgentMessage | undefined> {
		return nextAutonomousContinuation(this.state, message, { cwd: this.host.getCwd(), signal });
	}

	parseAutonomousSlashCommand(text: string): AutonomousSlashCommand | undefined {
		const command = parseSessionSlashCommand(text);
		if (command?.name !== "autonomous") return undefined;
		const tokens = parseCommandArgs(command.args);
		if (tokens.length === 0 || tokens[0]!.toLowerCase() === "status") {
			if (tokens.length > 1) {
				throw new Error(`Unexpected autonomous argument: ${tokens[1]}. ${AUTONOMOUS_BUDGET_USAGE}`);
			}
			return { kind: "status" };
		}
		const subcommand = tokens[0]!.toLowerCase();
		if (subcommand === "on" || subcommand === "enable" || subcommand === "enabled") {
			return { kind: "on", config: parseAutonomousBudgetOptions(tokens.slice(1)) };
		}
		if (subcommand === "off" || subcommand === "disable" || subcommand === "disabled") {
			if (tokens.length > 1) {
				throw new Error(`Unexpected autonomous argument: ${tokens[1]}. ${AUTONOMOUS_BUDGET_USAGE}`);
			}
			return { kind: "off" };
		}
		throw new Error(AUTONOMOUS_BUDGET_USAGE);
	}

	formatAutonomousStatus(): string {
		const status = this.host.getStatus();
		const state = status.enabled ? "on" : "off";
		const elapsedSeconds = status.startedAt ? Math.round((Date.now() - status.startedAt) / 1000) : 0;
		const gateSummary =
			status.gates.commands.length > 0 ? status.gates.commands.map((command) => `"${command}"`).join(", ") : "none";
		const formatCount = (value: number): string =>
			isUnlimitedAutonomousLimit(value) ? "unlimited" : AUTONOMOUS_STATUS_NUMBER_FORMAT.format(value);
		const timeBudget = isUnlimitedAutonomousLimit(status.limits.timeoutMs)
			? "unlimited"
			: `${AUTONOMOUS_STATUS_NUMBER_FORMAT.format(Math.round(status.limits.timeoutMs / 1000))}s`;
		return `[autonomous-status: ${state}]\n\nContinuations: ${formatCount(status.continuationsUsed)}/${formatCount(status.limits.maxContinuations)}. Turns: ${formatCount(status.turnsUsed)}/${formatCount(status.limits.maxTurns)}. Tokens: ${formatCount(status.tokensUsed)}/${formatCount(status.limits.maxTokens)}. Time: ${elapsedSeconds}s/${timeBudget}. Gates: ${gateSummary}.`;
	}

	emitAutonomousStatus(): void {
		const message = {
			role: "custom" as const,
			customType: "autonomous_status",
			content: this.formatAutonomousStatus(),
			display: true,
			details: this.host.getStatus(),
			timestamp: Date.now(),
		} satisfies CustomMessage<AgentAutonomousStatus>;
		this.host.getAgent().state.messages.push(message);
		this.host
			.getStore()
			.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
		this.host.emit({ type: "message_start", message });
		this.host.emit({ type: "message_end", message });
	}

	async handleAutonomousSlashCommand(text: string): Promise<boolean> {
		const command = this.parseAutonomousSlashCommand(text);
		if (!command) {
			return false;
		}
		if (command.kind === "on") {
			setAutonomousEnabled(this.state, true, { cwd: this.host.getCwd() });
			setAutonomousLimits(this.state, command.config);
		} else if (command.kind === "off") {
			setAutonomousEnabled(this.state, false);
			this.clearQueuedAutonomousContinuations();
		}
		this.emitAutonomousStatus();
		return true;
	}

	snapshotAutonomousRuntimeState(): AutonomousRuntimeSnapshot {
		return {
			continuationsUsed: this.state.continuationsUsed,
			gateAttempts: { ...this.state.gateAttempts },
			lastGateFailure: this.state.lastGateFailure ? { ...this.state.lastGateFailure } : undefined,
			lastGateFailureSnapshot: this.state.lastGateFailureSnapshot
				? { ...this.state.lastGateFailureSnapshot }
				: undefined,
		};
	}

	restoreAutonomousRuntimeSnapshot(snapshot: AutonomousRuntimeSnapshot): void {
		this.state.continuationsUsed = snapshot.continuationsUsed;
		this.state.gateAttempts = { ...snapshot.gateAttempts };
		this.state.lastGateFailure = snapshot.lastGateFailure ? { ...snapshot.lastGateFailure } : undefined;
		this.state.lastGateFailureSnapshot = snapshot.lastGateFailureSnapshot
			? { ...snapshot.lastGateFailureSnapshot }
			: undefined;
	}

	async queueAutonomousContinuationForThresholdCompaction(
		message: AssistantMessage,
	): Promise<AgentMessage | undefined> {
		const queuedMessage = this.thresholdContinuations.get(message);
		if (queuedMessage && this.host.getContinuation().messages.includes(queuedMessage)) {
			return queuedMessage;
		}
		const snapshot = this.snapshotAutonomousRuntimeState();
		const arrivalEpoch = this.host.getArrivalEpoch();
		const autonomousMessage = await nextAutonomousContinuation(this.state, message, {
			cwd: this.host.getCwd(),
			signal: this.host.getAgent().signal,
		});
		if (!autonomousMessage) {
			return undefined;
		}
		if (this.host.getArrivalEpoch() !== arrivalEpoch) {
			this.restoreAutonomousRuntimeSnapshot(snapshot);
			return undefined;
		}
		this.thresholdContinuations.set(message, autonomousMessage);
		this.snapshots.set(autonomousMessage, snapshot);
		this.host.getContinuation().track(autonomousMessage);
		this.pendingThresholdMessages.push(autonomousMessage);
		const text =
			typeof autonomousMessage.content === "string"
				? autonomousMessage.content
				: autonomousMessage.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		this.host.admit(
			createPreparedTurnAction("followUp", text, undefined, {
				message: autonomousMessage,
			}),
		);
		return autonomousMessage;
	}

	clearQueuedAutonomousContinuations(
		options: { restoreAutonomousState?: boolean; messages?: AgentMessage[] } = {},
	): void {
		const requestedMessages = options.messages ?? [...this.host.getContinuation().messages];
		const requestedMessageSet = new Set(requestedMessages);
		const queuedMessages = this.host.getContinuation().messages.filter((message) => requestedMessageSet.has(message));
		if (queuedMessages.length === 0) {
			return;
		}
		const queuedMessageSet = new Set(queuedMessages);
		this.host.getContinuation().remove(queuedMessageSet);
		this.host.getAgent().removeQueuedMessages((message) => queuedMessageSet.has(message));
		this.host.cancelActions(
			(action) => action.payload.kind === "turn" && queuedMessageSet.has(primaryDeliveryRecord(action).message),
			new Error("Queued autonomous continuation was cleared before delivery."),
		);
		this.host.emitQueueUpdate();
		if (options.restoreAutonomousState) {
			for (const queuedMessage of queuedMessages) {
				const snapshot = this.snapshots.get(queuedMessage);
				if (snapshot) {
					this.restoreAutonomousRuntimeSnapshot(snapshot);
					break;
				}
			}
		}
		for (const queuedMessage of queuedMessages) {
			this.snapshots.delete(queuedMessage);
		}
		this.pendingThresholdMessages = this.pendingThresholdMessages.filter((message) => !queuedMessageSet.has(message));
		if (options.messages === undefined) {
			this.host.getCompaction().resetContinuation();
		}
		if (!this.host.getAgent().hasQueuedMessages() && this.host.getUnfinishedActionCount() === 0) {
			this.host.cancelContinuation();
		}
	}

	clearQueuedAutonomousContinuationsAfterSkippedThresholdCompaction(
		shouldContinueAfterThreshold: boolean,
		queuedMessages: AgentMessage[],
	): void {
		if (shouldContinueAfterThreshold) {
			this.clearQueuedAutonomousContinuations({
				restoreAutonomousState: true,
				messages: queuedMessages,
			});
		}
	}

	getAutonomousStatus(): AgentAutonomousStatus {
		return autonomousStatus(this.state);
	}

	recordHostAutonomousContinuation(): void {
		addAutonomousContinuation(this.state);
	}

	async refreshAutonomousGates(): Promise<void> {
		await refreshAutonomousQualityGates(this.state, {
			cwd: this.host.getCwd(),
		});
	}

	async runWithAutonomousContinuationSuppressed<T>(fn: () => Promise<T>): Promise<T> {
		this.suppressionDepth++;
		try {
			return await fn();
		} finally {
			this.suppressionDepth--;
		}
	}

	markAutonomousContinuationSuppressed(message: AgentMessage): void {
		this.suppressedMessages.add(message);
	}
}
