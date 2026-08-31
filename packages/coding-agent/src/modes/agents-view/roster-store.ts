import type { AgentRosterEntry } from "../daemon/agent-roster.js";
import { sessionSummaryFromRosterEntry } from "../daemon/agent-roster.js";
import type { DaemonClient, DaemonHello } from "../daemon/daemon-client.js";
import type { DaemonOutbound } from "../daemon/daemon-protocol.js";
import type { SessionSummary } from "../daemon/daemon-session-list.js";

export const STALE_ROSTER_DAEMON_MESSAGE =
	"Daemon is stale: it does not advertise the agent_roster capability; restart the daemon";

export class AgentsViewRosterStore {
	private readonly entries = new Map<string, AgentRosterEntry>();
	private readonly listeners = new Set<() => void>();
	private client: DaemonClient | undefined;
	private unsubscribeMessage: (() => void) | undefined;
	private emitScheduled = false;
	private subscribed = false;
	private subscribedHello: DaemonHello | undefined;
	private attachChain: Promise<unknown> = Promise.resolve();

	async attach(client: DaemonClient): Promise<boolean> {
		// Serialized: a stale attempt settling late must not detach a newer subscription's listener.
		const run = () => this.attachToClient(client);
		const chained = this.attachChain.then(run, run);
		this.attachChain = chained;
		return chained;
	}

	private async attachToClient(client: DaemonClient): Promise<boolean> {
		if (client.isConnected && client.hello === undefined) await client.waitForHello();
		if (!client.supportsServerCapability("agent_roster")) {
			this.detachFromClient();
			return false;
		}
		const hello = client.hello;
		if (this.subscribed && this.client === client && client.isConnected && hello === this.subscribedHello) {
			return true;
		}
		this.detachFromClient();
		this.client = client;
		// Pushes racing the subscribe reply buffer until the snapshot lands.
		let pendingUpdates: Extract<DaemonOutbound, { type: "roster_update" }>[] | undefined = [];
		this.unsubscribeMessage = client.onMessage((message) => {
			if (message.type !== "roster_update") return;
			if (pendingUpdates) pendingUpdates.push(message);
			else this.applyUpdate(message.changed, message.removed, message.resync);
		});
		let response: Awaited<ReturnType<DaemonClient["request"]>>;
		try {
			// Not parkable: the awaiting reconnect loop must see a close as a rejection.
			response = await client.request({ type: "roster_subscribe" }, 30000, { recoverable: false });
		} catch (error) {
			this.detachFromClient();
			throw error;
		}
		if (!response.success || typeof response.data !== "object" || response.data === null) {
			this.detachFromClient();
			throw new Error(
				`roster_subscribe failed: ${response.success ? "invalid roster payload" : (response.error ?? "unknown error")}`,
			);
		}
		const roster = (response.data as { roster?: AgentRosterEntry[] }).roster ?? [];
		this.applyUpdate(roster, undefined, true);
		for (const update of pendingUpdates ?? []) {
			this.applyUpdate(update.changed, update.removed, update.resync);
		}
		pendingUpdates = undefined;
		this.subscribed = true;
		this.subscribedHello = hello;
		return true;
	}

	private applyUpdate(changed: AgentRosterEntry[], removed?: string[], resync?: true): void {
		if (resync) this.entries.clear();
		for (const entry of changed) {
			this.entries.set(entry.agentId, entry);
		}
		for (const agentId of removed ?? []) {
			this.entries.delete(agentId);
		}
		this.scheduleEmit();
	}

	summaries(): SessionSummary[] {
		return [...this.entries.values()].map((entry) => sessionSummaryFromRosterEntry(entry));
	}

	onUpdate(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private scheduleEmit(): void {
		if (this.emitScheduled) return;
		this.emitScheduled = true;
		queueMicrotask(() => {
			this.emitScheduled = false;
			for (const listener of [...this.listeners]) {
				try {
					listener();
				} catch {
					// One consumer must not interrupt delivery to the others.
				}
			}
		});
	}

	private detachFromClient(): void {
		this.unsubscribeMessage?.();
		this.unsubscribeMessage = undefined;
		this.subscribed = false;
		this.subscribedHello = undefined;
		this.client = undefined;
	}

	async dispose(): Promise<void> {
		const run = () => this.disposeNow();
		const chained = this.attachChain.then(run, run);
		this.attachChain = chained;
		return chained;
	}

	private disposeNow(): void {
		const client = this.client;
		this.detachFromClient();
		this.listeners.clear();
		// Fire-and-forget: nobody needs the ack, and a closed socket already unsubscribed.
		if (client?.isConnected) {
			void client.request({ type: "roster_unsubscribe" }).catch(() => undefined);
		}
	}
}
