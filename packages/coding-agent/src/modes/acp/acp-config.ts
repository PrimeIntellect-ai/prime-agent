import { RequestError, type SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AgentConnection, AgentConnectionModel } from "../agent-connection/types.js";

function modelValue(model: AgentConnectionModel): string {
	return `${model.provider}/${model.id}`;
}

export class AcpSessionConfig {
	private tail: Promise<void> = Promise.resolve();
	private current: SessionConfigOption[] = [];
	private closed = false;
	private refreshPending = false;

	constructor(
		private readonly connection: AgentConnection,
		private readonly publish: (configOptions: SessionConfigOption[]) => Promise<boolean>,
	) {}

	async initialize(): Promise<SessionConfigOption[]> {
		this.current = await this.read();
		return this.current;
	}

	refresh(): Promise<void> {
		if (this.closed || this.refreshPending) return this.tail;
		this.refreshPending = true;
		return this.enqueue(async () => {
			this.refreshPending = false;
			if (!this.closed) await this.update();
		});
	}

	set(configId: string, value: string | boolean): Promise<SessionConfigOption[]> {
		return this.enqueue(async () => {
			this.assertOpen();
			const configOptions = await this.read();
			this.assertOpen();
			const option = configOptions.find((candidate) => candidate.id === configId);
			if (
				!option ||
				option.type !== "select" ||
				!option.options.some((candidate) => "value" in candidate && candidate.value === value)
			) {
				throw RequestError.invalidParams({ reason: `Invalid value for ACP config option ${configId}: ${value}` });
			}
			if (configId === "model") {
				const models = await this.connection.getAvailableModels();
				this.assertOpen();
				const model = models.find((candidate) => modelValue(candidate) === value);
				if (!model) throw RequestError.invalidParams({ reason: `Model is not available: ${value}` });
				await this.connection.setModel(model.provider, model.id);
			} else {
				const state = await this.connection.getState();
				this.assertOpen();
				const level = state.availableThinkingLevels.find((candidate) => candidate === value);
				if (!level) throw RequestError.invalidParams({ reason: `Reasoning level is not available: ${value}` });
				await this.connection.setThinkingLevel(level);
			}
			return this.update();
		});
	}

	async close(): Promise<void> {
		this.closed = true;
		await this.tail;
	}

	private assertOpen(): void {
		if (this.closed) throw RequestError.invalidParams({ reason: "ACP session configuration is closed" });
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.tail.then(operation);
		this.tail = result.then(
			() => {},
			() => {},
		);
		return result;
	}

	private async read(): Promise<SessionConfigOption[]> {
		let state = await this.connection.getState();
		if (!state.model) return [];
		const models = await this.connection.getAvailableModels();
		state = await this.connection.getState();
		if (!state.model) return [];
		const values = new Map(models.map((model) => [modelValue(model), model]));
		// Keep the current selection representable even if its credentials just expired.
		values.set(modelValue(state.model), state.model);
		const configOptions: SessionConfigOption[] = [
			{
				id: "model",
				name: "Model",
				category: "model",
				type: "select",
				currentValue: modelValue(state.model),
				options: [...values.values()].map((model) => ({
					value: modelValue(model),
					name: `${model.name} (${model.provider})`,
				})),
			},
		];
		if (state.availableThinkingLevels.length > 1) {
			configOptions.push({
				id: "thought_level",
				name: "Reasoning level",
				category: "thought_level",
				type: "select",
				currentValue: state.thinkingLevel,
				options: state.availableThinkingLevels.map((level) => ({ value: level, name: level })),
			});
		}
		return configOptions;
	}

	private async update(): Promise<SessionConfigOption[]> {
		const configOptions = await this.read();
		if (!this.closed && JSON.stringify(configOptions) !== JSON.stringify(this.current)) {
			if (await this.publish(configOptions)) this.current = configOptions;
		}
		return configOptions;
	}
}
