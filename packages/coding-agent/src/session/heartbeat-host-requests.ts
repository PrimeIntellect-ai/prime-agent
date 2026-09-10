import type { AgentCronJob, AgentRlmHeartbeatController, AgentRlmHeartbeatStatusUpdate } from "../core/cron-jobs.js";
import { normalizeHeartbeatDeliveryMode } from "../core/cron-jobs.js";

export function handleRlmHeartbeatHostRequest(
	controller: AgentRlmHeartbeatController | undefined,
	type: string,
	payload: Record<string, unknown> = {},
): Record<string, unknown> {
	if (!controller) {
		throw new Error("RLM heartbeat skill is not available in this session");
	}
	switch (type) {
		case "rlm_heartbeat.list": {
			const includeInactive = payload.include_inactive === true || payload.includeInactive === true;
			return {
				heartbeats: controller
					.listRlmHeartbeats({ includeInactive })
					.map((heartbeat) => rlmHeartbeatHostResponse(heartbeat)),
			};
		}
		case "rlm_heartbeat.create": {
			if (typeof payload.instruction !== "string") {
				throw new Error("rlm_heartbeat.create instruction must be a string");
			}
			if (payload.interval !== undefined && typeof payload.interval !== "string") {
				throw new Error("rlm_heartbeat.create interval must be a string when provided");
			}
			if (payload.label !== undefined && typeof payload.label !== "string") {
				throw new Error("rlm_heartbeat.create label must be a string when provided");
			}
			const deliveryMode = normalizeHeartbeatDeliveryMode(payload.delivery_mode ?? payload.deliveryMode);
			return {
				heartbeat: rlmHeartbeatHostResponse(
					controller.createRlmHeartbeat({
						instruction: payload.instruction,
						interval: payload.interval,
						label: payload.label,
						deliveryMode,
					}),
				),
			};
		}
		case "rlm_heartbeat.update": {
			if (typeof payload.id !== "string") {
				throw new Error("rlm_heartbeat.update id must be a string");
			}
			if (payload.instruction !== undefined && typeof payload.instruction !== "string") {
				throw new Error("rlm_heartbeat.update instruction must be a string when provided");
			}
			if (payload.interval !== undefined && typeof payload.interval !== "string") {
				throw new Error("rlm_heartbeat.update interval must be a string when provided");
			}
			if (payload.label !== undefined && typeof payload.label !== "string") {
				throw new Error("rlm_heartbeat.update label must be a string when provided");
			}
			if (payload.status !== undefined && !isRlmHeartbeatStatusUpdate(payload.status)) {
				throw new Error('rlm_heartbeat.update status must be "pause" or "resume" when provided');
			}
			const rawDeliveryMode = payload.delivery_mode ?? payload.deliveryMode;
			const deliveryMode = normalizeHeartbeatDeliveryMode(rawDeliveryMode);
			if (
				payload.instruction === undefined &&
				payload.interval === undefined &&
				payload.label === undefined &&
				payload.status === undefined &&
				rawDeliveryMode === undefined
			) {
				throw new Error("rlm_heartbeat.update requires at least one field to update");
			}
			const heartbeat = controller.updateRlmHeartbeat({
				id: payload.id,
				instruction: payload.instruction,
				interval: payload.interval,
				label: payload.label,
				status: payload.status,
				deliveryMode,
			});
			return {
				heartbeat: heartbeat ? rlmHeartbeatHostResponse(heartbeat) : null,
			};
		}
		case "rlm_heartbeat.delete": {
			if (typeof payload.id !== "string") {
				throw new Error("rlm_heartbeat.delete id must be a string");
			}
			const heartbeat = controller.deleteRlmHeartbeat(payload.id);
			return {
				heartbeat: heartbeat ? rlmHeartbeatHostResponse(heartbeat) : null,
			};
		}
		default:
			throw new Error(`unknown RLM heartbeat request type "${type}"`);
	}
}

function isRlmHeartbeatStatusUpdate(value: unknown): value is AgentRlmHeartbeatStatusUpdate {
	return value === "pause" || value === "resume";
}

function rlmHeartbeatHostResponse(job: AgentCronJob): Record<string, unknown> {
	return {
		id: job.id,
		status: job.status,
		label: job.label ?? null,
		delivery_mode: job.deliveryMode ?? "steer",
		instruction: job.prompt,
		schedule: job.schedule,
		created_at: job.createdAt,
		updated_at: job.updatedAt,
		next_run_at: job.nextRunAt ?? null,
		last_run_at: job.lastRunAt ?? null,
		last_error: job.lastError ?? null,
		run_count: job.runCount,
	};
}
