import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	assertAgentMessageQueueCapacity,
	DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION,
	isAgentSessionMessage,
} from "../../core/agent-messages.js";
import type { InputSource } from "../../core/extensions/index.js";
import type { ActionStore, ActionTicket } from "../../core/session-action-store.js";
import type { CustomMessage } from "../context/messages.js";
import {
	createPreparedTurnAction,
	primaryDeliveryRecord,
	type QueuedAgentMessage,
	type QueuedSessionAction,
	SessionInputAdmissionPausedError,
	type SessionInputSchedule,
} from "../prepared-actions.js";
import type { SessionInputScheduler } from "./input-scheduler.js";

export interface SessionInputAdmissionHost {
	getScheduler(): Pick<SessionInputScheduler, "admissionPaused" | "suspended">;
	isDisposed(): boolean;
	isDisposing(): boolean;
	isStreaming(): boolean;
	rejectAgentMessage(id: string | undefined, error: Error): void;
	emitQueueUpdate(): void;
	resumeAdmission(): void;
	scheduleInput(): void;
	suppressForMessage(message: AgentMessage): void;
}
export class SessionInputAdmission {
	private _arrivalEpoch: number = 0;
	get arrivalEpoch(): number {
		return this._arrivalEpoch;
	}
	constructor(
		private readonly actions: ActionStore<QueuedSessionAction>,
		private readonly host: SessionInputAdmissionHost,
	) {}
	coalescedFollowUpOwner(action: QueuedSessionAction): QueuedSessionAction | undefined {
		if (action.delivery !== "when_run_idle" || action.payload.kind !== "turn" || !action.queueKey) return undefined;
		return this.actions
			.unfinishedActions()
			.find(
				(candidate) =>
					candidate.queueKey === action.queueKey &&
					(candidate.lifecycle.state === "queued" ||
						candidate.lifecycle.state === "selected" ||
						candidate.lifecycle.state === "preparing"),
			);
	}

	assertSessionActionAdmissionAvailable(): void {
		if (this.host.isDisposed() || this.host.isDisposing()) {
			throw new Error("Cannot admit a session action because the session is disposing or disposed.");
		}
		if (this.host.getScheduler().admissionPaused) {
			throw new SessionInputAdmissionPausedError(
				"Cannot admit a session action while session input admission is paused.",
			);
		}
		if (this.host.getScheduler().suspended) {
			throw new Error("Cannot admit a session action while queued session input is suspended.");
		}
	}

	admitSessionInput(
		action: QueuedSessionAction,
		options: {
			restore?: boolean;
			front?: boolean;
			wake?: boolean;
			immediatelyEligible?: boolean;
		} = {},
	): {
		accepted: boolean;
		disposition: "starts_when_admitted" | "queued";
		ticket?: ActionTicket;
	} {
		if (this.host.isDisposed() || this.host.isDisposing()) {
			throw new Error("Cannot admit a session action because the session is disposing or disposed.");
		}
		if (this.host.getScheduler().admissionPaused) {
			throw new SessionInputAdmissionPausedError(
				"Cannot admit a session action while session input admission is paused.",
			);
		}
		if (
			options.restore !== true &&
			action.payload.kind === "turn" &&
			isAgentSessionMessage(primaryDeliveryRecord(action).message)
		) {
			assertAgentMessageQueueCapacity(
				this.actions.unfinishedActions().length,
				DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION,
			);
		}
		const coalescedOwner = options.restore ? undefined : this.coalescedFollowUpOwner(action);
		if (coalescedOwner) {
			if (action.agentMessageId !== coalescedOwner.agentMessageId) {
				this.host.rejectAgentMessage(
					action.agentMessageId,
					new Error("Prompt was not queued because an equivalent follow-up is already pending."),
				);
			}
			return { accepted: false, disposition: "queued" };
		}
		const canStartImmediately =
			options.immediatelyEligible === true &&
			(this.actions.unfinishedActions().length === 0 || options.front === true);
		if (options.front) this.actions.enqueueFront(action);
		else this.actions.enqueue(action);
		let disposition: "starts_when_admitted" | "queued" = "queued";
		if (canStartImmediately && this.actions.selectFirst() === action) disposition = "starts_when_admitted";
		const controller = this.actions.ticketFor(action);
		controller.settleAccepted({
			status: "accepted",
			actionId: action.id,
			disposition,
		});
		this._arrivalEpoch++;
		this.host.emitQueueUpdate();
		if (
			!options.restore &&
			options.wake !== false &&
			(disposition === "starts_when_admitted" ||
				(action.delivery === "next_turn_boundary" && this.host.isStreaming()) ||
				action.payload.kind === "session_command" ||
				action.wake === "immediate")
		) {
			if (action.payload.kind === "turn" && action.wake === "immediate") {
				this.host.resumeAdmission();
			}
			this.host.scheduleInput();
		}
		return { accepted: true, disposition, ticket: controller.ticket };
	}

	async queuePreparedPrompt(
		schedule: SessionInputSchedule,
		text: string,
		images?: ImageContent[],
		options: {
			agentMessageId?: string;
			queueKey?: string;
			content?: (TextContent | ImageContent)[];
			message?: QueuedAgentMessage;
			prefixMessages?: CustomMessage[];
			previewLabel?: string;
			suppressAutonomousContinuation?: boolean;
			resumeIfIdle?: boolean;
			source?: InputSource | "internal";
		} = {},
	): Promise<boolean> {
		const action = createPreparedTurnAction(schedule, text, images, options);
		if (action.suppressAutonomousContinuation) {
			this.host.suppressForMessage(primaryDeliveryRecord(action).message);
		}
		return this.admitSessionInput(action).accepted;
	}
}
