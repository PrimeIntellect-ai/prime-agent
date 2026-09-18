import { describe, expect, it } from "vitest";
import type { DaemonServerCapability } from "../src/modes/daemon/daemon-protocol.js";
import {
	DAEMON_COMMAND_COMPATIBILITY,
	DAEMON_COMMAND_PLANE,
	DAEMON_DEFAULT_SERVER_CAPABILITIES,
	DAEMON_OUTBOUND_COMPATIBILITY,
	DAEMON_PROTOCOL_VERSION,
	DAEMON_SCHEMA_ID,
	DAEMON_SCHEMA_REVISION,
	type DaemonCommand,
	type DaemonOutbound,
	isSessionPlaneDaemonCommand,
	meetsDaemonCommandCompatibility,
} from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";

/** The supervisor's summary validator checks id/sessionId/cwd only; mirror it. */
function isSessionSummaryLike(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { id?: unknown; sessionId?: unknown; cwd?: unknown };
	return (
		typeof candidate.id === "string" && typeof candidate.sessionId === "string" && typeof candidate.cwd === "string"
	);
}

/**
 * Wire compatibility for the resident cloud session surface (schema revision
 * 31): every addition is capability-gated, the legacy one-shot commands keep
 * their original gates for in-flight daemons, and both directions degrade
 * additively (a new client refuses the commands on an old daemon; an old
 * client never sees a new command or a required new field).
 */

const RESIDENT_COMMAND_TYPES = [
	"cloud_session_create",
	"cloud_session_list",
	"cloud_session_stop",
	"cloud_session_reprovision",
	"cloud_session_import_result",
	"cloud_spawn_child",
] as const;

const CLOUD_RESIDENT_SESSIONS_COMMAND_COMPATIBILITY = {
	minProtocol: 7,
	minSchemaRevision: 31,
	capability: "cloud_resident_sessions",
} as const;

function hello(options: { schemaRevision?: number; serverCapabilities?: readonly string[]; protocolVersion?: number }) {
	return {
		protocol: { name: "prime-agent.daemon" as const, version: options.protocolVersion ?? 7 },
		schemaRevision: options.schemaRevision,
		serverCapabilities: options.serverCapabilities?.map((capability) => capability as DaemonServerCapability),
	};
}

describe("resident cloud session wire compatibility (schema revision 31)", () => {
	it("publishes revision 31 with the cloud_resident_sessions capability", () => {
		expect(DAEMON_SCHEMA_REVISION).toBe(31);
		expect(DAEMON_SCHEMA_ID).toContain("protocol-7-schema-31");
		expect(DAEMON_PROTOCOL_VERSION).toBe(7);
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toContain("cloud_resident_sessions");
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toContain("cloud_sessions");
	});

	it("capability- and schema-gates every cloud_session_* command at revision 31", () => {
		for (const type of RESIDENT_COMMAND_TYPES) {
			expect(DAEMON_COMMAND_COMPATIBILITY[type]).toEqual(CLOUD_RESIDENT_SESSIONS_COMMAND_COMPATIBILITY);
		}
		expect(DAEMON_OUTBOUND_COMPATIBILITY.cloud_session_update).toEqual(CLOUD_RESIDENT_SESSIONS_COMMAND_COMPATIBILITY);
		const update: Extract<DaemonOutbound, { type: "cloud_session_update" }> = {
			type: "cloud_session_update",
			record: {
				sessionId: "sess_x",
				generation: 1,
				connectivity: "connected",
				status: "running",
				createdAt: "2026-09-18T00:00:00.000Z",
				updatedAt: "2026-09-18T00:00:00.000Z",
			},
		};
		expect(update.type).toBe("cloud_session_update");
	});

	it("new client to old daemon: the commands never leave the socket (additive degradation)", () => {
		const oldDaemonHello = hello({
			schemaRevision: 30,
			serverCapabilities: ["attach_snapshot", "event_sequence", "cloud_sessions", "cloud_tunnel"],
		});
		for (const type of RESIDENT_COMMAND_TYPES) {
			const command = { type } as DaemonCommand;
			const compatibility = DAEMON_COMMAND_COMPATIBILITY[command.type];
			expect(meetsDaemonCommandCompatibility(oldDaemonHello, compatibility)).toBe(false);
		}
		const eventCompatibility = DAEMON_OUTBOUND_COMPATIBILITY.cloud_session_update;
		expect(meetsDaemonCommandCompatibility(oldDaemonHello, eventCompatibility)).toBe(false);
	});

	it("old client to new daemon: the legacy one-shot commands keep their original gates", () => {
		// The pre-resident gates are unchanged so release N-1 TUIs keep their
		// /cloud run surface working against the new daemon during migration.
		expect(DAEMON_COMMAND_COMPATIBILITY.cloud_delegate).toEqual({
			minProtocol: 7,
			minSchemaRevision: 29,
			capability: "cloud_sessions",
		});
		expect(DAEMON_COMMAND_COMPATIBILITY.cloud_delegation_steer).toEqual({
			minProtocol: 7,
			minSchemaRevision: 30,
			capability: "cloud_tunnel",
		});
		const oldClientHello = hello({
			schemaRevision: 29,
			serverCapabilities: ["attach_snapshot", "event_sequence", "cloud_sessions"],
		});
		expect(meetsDaemonCommandCompatibility(oldClientHello, DAEMON_COMMAND_COMPATIBILITY.cloud_delegate)).toBe(true);
	});

	it("routes every cloud_session_* command through the supervisor control plane", () => {
		for (const type of RESIDENT_COMMAND_TYPES) {
			expect(DAEMON_COMMAND_PLANE[type]).toBe("control");
			expect(isSessionPlaneDaemonCommand(type)).toBe(false);
		}
	});

	it("keeps the execution marker optional on session summaries (local rows degrade to absent)", () => {
		const localSummary: SessionSummary = {
			id: "active-1",
			lifecycle: "live",
			activity: "idle",
			isSessionActive: false,
			sessionId: "sess_local",
			cwd: "/tmp",
			isStreaming: false,
			isCompacting: false,
			attachedClients: 0,
			messageCount: 1,
			sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		};
		expect(isSessionSummaryLike(localSummary)).toBe(true);
		const cloudSummary: SessionSummary = {
			...localSummary,
			execution: { location: "cloud", sandboxId: "sandbox-1", connectivity: "connected" },
		};
		expect(cloudSummary.execution?.connectivity).toBe("connected");
		expect(isSessionSummaryLike(cloudSummary)).toBe(true);
	});
});
