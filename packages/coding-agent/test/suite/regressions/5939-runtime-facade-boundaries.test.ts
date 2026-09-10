import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.js";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import type { ExtensionAPI } from "../../../src/core/extensions/index.js";
import { createDeferred, type HostRequestHandlers } from "../../../src/core/kernel/index.js";
import { ModelRegistry } from "../../../src/core/model-registry.js";
import { createSyntheticSourceInfo } from "../../../src/core/source-info.js";
import { IpythonKernelProvisioner } from "../../../src/core/tools/ipython.js";
import { createHarness, type Harness } from "../harness.js";

describe("ENG-5939 runtime facade boundaries", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		for (const harness of harnesses.splice(0)) {
			await harness.session.disposeAsync();
			harness.cleanup();
		}
	});

	it("retains the session receiver for extension shutdown after partial binding and reload", async () => {
		let shutdown = () => {};
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						shutdown = () => ctx.shutdown();
					});
				},
			],
		});
		harnesses.push(harness);
		const receivers: AgentSession[] = [];
		await harness.session.bindExtensions({
			shutdownHandler: function (this: AgentSession) {
				receivers.push(this);
				this.setActiveToolsByName([]);
			},
		});
		shutdown();
		await harness.session.bindExtensions({ onError: () => {} });
		shutdown();
		await harness.session.reload();
		shutdown();
		expect(receivers).toEqual([harness.session, harness.session, harness.session]);
	});

	it("reads current public template and registry getters from extension actions", async () => {
		let api!: ExtensionAPI;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					api = pi;
				},
			],
		});
		harnesses.push(harness);
		const templates = vi.spyOn(harness.session, "promptTemplates", "get").mockReturnValue([
			{
				name: "intercepted-template",
				description: "live public template",
				content: "template",
				filePath: "/templates/intercepted.md",
				sourceInfo: createSyntheticSourceInfo("<test:template>", { source: "test" }),
			},
		]);
		expect(api.getCommands()).toContainEqual(
			expect.objectContaining({ name: "intercepted-template", source: "prompt" }),
		);
		expect(templates.mock.contexts).toEqual([harness.session]);
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		const auth = vi.spyOn(registry, "hasConfiguredAuth").mockReturnValue(false);
		vi.spyOn(harness.session, "modelRegistry", "get").mockReturnValue(registry);
		await expect(api.setModel(harness.models[0])).resolves.toBe(false);
		expect(auth.mock.contexts).toEqual([registry]);
	});

	it("settles a no-op ACP release before work queued by its caller", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const order: string[] = [];
		const released = harness.session.releaseAcpMcpServers("missing-owner", []);
		void released.then(() => {
			order.push("released");
		});
		queueMicrotask(() => {
			order.push("caller");
		});
		await released;
		expect(order).toEqual(["released", "caller"]);
	});

	it("runs disposal callbacks at the kernel completion boundary", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const kernel = createDeferred<void>();
		const order: string[] = [];
		vi.spyOn(IpythonKernelProvisioner.prototype, "dispose").mockImplementation(() => {
			order.push("kernel");
			return kernel.promise;
		});
		harness.session.registerDisposeCallback(() => {
			order.push("callback");
		});
		const lifecycle = harness.session as unknown as { _disposeAsyncOnce(snapshot: boolean): Promise<void> };
		const disposed = lifecycle._disposeAsyncOnce(false);
		order.push("caller");
		expect(order).toEqual(["kernel", "caller"]);
		kernel.resolve();
		queueMicrotask(() => {
			order.push("after-kernel");
		});
		await disposed;
		expect(order).toEqual(["kernel", "caller", "callback", "after-kernel"]);
	});

	it("acknowledges bash completion without delaying work after message admission", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const admitted = createDeferred<void>();
		const lifecycle = harness.session as unknown as {
			_promptInjectedMessage(): Promise<void>;
			_createKernelHostHandlers(): HostRequestHandlers;
		};
		vi.spyOn(lifecycle, "_promptInjectedMessage").mockReturnValue(admitted.promise);
		const order: string[] = [];
		const completed = lifecycle._createKernelHostHandlers()["bash.completed"]!({
			pid: 123,
			command: "echo ready",
			exitCode: 0,
		});
		void completed.then(() => {
			order.push("acknowledged");
		});
		admitted.resolve();
		queueMicrotask(() => {
			order.push("first");
			queueMicrotask(() => {
				order.push("second");
				queueMicrotask(() => {
					order.push("third");
				});
			});
		});
		await completed;
		await Promise.resolve();
		expect(order).toEqual(["first", "second", "acknowledged", "third"]);
	});
});
