import { types } from "node:util";
import { createWebSocketUpgradeRequestAuth, type WebSocketUpgradeRequestAuthenticator } from "./sandbox-relay-auth.js";

const INPUT_KEYS = new Set(["admit", "grant", "path", "server", "setup", "timeouts"]);
const SERVER_KEYS = new Set(["close", "closed", "listen"]);
const SOCKET_KEYS = new Set(["close", "closed", "pause", "reject", "subscribeUpgrade", "upgrade"]);
const WS_KEYS = new Set(["close", "closed", "handle", "resume"]);
const SUBSCRIPTION_KEYS = new Set(["close"]);
const TIMEOUT_KEYS = new Set(["admissionMs", "closeMs", "setupMs", "upgradeMs"]);
const LISTEN_RESULT_KEYS = new Set(["host", "port", "status"]);
const STATUS_KEYS = new Set(["status"]);
const UPGRADE_RESULT_KEYS = new Set(["status", "webSocket"]);
const SETUP_RESULT_KEYS = new Set(["status", "subscription"]);
const AUTH_KEYS = new Set(["authenticate", "dispose", "status"]);
const AUTH_STATUS_KEYS = new Set(["status", "used"]);
const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 120_000;
const LOOPBACK_HOST = "127.0.0.1";
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;

type Descriptors = Readonly<Record<string, PropertyDescriptor>>;
type BoundMethod = (...args: readonly unknown[]) => unknown;
type Phase = "idle" | "listening" | "tcp" | "pending" | "upgrading" | "admitted" | "closing" | "closed";

type Observed =
	| Readonly<{ status: "fulfilled"; value: unknown }>
	| Readonly<{ status: "invalid" | "rejected" | "threw" | "timeout" }>;

export type SandboxRelayListenerFailureCode =
	| "ADMISSION_FAILED"
	| "ADMISSION_TIMEOUT"
	| "AUTH_FAILED"
	| "CLOSED"
	| "CLOSE_UNCONFIRMED"
	| "DUPLICATE_CONNECTION"
	| "DUPLICATE_UPGRADE"
	| "HEAD_INVALID"
	| "HEAD_NONEMPTY"
	| "INPUT_INVALID"
	| "LISTEN_FAILED"
	| "SETUP_FAILED"
	| "SETUP_TIMEOUT"
	| "TRANSPORT_FAILED"
	| "UPGRADE_TIMEOUT";

export type SandboxRelayListenerConnectedResult =
	| Readonly<{ ok: true }>
	| Readonly<{ ok: false; code: SandboxRelayListenerFailureCode }>;
export type SandboxRelayListenerCloseResult =
	| Readonly<{ ok: true }>
	| Readonly<{ ok: false; code: "CLOSE_UNCONFIRMED" }>;
export type SandboxRelayListenerStatus = Readonly<{
	phase: Phase;
	tcp: 0 | 1;
	pending: 0 | 1;
	upgraded: 0 | 1;
	admitted: 0 | 1;
	authenticated: boolean;
	headErased: boolean;
	poisoned: boolean;
}>;
export type SandboxRelayListenerCore = Readonly<{
	connected: Promise<SandboxRelayListenerConnectedResult>;
	close: () => Promise<SandboxRelayListenerCloseResult>;
	status: () => SandboxRelayListenerStatus;
}>;
export type StartSandboxRelayListenerCoreResult =
	| Readonly<{ ok: true; host: "127.0.0.1"; port: number; listener: SandboxRelayListenerCore }>
	| Readonly<{ ok: false; code: SandboxRelayListenerFailureCode; cleanupConfirmed: boolean }>;

interface BoundServer {
	readonly identity: object;
	readonly listen: BoundMethod;
	readonly close: BoundMethod;
	readonly closed: Promise<unknown>;
}
interface BoundSocket {
	readonly identity: object;
	readonly pause: BoundMethod;
	readonly reject: BoundMethod;
	readonly upgrade: BoundMethod;
	readonly subscribeUpgrade: BoundMethod;
	readonly close: BoundMethod;
	readonly closed: Promise<unknown>;
}
interface BoundWs {
	readonly identity: object;
	readonly handle: unknown;
	readonly resume: BoundMethod;
	readonly close: BoundMethod;
	readonly closed: Promise<unknown>;
}
interface BoundSubscription {
	readonly identity: object;
	readonly close: BoundMethod;
}
interface DiscoveredCloseOwner {
	readonly identity: object;
	readonly close: BoundMethod;
	readonly closed: Promise<unknown>;
}

interface BoundInput {
	readonly authenticate: BoundMethod;
	readonly disposeAuth: BoundMethod;
	readonly admit: BoundMethod;
	readonly setup: BoundMethod;
	readonly server: BoundServer;
	readonly timeouts: Readonly<{ admissionMs: number; closeMs: number; setupMs: number; upgradeMs: number }>;
}

function exact(raw: unknown, keys: ReadonlySet<string>): Descriptors | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (
			types.isProxy(raw) ||
			Object.getPrototypeOf(raw) !== Object.prototype ||
			Object.getOwnPropertySymbols(raw).length !== 0
		)
			return null;
		const descriptors = Object.getOwnPropertyDescriptors(raw);
		const names = Object.getOwnPropertyNames(descriptors);
		if (names.length !== keys.size || names.some((name) => !keys.has(name))) return null;
		for (const name of names) {
			const descriptor = descriptors[name];
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
		}
		return descriptors;
	} catch {
		return null;
	}
}

function ownDataValue(raw: unknown, name: string): unknown {
	if (typeof raw !== "object" || raw === null) return undefined;
	try {
		if (types.isProxy(raw)) return undefined;
		const descriptor = Object.getOwnPropertyDescriptor(raw, name);
		return descriptor && "value" in descriptor ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}

function bind(owner: object, descriptor: PropertyDescriptor | undefined): BoundMethod | null {
	if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") return null;
	try {
		if (types.isProxy(descriptor.value)) return null;
		const callable = descriptor.value as CallableFunction;
		return (...args: readonly unknown[]): unknown => Reflect.apply(callable, owner, args);
	} catch {
		return null;
	}
}

function isNativePromise(raw: unknown): raw is Promise<unknown> {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		return (
			!types.isProxy(raw) &&
			Object.getPrototypeOf(raw) === Promise.prototype &&
			Object.getOwnPropertyNames(raw).length === 0 &&
			Object.getOwnPropertySymbols(raw).length === 0
		);
	} catch {
		return false;
	}
}

function observe(raw: unknown, timeoutMs: number, late?: (value: unknown) => void): Promise<Observed> {
	if (!isNativePromise(raw)) return Promise.resolve(Object.freeze({ status: "invalid" as const }));
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			resolve(Object.freeze({ status: "timeout" as const }));
		}, timeoutMs);
		raw.then(
			(value) => {
				if (settled) {
					late?.(value);
					return;
				}
				settled = true;
				clearTimeout(timer);
				resolve(Object.freeze({ status: "fulfilled" as const, value }));
			},
			() => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(Object.freeze({ status: "rejected" as const }));
			},
		);
	});
}

function invoke(
	method: BoundMethod,
	args: readonly unknown[],
	timeoutMs: number,
	late?: (value: unknown) => void,
): Promise<Observed> {
	try {
		return observe(method(...args), timeoutMs, late);
	} catch {
		return Promise.resolve(Object.freeze({ status: "threw" as const }));
	}
}

function status(raw: unknown, accepted: ReadonlySet<string>): string | null {
	const found = exact(raw, STATUS_KEYS)?.status?.value;
	return typeof found === "string" && accepted.has(found) ? found : null;
}

function timeout(raw: unknown): number | null {
	return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= MIN_TIMEOUT_MS && raw <= MAX_TIMEOUT_MS
		? raw
		: null;
}

function acquireServer(raw: unknown): BoundServer | null {
	const found = exact(raw, SERVER_KEYS);
	if (!found || typeof raw !== "object" || raw === null) return null;
	const listen = bind(raw, found.listen);
	const close = bind(raw, found.close);
	const closed = found.closed?.value;
	return listen && close && isNativePromise(closed) ? Object.freeze({ identity: raw, listen, close, closed }) : null;
}

function acquireAuthenticator(raw: unknown): Readonly<{
	authenticator: WebSocketUpgradeRequestAuthenticator;
	authenticate: BoundMethod;
	dispose: BoundMethod;
}> | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (
			types.isProxy(raw) ||
			Object.getPrototypeOf(raw) !== Object.prototype ||
			Object.getOwnPropertySymbols(raw).length !== 0
		)
			return null;
		const found = Object.getOwnPropertyDescriptors(raw);
		const names = Object.getOwnPropertyNames(found);
		if (names.length !== AUTH_KEYS.size || names.some((name) => !AUTH_KEYS.has(name))) return null;
		const authenticate = bind(raw, found.authenticate);
		const dispose = bind(raw, found.dispose);
		const state = found.status;
		if (
			!authenticate ||
			!dispose ||
			!state ||
			typeof state.get !== "function" ||
			state.set !== undefined ||
			!state.enumerable
		)
			return null;
		const current = Reflect.apply(state.get, raw, []);
		const currentStatus = exact(current, AUTH_STATUS_KEYS);
		if (currentStatus?.status?.value !== "PENDING" || currentStatus.used?.value !== false) return null;
		return Object.freeze({ authenticator: raw as WebSocketUpgradeRequestAuthenticator, authenticate, dispose });
	} catch {
		return null;
	}
}

function acquireSocket(raw: unknown, identities: Set<object>, promises: Set<object>): BoundSocket | null {
	const found = exact(raw, SOCKET_KEYS);
	if (!found || typeof raw !== "object" || raw === null || identities.has(raw)) return null;
	const pause = bind(raw, found.pause);
	const reject = bind(raw, found.reject);
	const upgrade = bind(raw, found.upgrade);
	const subscribeUpgrade = bind(raw, found.subscribeUpgrade);
	const close = bind(raw, found.close);
	const closed = found.closed?.value;
	if (!pause || !reject || !upgrade || !subscribeUpgrade || !close || !isNativePromise(closed) || promises.has(closed))
		return null;
	identities.add(raw);
	promises.add(closed);
	return Object.freeze({ identity: raw, pause, reject, upgrade, subscribeUpgrade, close, closed });
}

function acquireWs(raw: unknown, identities: Set<object>, promises: Set<object>): BoundWs | null {
	const found = exact(raw, WS_KEYS);
	if (!found || typeof raw !== "object" || raw === null || identities.has(raw)) return null;
	const resume = bind(raw, found.resume);
	const close = bind(raw, found.close);
	const closed = found.closed?.value;
	if (!resume || !close || !isNativePromise(closed) || promises.has(closed)) return null;
	identities.add(raw);
	promises.add(closed);
	return Object.freeze({ identity: raw, handle: found.handle?.value, resume, close, closed });
}

function acquireSubscription(raw: unknown, identities: Set<object>): BoundSubscription | null {
	const found = exact(raw, SUBSCRIPTION_KEYS);
	if (!found || typeof raw !== "object" || raw === null || identities.has(raw)) return null;
	const close = bind(raw, found.close);
	if (!close) return null;
	identities.add(raw);
	return Object.freeze({ identity: raw, close });
}

function acquireDiscoveredCloseOwner(
	raw: unknown,
	identities: Set<object>,
	promises: Set<object>,
): DiscoveredCloseOwner | null {
	if (typeof raw !== "object" || raw === null || identities.has(raw)) return null;
	try {
		if (types.isProxy(raw)) return null;
		const close = bind(raw, Object.getOwnPropertyDescriptor(raw, "close"));
		const closed = ownDataValue(raw, "closed");
		if (!close || !isNativePromise(closed) || promises.has(closed)) return null;
		identities.add(raw);
		promises.add(closed);
		return Object.freeze({ identity: raw, close, closed });
	} catch {
		return null;
	}
}

function acquireDiscoveredSubscription(raw: unknown, identities: Set<object>): BoundSubscription | null {
	if (typeof raw !== "object" || raw === null || identities.has(raw)) return null;
	try {
		if (types.isProxy(raw)) return null;
		const close = bind(raw, Object.getOwnPropertyDescriptor(raw, "close"));
		if (!close) return null;
		identities.add(raw);
		return Object.freeze({ identity: raw, close });
	} catch {
		return null;
	}
}

function snapshotInput(raw: unknown): BoundInput | null {
	const found = exact(raw, INPUT_KEYS);
	const server = acquireServer(found?.server?.value);
	const admitRaw = found?.admit?.value;
	const setupRaw = found?.setup?.value;
	const timeoutFound = exact(found?.timeouts?.value, TIMEOUT_KEYS);
	const admissionMs = timeout(timeoutFound?.admissionMs?.value);
	const closeMs = timeout(timeoutFound?.closeMs?.value);
	const setupMs = timeout(timeoutFound?.setupMs?.value);
	const upgradeMs = timeout(timeoutFound?.upgradeMs?.value);
	if (
		!found ||
		!server ||
		typeof admitRaw !== "function" ||
		typeof setupRaw !== "function" ||
		admissionMs === null ||
		closeMs === null ||
		setupMs === null ||
		upgradeMs === null
	)
		return null;
	try {
		if (types.isProxy(admitRaw) || types.isProxy(setupRaw)) return null;
	} catch {
		return null;
	}
	const created = createWebSocketUpgradeRequestAuth(
		Object.freeze({
			grant: found.grant?.value,
			path: found.path?.value,
		}),
	);
	if (!created.ok) return null;
	const auth = acquireAuthenticator(created.authenticator);
	if (!auth) {
		created.authenticator.dispose();
		return null;
	}
	const inputOwner = raw as object;
	return Object.freeze({
		authenticate: auth.authenticate,
		disposeAuth: auth.dispose,
		admit: (...args: readonly unknown[]) => Reflect.apply(admitRaw as CallableFunction, inputOwner, args),
		setup: (...args: readonly unknown[]) => Reflect.apply(setupRaw as CallableFunction, inputOwner, args),
		server,
		timeouts: Object.freeze({ admissionMs, closeMs, setupMs, upgradeMs }),
	});
}

function connectedFailure(code: SandboxRelayListenerFailureCode): SandboxRelayListenerConnectedResult {
	return Object.freeze({ ok: false as const, code });
}

async function closeAction(method: BoundMethod, timeoutMs: number): Promise<boolean> {
	const observed = await invoke(method, [], timeoutMs);
	return observed.status === "fulfilled" && status(observed.value, new Set(["closed", "closing"])) !== null;
}

async function observedClosed(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
	const observed = await observe(promise, timeoutMs);
	return observed.status === "fulfilled" && status(observed.value, new Set(["closed"])) === "closed";
}

class ListenerCoreImplementation {
	private phase: Phase = "idle";
	private tcp: 0 | 1 = 0;
	private pending: 0 | 1 = 0;
	private upgraded: 0 | 1 = 0;
	private admitted: 0 | 1 = 0;
	private authenticated = false;
	private headErased = false;
	private poisoned = false;
	private cleanupUncertain = false;
	private authDisposed = false;
	private socket: BoundSocket | null = null;
	private socketClosed: Promise<unknown> | null = null;
	private socketConsumed = false;
	private ws: BoundWs | null = null;
	private upgradeSubscription: BoundSubscription | null = null;
	private handlerSubscription: BoundSubscription | null = null;
	private closePromise: Promise<SandboxRelayListenerCloseResult> | null = null;
	private readonly identities = new Set<object>();
	private readonly promises = new Set<object>();
	private readonly tasks = new Set<Promise<void>>();
	private resolveConnected!: (value: SandboxRelayListenerConnectedResult) => void;
	private connectedSettled = false;
	readonly connected: Promise<SandboxRelayListenerConnectedResult>;

	constructor(private readonly input: BoundInput) {
		this.identities.add(input.server.identity);
		this.promises.add(input.server.closed);
		this.connected = new Promise((resolve) => {
			this.resolveConnected = resolve;
		});
		this.track(
			input.server.closed.then(
				(value) => {
					if (status(value, new Set(["closed"])) !== "closed") this.cleanupUncertain = true;
					if (this.phase !== "closing" && this.phase !== "closed") this.beginFailure("TRANSPORT_FAILED");
				},
				() => {
					this.cleanupUncertain = true;
					if (this.phase !== "closing" && this.phase !== "closed") this.beginFailure("TRANSPORT_FAILED");
				},
			),
		);
	}

	private isClosing(): boolean {
		return this.phase === "closing" || this.phase === "closed";
	}

	private settleConnected(value: SandboxRelayListenerConnectedResult): void {
		if (this.connectedSettled) return;
		this.connectedSettled = true;
		this.resolveConnected(value);
	}

	private track(task: Promise<void>): void {
		this.tasks.add(task);
		task.then(
			() => this.tasks.delete(task),
			() => this.tasks.delete(task),
		);
	}

	private disposeAuth(): boolean {
		if (this.authDisposed) return true;
		this.authDisposed = true;
		try {
			this.input.disposeAuth();
			return true;
		} catch {
			return false;
		}
	}

	private async closeSubscription(owner: BoundSubscription | null): Promise<boolean> {
		if (!owner) return true;
		return await closeAction(owner.close, this.input.timeouts.closeMs);
	}

	private beginFailure(code: SandboxRelayListenerFailureCode): void {
		this.poisoned = true;
		this.settleConnected(connectedFailure(code));
		this.ensureClose();
	}

	private onTcp(raw: unknown): void {
		const acquired = acquireSocket(raw, this.identities, this.promises);
		if (!acquired) {
			if (!this.closeLateSocket(raw)) this.cleanupUncertain = true;
			this.beginFailure("TRANSPORT_FAILED");
			return;
		}
		if (this.phase !== "listening" || this.socket) {
			const task = (async () => {
				if (!(await closeAction(acquired.close, this.input.timeouts.closeMs))) this.cleanupUncertain = true;
				if (!(await observedClosed(acquired.closed, this.input.timeouts.closeMs))) this.cleanupUncertain = true;
			})();
			this.track(task);
			this.beginFailure("DUPLICATE_CONNECTION");
			return;
		}
		this.socket = acquired;
		this.socketClosed = acquired.closed;
		this.tcp = 1;
		this.phase = "tcp";
		this.track(
			acquired.closed.then(
				(value) => {
					if (status(value, new Set(["closed"])) !== "closed") this.cleanupUncertain = true;
					this.tcp = 0;
					if (this.phase !== "closing" && this.phase !== "closed") this.beginFailure("TRANSPORT_FAILED");
				},
				() => {
					this.cleanupUncertain = true;
					this.tcp = 0;
					if (this.phase !== "closing" && this.phase !== "closed") this.beginFailure("TRANSPORT_FAILED");
				},
			),
		);
		let subscribed: unknown;
		try {
			subscribed = acquired.subscribeUpgrade((request: unknown, head: unknown) => this.onUpgrade(request, head));
		} catch {
			this.beginFailure("TRANSPORT_FAILED");
			return;
		}
		const subscription = acquireSubscription(subscribed, this.identities);
		if (!subscription) {
			if (!this.closeLateSubscriptionOwner(subscribed)) this.cleanupUncertain = true;
			this.beginFailure("TRANSPORT_FAILED");
			return;
		}
		if (this.isClosing()) this.trackSubscriptionClose(subscription);
		else this.upgradeSubscription = subscription;
	}

	private onUpgrade(request: unknown, head: unknown): void {
		let authResult: unknown;
		try {
			authResult = this.input.authenticate(request);
		} catch {
			authResult = null;
		}
		const authDescriptors = exact(authResult, new Set(["code", "ok"]));
		const authOk = authDescriptors?.ok?.value === true && authDescriptors.code?.value === "AUTHENTICATED";
		const erased = eraseHead(head);
		if (!authOk) {
			this.beginFailure("AUTH_FAILED");
			return;
		}
		this.authenticated = true;
		if (!erased.ok) {
			this.beginFailure("HEAD_INVALID");
			return;
		}
		this.headErased = true;
		if (erased.length !== 0) {
			this.rejectSocket(400, "HEAD_NONEMPTY");
			return;
		}
		if (this.phase !== "tcp" || !this.socket || this.pending !== 0 || this.admitted !== 0) {
			this.rejectSocket(409, "DUPLICATE_UPGRADE");
			return;
		}
		let paused: unknown;
		try {
			paused = this.socket.pause();
		} catch {
			this.beginFailure("TRANSPORT_FAILED");
			return;
		}
		if (status(paused, new Set(["paused"])) !== "paused") {
			this.beginFailure("TRANSPORT_FAILED");
			return;
		}
		this.pending = 1;
		this.phase = "pending";
		let admitted: unknown;
		try {
			admitted = this.input.admit();
		} catch {
			this.pending = 0;
			this.beginFailure("ADMISSION_FAILED");
			return;
		}
		const task = this.completeAdmission(request, head, admitted);
		this.track(task);
	}

	private rejectSocket(httpStatus: number, code: SandboxRelayListenerFailureCode): void {
		const socket = this.socket;
		if (!socket || this.socketConsumed) {
			this.beginFailure(code);
			return;
		}
		this.socketConsumed = true;
		this.socket = null;
		let raw: unknown;
		try {
			raw = socket.reject(Object.freeze({ statusCode: httpStatus }));
		} catch {
			raw = null;
		}
		const task = (async () => {
			const result = await observe(raw, this.input.timeouts.closeMs);
			if (result.status !== "fulfilled" || status(result.value, new Set(["rejected", "closed"])) === null)
				this.cleanupUncertain = true;
		})();
		this.track(task);
		this.beginFailure(code);
	}

	private async completeAdmission(request: unknown, head: unknown, admitted: unknown): Promise<void> {
		const admission = await observe(admitted, this.input.timeouts.admissionMs);
		if (this.phase !== "pending" || this.poisoned) return;
		this.pending = 0;
		if (admission.status === "timeout") {
			this.beginFailure("ADMISSION_TIMEOUT");
			return;
		}
		if (admission.status !== "fulfilled" || status(admission.value, new Set(["admitted"])) !== "admitted") {
			this.beginFailure("ADMISSION_FAILED");
			return;
		}
		const socket = this.socket;
		if (!socket || this.socketConsumed) {
			this.beginFailure("TRANSPORT_FAILED");
			return;
		}
		this.phase = "upgrading";
		this.socketConsumed = true;
		this.socket = null;
		const upgraded = await invoke(
			socket.upgrade,
			[Object.freeze({ head, request })],
			this.input.timeouts.upgradeMs,
			(value) => {
				this.closeLateWs(value);
			},
		);
		if (this.phase !== "upgrading" || this.poisoned) {
			if (upgraded.status === "fulfilled") this.closeLateWs(upgraded.value);
			return;
		}
		if (upgraded.status === "timeout") {
			this.cleanupUncertain = true;
			this.beginFailure("UPGRADE_TIMEOUT");
			return;
		}
		if (upgraded.status !== "fulfilled") {
			this.beginFailure("TRANSPORT_FAILED");
			return;
		}
		const rawWs = ownDataValue(upgraded.value, "webSocket");
		const ws = acquireWs(rawWs, this.identities, this.promises);
		const result = exact(upgraded.value, UPGRADE_RESULT_KEYS);
		if (!result || result.status?.value !== "upgraded" || !ws) {
			if (ws) this.trackWsClose(ws);
			else if (!this.closeLateWs(upgraded.value)) this.cleanupUncertain = true;
			this.beginFailure("TRANSPORT_FAILED");
			return;
		}
		this.ws = ws;
		this.upgraded = 1;
		this.track(
			ws.closed.then(
				(value) => {
					if (status(value, new Set(["closed"])) !== "closed") this.cleanupUncertain = true;
					this.upgraded = 0;
					this.admitted = 0;
					if (this.phase !== "closing" && this.phase !== "closed") this.beginFailure("TRANSPORT_FAILED");
				},
				() => {
					this.cleanupUncertain = true;
					this.upgraded = 0;
					this.admitted = 0;
					if (this.phase !== "closing" && this.phase !== "closed") this.beginFailure("TRANSPORT_FAILED");
				},
			),
		);
		const setup = await invoke(
			this.input.setup,
			[Object.freeze({ webSocket: ws.handle })],
			this.input.timeouts.setupMs,
			(value) => {
				this.closeLateSubscription(value);
			},
		);
		if (this.phase !== "upgrading" || this.poisoned) {
			if (setup.status === "fulfilled") this.closeLateSubscription(setup.value);
			return;
		}
		if (setup.status === "timeout") {
			this.cleanupUncertain = true;
			this.beginFailure("SETUP_TIMEOUT");
			return;
		}
		if (setup.status !== "fulfilled") {
			this.beginFailure("SETUP_FAILED");
			return;
		}
		const rawSubscription = ownDataValue(setup.value, "subscription");
		const subscription = acquireSubscription(rawSubscription, this.identities);
		const setupResult = exact(setup.value, SETUP_RESULT_KEYS);
		if (!setupResult || setupResult.status?.value !== "ready" || !subscription) {
			if (subscription) this.trackSubscriptionClose(subscription);
			else if (!this.closeLateSubscription(setup.value)) this.cleanupUncertain = true;
			this.beginFailure("SETUP_FAILED");
			return;
		}
		this.handlerSubscription = subscription;
		let resumed: unknown;
		try {
			resumed = ws.resume();
		} catch {
			this.beginFailure("TRANSPORT_FAILED");
			return;
		}
		if (status(resumed, new Set(["resumed"])) !== "resumed") {
			this.beginFailure("TRANSPORT_FAILED");
			return;
		}
		this.upgraded = 0;
		this.admitted = 1;
		this.phase = "admitted";
		this.settleConnected(Object.freeze({ ok: true as const }));
	}

	private closeLateWs(raw: unknown): boolean {
		const rawWs = ownDataValue(raw, "webSocket");
		const ws = acquireWs(rawWs, this.identities, this.promises);
		if (!ws) return this.closeLateSocket(rawWs);
		this.trackWsClose(ws);
		return true;
	}

	private trackWsClose(ws: BoundWs): void {
		const task = (async () => {
			if (!(await closeAction(ws.close, this.input.timeouts.closeMs))) this.cleanupUncertain = true;
			if (!(await observedClosed(ws.closed, this.input.timeouts.closeMs))) this.cleanupUncertain = true;
		})();
		this.track(task);
	}

	private closeLateSubscription(raw: unknown): boolean {
		return this.closeLateSubscriptionOwner(ownDataValue(raw, "subscription"));
	}

	private closeLateSubscriptionOwner(raw: unknown): boolean {
		const subscription = acquireDiscoveredSubscription(raw, this.identities);
		if (!subscription) return false;
		this.trackSubscriptionClose(subscription);
		return true;
	}

	private trackSubscriptionClose(subscription: BoundSubscription): void {
		this.track(
			(async () => {
				if (!(await this.closeSubscription(subscription))) this.cleanupUncertain = true;
			})(),
		);
	}

	private closeLateSocket(raw: unknown): boolean {
		const owner = acquireDiscoveredCloseOwner(raw, this.identities, this.promises);
		if (!owner) return false;
		this.track(
			(async () => {
				if (!(await closeAction(owner.close, this.input.timeouts.closeMs))) this.cleanupUncertain = true;
				if (!(await observedClosed(owner.closed, this.input.timeouts.closeMs))) this.cleanupUncertain = true;
			})(),
		);
		return true;
	}

	private ensureClose(): Promise<SandboxRelayListenerCloseResult> {
		if (this.closePromise) return this.closePromise;
		this.phase = "closing";
		this.closePromise = this.closeAll();
		return this.closePromise;
	}

	private async closeAll(): Promise<SandboxRelayListenerCloseResult> {
		let certain = this.disposeAuth() && !this.cleanupUncertain;
		const upgradeSubscription = this.upgradeSubscription;
		this.upgradeSubscription = null;
		if (!(await this.closeSubscription(upgradeSubscription))) certain = false;
		const handlerSubscription = this.handlerSubscription;
		this.handlerSubscription = null;
		if (!(await this.closeSubscription(handlerSubscription))) certain = false;
		const ws = this.ws;
		this.ws = null;
		if (ws) {
			if (!(await closeAction(ws.close, this.input.timeouts.closeMs))) certain = false;
		}
		const socket = this.socket;
		const socketClosed = this.socketClosed;
		this.socket = null;
		this.socketClosed = null;
		if (socket && !this.socketConsumed) {
			this.socketConsumed = true;
			if (!(await closeAction(socket.close, this.input.timeouts.closeMs))) certain = false;
		}
		if (!(await closeAction(this.input.server.close, this.input.timeouts.closeMs))) certain = false;
		const observed: Promise<boolean>[] = [observedClosed(this.input.server.closed, this.input.timeouts.closeMs)];
		if (socketClosed) observed.push(observedClosed(socketClosed, this.input.timeouts.closeMs));
		if (ws) observed.push(observedClosed(ws.closed, this.input.timeouts.closeMs));
		if ((await Promise.all(observed)).some((value) => !value)) certain = false;
		for (let pass = 0; pass < 8; pass += 1) {
			const pendingTasks = [...this.tasks];
			if (pendingTasks.length === 0) break;
			const drained = await observe(
				Promise.all(pendingTasks).then(() => Object.freeze({ status: "closed" })),
				this.input.timeouts.closeMs,
			);
			if (drained.status !== "fulfilled") {
				certain = false;
				break;
			}
		}
		if (this.tasks.size > 0) certain = false;
		if (this.cleanupUncertain) certain = false;
		this.tcp = 0;
		this.pending = 0;
		this.upgraded = 0;
		this.admitted = 0;
		this.phase = "closed";
		if (!this.connectedSettled) this.settleConnected(connectedFailure("CLOSED"));
		return certain
			? Object.freeze({ ok: true as const })
			: Object.freeze({ ok: false as const, code: "CLOSE_UNCONFIRMED" as const });
	}

	status(): SandboxRelayListenerStatus {
		return Object.freeze({
			phase: this.phase,
			tcp: this.tcp,
			pending: this.pending,
			upgraded: this.upgraded,
			admitted: this.admitted,
			authenticated: this.authenticated,
			headErased: this.headErased,
			poisoned: this.poisoned,
		});
	}

	capability(): SandboxRelayListenerCore {
		return Object.freeze({ connected: this.connected, close: () => this.ensureClose(), status: () => this.status() });
	}

	async listen(): Promise<Readonly<{ ok: true; port: number }> | Readonly<{ ok: false }>> {
		this.phase = "listening";
		const request = Object.freeze({
			host: LOOPBACK_HOST,
			onDrop: () => this.beginFailure("DUPLICATE_CONNECTION"),
			onTcp: (raw: unknown) => this.onTcp(raw),
		});
		const observed = await invoke(this.input.server.listen, [request], this.input.timeouts.upgradeMs);
		if (observed.status !== "fulfilled") return Object.freeze({ ok: false as const });
		const result = exact(observed.value, LISTEN_RESULT_KEYS);
		const port = result?.port?.value;
		if (
			!result ||
			result.status?.value !== "listening" ||
			result.host?.value !== LOOPBACK_HOST ||
			typeof port !== "number" ||
			!Number.isSafeInteger(port) ||
			port < 1 ||
			port > 65_535 ||
			this.isClosing()
		)
			return Object.freeze({ ok: false as const });
		return Object.freeze({ ok: true as const, port });
	}
}

function eraseHead(raw: unknown): Readonly<{ ok: true; length: number }> | Readonly<{ ok: false }> {
	if (typeof raw !== "object" || raw === null) return Object.freeze({ ok: false as const });
	try {
		if (types.isProxy(raw) || !types.isUint8Array(raw) || !byteLengthGetter)
			return Object.freeze({ ok: false as const });
		const prototype = Object.getPrototypeOf(raw);
		if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype)
			return Object.freeze({ ok: false as const });
		const length = Reflect.apply(byteLengthGetter, raw, []) as unknown;
		if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0)
			return Object.freeze({ ok: false as const });
		Uint8Array.prototype.fill.call(raw, 0);
		return Object.freeze({ ok: true as const, length });
	} catch {
		return Object.freeze({ ok: false as const });
	}
}

function eraseDiscoveredGrant(rawGrant: unknown, rawPath: unknown): void {
	const created = createWebSocketUpgradeRequestAuth(Object.freeze({ grant: rawGrant, path: rawPath }));
	if (created.ok) created.authenticator.dispose();
}

async function discoverServerClose(raw: unknown, timeoutMs: number): Promise<boolean> {
	if (typeof raw !== "object" || raw === null) return true;
	try {
		if (types.isProxy(raw)) return false;
		const close = bind(raw, Object.getOwnPropertyDescriptor(raw, "close"));
		const closed = ownDataValue(raw, "closed");
		if (!close || !isNativePromise(closed)) return false;
		const action = await closeAction(close, timeoutMs);
		const observation = await observedClosed(closed, timeoutMs);
		return action && observation;
	} catch {
		return false;
	}
}

export async function startSandboxRelayListenerCore(raw: unknown): Promise<StartSandboxRelayListenerCoreResult> {
	const rawServer = ownDataValue(raw, "server");
	const rawGrant = ownDataValue(raw, "grant");
	const rawPath = ownDataValue(raw, "path");
	const input = snapshotInput(raw);
	if (!input) {
		eraseDiscoveredGrant(rawGrant, rawPath);
		const cleanupConfirmed = await discoverServerClose(rawServer, 5_000);
		return Object.freeze({ ok: false as const, code: "INPUT_INVALID" as const, cleanupConfirmed });
	}
	const implementation = new ListenerCoreImplementation(input);
	const listened = await implementation.listen();
	if (!listened.ok) {
		const closed = await implementation.capability().close();
		return Object.freeze({ ok: false as const, code: "LISTEN_FAILED" as const, cleanupConfirmed: closed.ok });
	}
	return Object.freeze({
		ok: true as const,
		host: LOOPBACK_HOST,
		port: listened.port,
		listener: implementation.capability(),
	});
}
