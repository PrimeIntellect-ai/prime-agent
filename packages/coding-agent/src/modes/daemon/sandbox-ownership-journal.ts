import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readdir } from "node:fs/promises";
import process from "node:process";
import {
	type Clock,
	createSandboxLifecycle,
	type DelayFn,
	type DeleteProof,
	type LifecycleConfig,
	type ProofConsumer,
	type RunCommand,
	type SandboxLifecycle,
} from "./sandbox/prime-sandbox-lifecycle.js";
import {
	createPreAdmitOwnershipRecord,
	decideNonDeletedOwnershipTransition,
	decodeOwnershipRecord,
	type NonDeletedTransitionStage,
	type OwnershipIntent,
	type OwnershipRecord,
	type ValidatedOwnershipChain,
	validateOwnershipChain,
} from "./sandbox-ownership-record.js";

// ── Constants ──────────────────────────────────────────────

const J_DIR = ".sandbox-ownership";
const MAX_REC = 6;
const REC_RE = /^000[1-6]\.ownership-v1$/;
const D_MODE = 0o700;
const F_MODE = 0o600;
const MAX_SZ = 4096;
const MAX_ROOT_BYTES = 4096;

// ── Public types ───────────────────────────────────────────

export type OwnershipJournalCode =
	| "INPUT_INVALID"
	| "CONFLICT"
	| "DIRECTORY_UNSAFE"
	| "CORRUPT"
	| "IO_UNCERTAIN"
	| "INVALID_TRANSITION";

export type JournalResult = Readonly<
	{ ok: true; value: Readonly<{ chain: ValidatedOwnershipChain }> } | { ok: false; code: OwnershipJournalCode }
>;

export interface OwnershipJournal {
	readonly admit: (intent: OwnershipIntent, recordedAt: string) => Promise<JournalResult>;
	readonly recover: () => Promise<JournalResult>;
	readonly transition: (
		target: NonDeletedTransitionStage,
		intent: OwnershipIntent,
		recordedAt: string,
	) => Promise<JournalResult>;
}

// ── Internal helpers ───────────────────────────────────────

function fc(c: OwnershipJournalCode): { ok: false; code: OwnershipJournalCode } {
	return Object.freeze({ ok: false, code: c });
}

function rp(d: string, s: number): string {
	return `${d}/000${s}.ownership-v1`;
}

function ev(b: Uint8Array): boolean {
	b.fill(0);
	for (let i = 0; i < b.length; i++) if (b[i] !== 0) return false;
	return true;
}

async function cl(fd: FileHandle | undefined): Promise<"ok" | { ok: false; code: OwnershipJournalCode }> {
	if (!fd) return "ok";
	try {
		await fd.close();
		return "ok";
	} catch {
		return fc("IO_UNCERTAIN");
	}
}

function recEq(a: OwnershipRecord, b: OwnershipRecord): boolean {
	return (
		a.version === b.version &&
		a.sequence === b.sequence &&
		a.stage === b.stage &&
		a.lifecycleKey === b.lifecycleKey &&
		a.parentSessionId === b.parentSessionId &&
		a.childSessionId === b.childSessionId &&
		a.recordedAt === b.recordedAt &&
		a.previousDigest === b.previousDigest &&
		a.contentDigest === b.contentDigest
	);
}

async function oD(
	u: number,
	p: string,
	eD: number,
	eI: number,
): Promise<{ ok: true; fd: FileHandle } | { ok: false; code: OwnershipJournalCode }> {
	let fd: FileHandle;
	try {
		fd = await open(p, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	} catch {
		return fc("DIRECTORY_UNSAFE");
	}
	let st: Awaited<ReturnType<FileHandle["stat"]>>;
	try {
		st = await fd.stat();
	} catch {
		const r = await cl(fd);
		return r === "ok" ? fc("DIRECTORY_UNSAFE") : r;
	}
	if (st.uid !== u || !st.isDirectory() || (st.mode & 0o7777) !== D_MODE || st.dev !== eD || st.ino !== eI) {
		const r = await cl(fd);
		return r === "ok" ? fc("DIRECTORY_UNSAFE") : r;
	}
	return { ok: true, fd };
}

async function sD(
	u: number,
	p: string,
	eD: number,
	eI: number,
): Promise<"ok" | { ok: false; code: OwnershipJournalCode }> {
	const d = await oD(u, p, eD, eI);
	if (!d.ok) return d;
	try {
		await d.fd.sync();
	} catch {
		const r = await cl(d.fd);
		return r === "ok" ? fc("IO_UNCERTAIN") : r;
	}
	let st: Awaited<ReturnType<FileHandle["stat"]>>;
	try {
		st = await d.fd.stat();
	} catch {
		const r = await cl(d.fd);
		return r === "ok" ? fc("DIRECTORY_UNSAFE") : r;
	}
	if (st.uid !== u || !st.isDirectory() || (st.mode & 0o7777) !== D_MODE || st.dev !== eD || st.ino !== eI) {
		const r = await cl(d.fd);
		return r === "ok" ? fc("DIRECTORY_UNSAFE") : r;
	}
	return cl(d.fd);
}

async function rRec(
	u: number,
	p: string,
): Promise<{ ok: true; record: OwnershipRecord } | { ok: false; code: OwnershipJournalCode }> {
	let ls: Awaited<ReturnType<typeof lstat>>;
	try {
		ls = await lstat(p);
	} catch {
		return fc("CORRUPT");
	}
	if (ls.isSymbolicLink() || !ls.isFile()) return fc("CORRUPT");
	if (ls.uid !== u) return fc("CORRUPT");
	if ((ls.mode & 0o7777) !== F_MODE) return fc("CORRUPT");
	if (ls.nlink !== 1) return fc("CORRUPT");
	if (ls.size < 1 || ls.size > MAX_SZ) return fc("CORRUPT");
	const eD = ls.dev,
		eI = ls.ino,
		fS = ls.size;

	let fd: FileHandle;
	try {
		fd = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch {
		return fc("CORRUPT");
	}
	let os: Awaited<ReturnType<FileHandle["stat"]>>;
	try {
		os = await fd.stat();
	} catch {
		const r = await cl(fd);
		return r === "ok" ? fc("IO_UNCERTAIN") : r;
	}
	if (
		os.uid !== u ||
		!os.isFile() ||
		(os.mode & 0o7777) !== F_MODE ||
		os.nlink !== 1 ||
		os.dev !== eD ||
		os.ino !== eI ||
		os.size !== fS
	) {
		const r = await cl(fd);
		return r === "ok" ? fc("CORRUPT") : r;
	}

	const buf = new Uint8Array(fS);
	let pos: number = 0;
	while (pos < fS) {
		let rr: { bytesRead: number; buffer: Uint8Array };
		try {
			rr = await fd.read(buf, pos, fS - pos, pos);
		} catch {
			ev(buf);
			const r = await cl(fd);
			return r === "ok" ? fc("IO_UNCERTAIN") : r;
		}
		if (
			typeof rr !== "object" ||
			!rr ||
			typeof rr.bytesRead !== "number" ||
			!Number.isFinite(rr.bytesRead) ||
			rr.bytesRead <= 0 ||
			rr.bytesRead > fS - pos
		) {
			ev(buf);
			const r = await cl(fd);
			return r === "ok" ? fc("IO_UNCERTAIN") : r;
		}
		pos += rr.bytesRead;
	}
	const eB = new Uint8Array(1);
	let eof: { bytesRead: number; buffer: Uint8Array };
	try {
		eof = await fd.read(eB, 0, 1, fS);
	} catch {
		ev(buf);
		ev(eB);
		const r = await cl(fd);
		return r === "ok" ? fc("IO_UNCERTAIN") : r;
	}
	if (typeof eof !== "object" || !eof || typeof eof.bytesRead !== "number" || eof.bytesRead !== 0) {
		ev(buf);
		ev(eB);
		const r = await cl(fd);
		return r === "ok" ? fc("CORRUPT") : r;
	}
	ev(eB);
	let af: Awaited<ReturnType<FileHandle["stat"]>>;
	try {
		af = await fd.stat();
	} catch {
		ev(buf);
		const r = await cl(fd);
		return r === "ok" ? fc("IO_UNCERTAIN") : r;
	}
	if (
		af.uid !== u ||
		!af.isFile() ||
		(af.mode & 0o7777) !== F_MODE ||
		af.nlink !== 1 ||
		af.dev !== eD ||
		af.ino !== eI ||
		af.size !== fS
	) {
		ev(buf);
		const r = await cl(fd);
		return r === "ok" ? fc("CORRUPT") : r;
	}
	const cr = await cl(fd);
	if (cr !== "ok") {
		ev(buf);
		return cr;
	}
	const dd = decodeOwnershipRecord(buf);
	if (!dd.ok) return fc("CORRUPT");
	return { ok: true, record: dd.value };
}

async function pRec(
	u: number,
	p: string,
	b: Uint8Array,
	exp: OwnershipRecord,
	jD: string,
	jDv: number,
	jIn: number,
	rD: string,
	rDv: number,
	rIn: number,
): Promise<{ ok: true } | { ok: false; code: OwnershipJournalCode }> {
	let wf: FileHandle;
	try {
		wf = await open(p, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, F_MODE);
	} catch {
		ev(b);
		return fc("IO_UNCERTAIN");
	}
	let cs: Awaited<ReturnType<FileHandle["stat"]>>;
	try {
		cs = await wf.stat();
	} catch {
		ev(b);
		const r = await cl(wf);
		return r === "ok" ? fc("IO_UNCERTAIN") : r;
	}
	if (cs.uid !== u || !cs.isFile() || (cs.mode & 0o7777) !== F_MODE || cs.nlink !== 1 || cs.size !== 0) {
		ev(b);
		const r = await cl(wf);
		return r === "ok" ? fc("IO_UNCERTAIN") : r;
	}
	const cD = cs.dev,
		cI = cs.ino;
	let w: number = 0;
	while (w < b.byteLength) {
		let wr: { bytesWritten: number; buffer: Uint8Array };
		try {
			wr = await wf.write(b, w, b.byteLength - w, w);
		} catch {
			ev(b);
			const r = await cl(wf);
			return r === "ok" ? fc("IO_UNCERTAIN") : r;
		}
		if (
			typeof wr !== "object" ||
			!wr ||
			typeof wr.bytesWritten !== "number" ||
			!Number.isFinite(wr.bytesWritten) ||
			wr.bytesWritten <= 0 ||
			wr.bytesWritten > b.byteLength - w
		) {
			ev(b);
			const r = await cl(wf);
			return r === "ok" ? fc("IO_UNCERTAIN") : r;
		}
		w += wr.bytesWritten;
	}
	let ps: Awaited<ReturnType<FileHandle["stat"]>>;
	try {
		ps = await wf.stat();
	} catch {
		ev(b);
		const r = await cl(wf);
		return r === "ok" ? fc("IO_UNCERTAIN") : r;
	}
	if (
		ps.uid !== u ||
		!ps.isFile() ||
		(ps.mode & 0o7777) !== F_MODE ||
		ps.nlink !== 1 ||
		ps.dev !== cD ||
		ps.ino !== cI ||
		ps.size !== b.byteLength
	) {
		ev(b);
		const r = await cl(wf);
		return r === "ok" ? fc("IO_UNCERTAIN") : r;
	}
	try {
		await wf.sync();
	} catch {
		ev(b);
		const r = await cl(wf);
		return r === "ok" ? fc("IO_UNCERTAIN") : r;
	}
	try {
		ps = await wf.stat();
	} catch {
		ev(b);
		const r = await cl(wf);
		return r === "ok" ? fc("IO_UNCERTAIN") : r;
	}
	if (
		ps.uid !== u ||
		!ps.isFile() ||
		(ps.mode & 0o7777) !== F_MODE ||
		ps.nlink !== 1 ||
		ps.dev !== cD ||
		ps.ino !== cI ||
		ps.size !== b.byteLength
	) {
		ev(b);
		const r = await cl(wf);
		return r === "ok" ? fc("IO_UNCERTAIN") : r;
	}
	const wc = await cl(wf);
	if (wc !== "ok") {
		ev(b);
		return wc;
	}

	const rb = await rRec(u, p);
	if (!rb.ok) {
		ev(b);
		return fc("IO_UNCERTAIN");
	}
	if (!recEq(rb.record, exp)) {
		ev(b);
		return fc("IO_UNCERTAIN");
	}
	if (!ev(b)) return fc("IO_UNCERTAIN");

	const js = await sD(u, jD, jDv, jIn);
	if (js !== "ok") return js;
	const rs = await sD(u, rD, rDv, rIn);
	if (rs !== "ok") return rs;
	return { ok: true };
}

async function rSN(
	u: number,
	p: string,
	eD: number,
	eI: number,
): Promise<{ ok: true; names: readonly string[] } | { ok: false; code: OwnershipJournalCode }> {
	const b = await oD(u, p, eD, eI);
	if (!b.ok) return b;
	const bc = await cl(b.fd);
	if (bc !== "ok") return bc;
	let r: string[];
	try {
		r = await readdir(p);
	} catch {
		return fc("IO_UNCERTAIN");
	}
	const ns = Object.freeze([...r].sort());
	const a = await oD(u, p, eD, eI);
	if (!a.ok) return a;
	const ac = await cl(a.fd);
	if (ac !== "ok") return ac;
	return { ok: true, names: ns };
}

type InternalChainResult = { ok: true; chain: ValidatedOwnershipChain } | { ok: false; code: OwnershipJournalCode };
type InternalEmptyResult = { ok: false; empty: true };

async function rC(u: number, p: string, eD: number, eI: number, allowEmpty: false): Promise<InternalChainResult>;
async function rC(
	u: number,
	p: string,
	eD: number,
	eI: number,
	allowEmpty: true,
): Promise<InternalChainResult | InternalEmptyResult>;
async function rC(
	u: number,
	p: string,
	eD: number,
	eI: number,
	allowEmpty: boolean,
): Promise<InternalChainResult | InternalEmptyResult> {
	const nr = await rSN(u, p, eD, eI);
	if (!nr.ok) return nr;
	const bf = nr.names;
	if (bf.length === 0) {
		if (allowEmpty) return Object.freeze({ ok: false, empty: true });
		return fc("CORRUPT");
	}
	if (bf.length > MAX_REC) return fc("CORRUPT");
	const sq: number[] = [];
	for (const n of bf) {
		if (!REC_RE.test(n)) return fc("CORRUPT");
		sq.push(Number.parseInt(n.slice(3, 4), 10));
	}
	sq.sort((a, b) => a - b);
	if (sq[0] !== 1) return fc("CORRUPT");
	for (let i = 1; i < sq.length; i++) if (sq[i] !== sq[i - 1] + 1) return fc("CORRUPT");
	const recs: OwnershipRecord[] = [];
	for (const s of sq) {
		const rr = await rRec(u, rp(p, s));
		if (!rr.ok) return rr;
		recs.push(rr.record);
	}
	const ar = await rSN(u, p, eD, eI);
	if (!ar.ok) return ar;
	if (ar.names.length !== bf.length) return fc("CORRUPT");
	for (let i = 0; i < ar.names.length; i++) if (ar.names[i] !== bf[i]) return fc("CORRUPT");
	const cv = validateOwnershipChain(recs);
	if (!cv.ok) return fc("CORRUPT");
	return { ok: true, chain: cv.value };
}

// ── Root validation ────────────────────────────────────────

function isValidPath(s: string): boolean {
	if (typeof s !== "string" || s.length === 0 || s[0] !== "/") return false;
	let bytes: number = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c <= 0x1f || c === 0x7f) return false;
		if (c >= 0xd800 && c <= 0xdbff) {
			if (i + 1 >= s.length || s.charCodeAt(i + 1) < 0xdc00 || s.charCodeAt(i + 1) > 0xdfff) return false;
			bytes += 4;
			i++;
		} else if (c >= 0xdc00 && c <= 0xdfff) {
			return false;
		} else if (c <= 0x7f) {
			bytes += 1;
		} else if (c <= 0x7ff) {
			bytes += 2;
		} else {
			bytes += 3;
		}
		if (bytes > MAX_ROOT_BYTES) return false;
	}
	return true;
}

// ── Admit (sequence 1) ─────────────────────────────────────

async function dA(
	u: number,
	jD: string,
	jDv: number,
	jIn: number,
	rD: string,
	rDv: number,
	rIn: number,
	oneShot: { used: boolean },
	intent: OwnershipIntent,
	t: string,
): Promise<JournalResult> {
	const vl = createPreAdmitOwnershipRecord(intent, t);
	if (!vl.ok) return fc("INPUT_INVALID");

	const rc = await rC(u, jD, jDv, jIn, true);
	if (rc.ok) {
		const ch = rc.chain;
		if (
			ch.intent.lifecycleKey !== vl.value.record.lifecycleKey ||
			ch.intent.parentSessionId !== vl.value.record.parentSessionId ||
			ch.intent.childSessionId !== vl.value.record.childSessionId
		) {
			if (!vl.value.payload.discard()) return fc("IO_UNCERTAIN");
			return fc("CONFLICT");
		}
		if (!vl.value.payload.discard()) return fc("IO_UNCERTAIN");
		return Object.freeze({ ok: true, value: Object.freeze({ chain: ch }) });
	}

	if ("code" in rc) {
		if (!vl.value.payload.discard()) return fc("IO_UNCERTAIN");
		return rc;
	}

	// Empty journal — oneShot.used controls publish authority
	if (oneShot.used) {
		if (!vl.value.payload.discard()) return fc("IO_UNCERTAIN");
		return fc("CORRUPT");
	}
	oneShot.used = true;

	// Take ownership of canonical bytes
	const owned = vl.value.payload.take();
	if (!owned) {
		if (!vl.value.payload.discard()) return fc("IO_UNCERTAIN");
		return fc("IO_UNCERTAIN");
	}

	try {
		const expRec = vl.value.record;
		const pub = await pRec(u, rp(jD, 1), owned, expRec, jD, jDv, jIn, rD, rDv, rIn);
		if (!pub.ok) return pub;

		const po = await rC(u, jD, jDv, jIn, false);
		if (!po.ok) return po;
		return Object.freeze({ ok: true, value: Object.freeze({ chain: po.chain }) });
	} finally {
		ev(owned);
	}
}
// ── Transition ─────────────────────────────────────────────

async function dT(
	u: number,
	jD: string,
	jDv: number,
	jIn: number,
	rD: string,
	rDv: number,
	rIn: number,
	tg: NonDeletedTransitionStage,
	intent: OwnershipIntent,
	t: string,
): Promise<JournalResult> {
	const rc = await rC(u, jD, jDv, jIn, false);
	if (!rc.ok) return rc;
	const dc = decideNonDeletedOwnershipTransition(rc.chain, tg, intent, t);
	if (!dc.ok) {
		if (dc.code === "INPUT_INVALID") return fc("INPUT_INVALID");
		if (dc.code === "CONFLICT") return fc("CONFLICT");
		if (dc.code === "INVALID_TRANSITION") return fc("INVALID_TRANSITION");
		return fc("CORRUPT");
	}
	if (dc.idempotent) {
		return Object.freeze({ ok: true, value: Object.freeze({ chain: rc.chain }) });
	}

	const expRec = dc.value.record;
	const by = dc.value.payload.take();
	if (!by) {
		if (!dc.value.payload.discard()) return fc("IO_UNCERTAIN");
		return fc("IO_UNCERTAIN");
	}

	try {
		const pub = await pRec(u, rp(jD, expRec.sequence), by, expRec, jD, jDv, jIn, rD, rDv, rIn);
		if (!pub.ok) {
			return pub;
		}

		const po = await rC(u, jD, jDv, jIn, false);
		if (!po.ok) return po;
		return Object.freeze({ ok: true, value: Object.freeze({ chain: po.chain }) });
	} catch {
		ev(by);
		return fc("IO_UNCERTAIN");
	}
}

// ── Factory ─────────────────────────────────────────────────

/**
 * Create a hostile-filesystem ownership journal store.
 *
 * Accepts a Home-private absolute session root. Creates
 * `.sandbox-ownership` (0700), validates every directory identity
 * by lstat + O_RDONLY|O_DIRECTORY|O_NOFOLLOW open + fstat,
 * captures UID once per construction, and returns a frozen
 * capability. No raw path or FileHandle leaves the module.
 *
 * Residual same-UID path-swap window: Node.js and Bun do not
 * expose openat(2) or mkdirat(2), so every path-based operation
 * has a window between lstat and its paired open+fstat. A same-UID
 * attacker can rename a validated directory and replace it between
 * the two calls. This implementation mitigates with fstat-after-open
 * verification of every stat invariant (dev, ino, uid, mode, type,
 * nlink), before-and-after verification for enumeration+sync, and
 * construction-bound identity capture, but it cannot eliminate the
 * race on any single path operation. The correct fix would be
 * openat/mkdirat.
 */
export async function createOwnershipJournal(
	sessionRoot: string,
): Promise<{ ok: true; value: OwnershipJournal } | { ok: false; code: OwnershipJournalCode }> {
	if (!isValidPath(sessionRoot)) return fc("INPUT_INVALID");

	const u = process.getuid?.();
	if (u === undefined || typeof u !== "number" || !Number.isFinite(u) || u < 0) return fc("DIRECTORY_UNSAFE");

	let rs: Awaited<ReturnType<typeof lstat>>;
	try {
		rs = await lstat(sessionRoot);
	} catch {
		return fc("DIRECTORY_UNSAFE");
	}
	if (rs.isSymbolicLink() || !rs.isDirectory()) return fc("DIRECTORY_UNSAFE");
	if (rs.uid !== u || (rs.mode & 0o7777) !== D_MODE) return fc("DIRECTORY_UNSAFE");
	const rD = rs.dev,
		rI = rs.ino;

	const ro = await oD(u, sessionRoot, rD, rI);
	if (!ro.ok) return ro;
	const rc = await cl(ro.fd);
	if (rc !== "ok") return rc;

	const jP = `${sessionRoot}/${J_DIR}`;
	let createdByUs: boolean = false;
	try {
		await mkdir(jP, { recursive: false, mode: D_MODE });
		createdByUs = true;
	} catch {
		try {
			const vs = await lstat(jP);
			if (vs.isSymbolicLink() || !vs.isDirectory()) return fc("DIRECTORY_UNSAFE");
			if (vs.uid !== u || (vs.mode & 0o7777) !== D_MODE) return fc("DIRECTORY_UNSAFE");
		} catch {
			return fc("DIRECTORY_UNSAFE");
		}
	}

	let js: Awaited<ReturnType<typeof lstat>>;
	try {
		js = await lstat(jP);
	} catch {
		return fc("DIRECTORY_UNSAFE");
	}
	if (js.isSymbolicLink() || !js.isDirectory()) return fc("DIRECTORY_UNSAFE");
	if (js.uid !== u || (js.mode & 0o7777) !== D_MODE) return fc("DIRECTORY_UNSAFE");
	const jD = js.dev,
		jI = js.ino;

	const jo = await oD(u, jP, jD, jI);
	if (!jo.ok) return jo;
	const jc = await cl(jo.fd);
	if (jc !== "ok") return jc;

	const ss = await sD(u, sessionRoot, rD, rI);
	if (ss !== "ok") return ss;

	if (!createdByUs) {
		const pre = await rC(u, jP, jD, jI, false);
		if (!pre.ok) return pre;
	}

	const oneShot = { used: !createdByUs };

	const j: OwnershipJournal = Object.freeze({
		admit: (i: OwnershipIntent, t: string) => dA(u, jP, jD, jI, sessionRoot, rD, rI, oneShot, i, t),
		recover: async () => {
			const r = await rC(u, jP, jD, jI, false);
			if (!r.ok) return r;
			return Object.freeze({ ok: true, value: Object.freeze({ chain: r.chain }) });
		},
		transition: (tg: NonDeletedTransitionStage, i: OwnershipIntent, t: string) =>
			dT(u, jP, jD, jI, sessionRoot, rD, rI, tg, i, t),
	});
	return Object.freeze({ ok: true, value: Object.freeze(j) });
}

// ── V4 Deletion composition types ──────────────────────────

export type OwnershipDeletionCode = OwnershipJournalCode | "LIFECYCLE_FAILED" | "PROOF_INVALID";

export type OwnershipDeletionResult = Readonly<{ ok: true } | { ok: false; code: OwnershipDeletionCode }>;

export type OwnershipDeletionFactoryResult = Readonly<
	| {
			ok: true;
			value: Readonly<{
				lifecycle: SandboxLifecycle;
				finalizeDeleted: (proof: DeleteProof, recordedAt: string) => Promise<OwnershipDeletionResult>;
			}>;
	  }
	| { ok: false; code: OwnershipDeletionCode }
>;

// ── V4 typed result constructors (no assertions) ──────────

function delOk(): OwnershipDeletionResult {
	return Object.freeze({ ok: true });
}

function delFail(code: OwnershipDeletionCode): OwnershipDeletionResult {
	return Object.freeze({ ok: false, code });
}

type DeletionBundle = Readonly<{
	lifecycle: SandboxLifecycle;
	finalizeDeleted: (proof: DeleteProof, recordedAt: string) => Promise<OwnershipDeletionResult>;
}>;

function factOk(value: DeletionBundle): OwnershipDeletionFactoryResult {
	return Object.freeze({ ok: true, value: Object.freeze(value) });
}

function factFail(code: OwnershipDeletionCode): OwnershipDeletionFactoryResult {
	return Object.freeze({ ok: false, code });
}

// ── V4 canonical timestamp and digest checks ──────────────

const HEX_64_RE: RegExp = /^[0-9a-f]{64}$/;

function validTimestampMs(v: unknown): v is string {
	if (typeof v !== "string") return false;
	const d = new Date(v);
	return Number.isFinite(d.getTime()) && d.toISOString() === v;
}

function validDigest64(v: unknown): v is string {
	return typeof v === "string" && HEX_64_RE.test(v);
}

function canonicalDeletedPrefix(
	sequence: 6,
	intent: OwnershipIntent,
	recordedAt: string,
	previousDigest: string | null,
): string {
	return `{"version":1,"sequence":${sequence},"stage":"deleted","lifecycleKey":${JSON.stringify(intent.lifecycleKey)},"parentSessionId":${JSON.stringify(intent.parentSessionId)},"childSessionId":${JSON.stringify(intent.childSessionId)},"recordedAt":${JSON.stringify(recordedAt)},"previousDigest":${previousDigest === null ? "null" : JSON.stringify(previousDigest)}`;
}

function digestHex(prefix: string): string | undefined {
	const bytes = new TextEncoder().encode(prefix);
	let digest: string;
	try {
		digest = createHash("sha256").update(bytes).digest("hex");
	} catch {
		ev(bytes);
		return undefined;
	}
	if (!ev(bytes)) return undefined;
	return digest;
}

function produceDeletedRecordBytes(
	intent: OwnershipIntent,
	recordedAt: string,
	previousDigest: string | null,
): Uint8Array | undefined {
	if (!validTimestampMs(recordedAt)) return undefined;
	if (previousDigest !== null && !validDigest64(previousDigest)) return undefined;
	const prefix = canonicalDeletedPrefix(6, intent, recordedAt, previousDigest);
	const cd = digestHex(prefix);
	if (cd === undefined) return undefined;
	const full = new TextEncoder().encode(`${prefix},"contentDigest":${JSON.stringify(cd)}}`);
	if (full.byteLength > MAX_SZ) {
		ev(full);
		return undefined;
	}
	return full;
}

function buildDeletedRecordFromBytes(bytes: Uint8Array): OwnershipRecord | undefined {
	const dd = decodeOwnershipRecord(bytes);
	if (!dd.ok) return undefined;
	return dd.value;
}

function buildSixChain(existing: ValidatedOwnershipChain, deletedRecord: OwnershipRecord): readonly OwnershipRecord[] {
	const all = [...existing.records, deletedRecord];
	return Object.freeze(all);
}

function validateDeletedCandidateSixChain(existing: ValidatedOwnershipChain, deletedRecord: OwnershipRecord): boolean {
	const all = buildSixChain(existing, deletedRecord);
	const cv = validateOwnershipChain(all);
	return cv.ok;
}

// ── V4 copyIntentViaPreAdmit (captured descriptor values) ──

const FIXED_COPY_TIMESTAMP = "2026-09-04T01:02:03.004Z";

function copyIntentViaPreAdmit(value: unknown): OwnershipIntent | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	try {
		const proto = Object.getPrototypeOf(value);
		if (proto !== Object.prototype) return undefined;

		const ownKeys: readonly (string | symbol)[] = Reflect.ownKeys(value);
		if (ownKeys.length !== 3) return undefined;
		for (const k of ownKeys) {
			if (typeof k !== "string") return undefined;
			if (k !== "lifecycleKey" && k !== "parentSessionId" && k !== "childSessionId") return undefined;
		}

		// Capture descriptor values — no Proxy get traps
		const lkD = Object.getOwnPropertyDescriptor(value, "lifecycleKey");
		if (lkD === undefined || !Object.hasOwn(lkD, "value") || !lkD.enumerable) return undefined;
		const psD = Object.getOwnPropertyDescriptor(value, "parentSessionId");
		if (psD === undefined || !Object.hasOwn(psD, "value") || !psD.enumerable) return undefined;
		const csD = Object.getOwnPropertyDescriptor(value, "childSessionId");
		if (csD === undefined || !Object.hasOwn(csD, "value") || !csD.enumerable) return undefined;

		const lifecycleKey: unknown = lkD.value;
		const parentSessionId: unknown = psD.value;
		const childSessionId: unknown = csD.value;

		if (
			typeof lifecycleKey !== "string" ||
			typeof parentSessionId !== "string" ||
			typeof childSessionId !== "string"
		) {
			return undefined;
		}

		const wrapper: OwnershipIntent = Object.freeze({
			lifecycleKey,
			parentSessionId,
			childSessionId,
		});
		const result = createPreAdmitOwnershipRecord(wrapper, FIXED_COPY_TIMESTAMP);
		if (!result.ok) return undefined;

		const record = result.value.record;
		const intent: OwnershipIntent = Object.freeze({
			lifecycleKey: record.lifecycleKey,
			parentSessionId: record.parentSessionId,
			childSessionId: record.childSessionId,
		});
		if (!result.value.payload.discard()) return undefined;
		return intent;
	} catch {
		return undefined;
	}
}

// ── V4 helper predicates ──────────────────────────────────

function sameBoundIntent(a: OwnershipIntent, b: OwnershipIntent): boolean {
	return (
		a.lifecycleKey === b.lifecycleKey &&
		a.parentSessionId === b.parentSessionId &&
		a.childSessionId === b.childSessionId
	);
}

function expectDeletingSeq5(chain: ValidatedOwnershipChain, intent: OwnershipIntent): boolean {
	const cur = chain.current;
	if (cur.sequence !== 5) return false;
	if (cur.stage !== "deleting") return false;
	if (!sameBoundIntent(chain.intent, intent)) return false;
	return true;
}

function laterTimestamp(a: string, b: string): boolean {
	return Number.isFinite(Date.parse(a)) && Number.isFinite(Date.parse(b)) && Date.parse(a) > Date.parse(b);
}

// ── V4 Factory ─────────────────────────────────────────────

/**
 * Create an ownership journal with V4 deletion composition.
 *
 * Requires an existing nonempty journal with exact sequence 5 "deleting"
 * bound to the given OwnershipIntent. Calls createSandboxLifecycle only
 * after ownership recovery validates the chain. Returns the lifecycle and
 * a narrow finalizeDeleted closure.
 */
export async function createOwnershipJournalWithDeletion(
	sessionRoot: string,
	boundIntent: OwnershipIntent,
	runCommand: RunCommand,
	config: LifecycleConfig,
	clock?: Clock,
	delay?: DelayFn,
): Promise<OwnershipDeletionFactoryResult> {
	if (!isValidPath(sessionRoot)) return factFail("INPUT_INVALID");

	const intent = copyIntentViaPreAdmit(boundIntent);
	if (intent === undefined) return factFail("INPUT_INVALID");

	const u = process.getuid?.();
	if (u === undefined || typeof u !== "number" || !Number.isFinite(u) || u < 0) return factFail("DIRECTORY_UNSAFE");

	let rs: Awaited<ReturnType<typeof lstat>>;
	try {
		rs = await lstat(sessionRoot);
	} catch {
		return factFail("DIRECTORY_UNSAFE");
	}
	if (rs.isSymbolicLink() || !rs.isDirectory()) return factFail("DIRECTORY_UNSAFE");
	if (rs.uid !== u || (rs.mode & 0o7777) !== D_MODE) return factFail("DIRECTORY_UNSAFE");
	const rD = rs.dev,
		rI = rs.ino;

	const ro = await oD(u, sessionRoot, rD, rI);
	if (!ro.ok) return factFail("DIRECTORY_UNSAFE");
	const rc = await cl(ro.fd);
	if (rc !== "ok") return factFail("IO_UNCERTAIN");

	const jP = `${sessionRoot}/${J_DIR}`;

	let jDirStat: Awaited<ReturnType<typeof lstat>>;
	try {
		jDirStat = await lstat(jP);
	} catch {
		return factFail("DIRECTORY_UNSAFE");
	}
	if (jDirStat.isSymbolicLink() || !jDirStat.isDirectory()) return factFail("DIRECTORY_UNSAFE");
	if (jDirStat.uid !== u || (jDirStat.mode & 0o7777) !== D_MODE) return factFail("DIRECTORY_UNSAFE");
	const jDirDev = jDirStat.dev,
		jDirIno = jDirStat.ino;

	const jo = await oD(u, jP, jDirDev, jDirIno);
	if (!jo.ok) return factFail(jo.code);
	const jc = await cl(jo.fd);
	if (jc !== "ok") return factFail("IO_UNCERTAIN");

	const ss = await sD(u, sessionRoot, rD, rI);
	if (ss !== "ok") return factFail(ss.code);

	// Recover existing journal — must be nonempty and at seq5 deleting
	const preRecovered = await rC(u, jP, jDirDev, jDirIno, false);
	if (!preRecovered.ok) return factFail(preRecovered.code);

	if (!expectDeletingSeq5(preRecovered.chain, intent)) return factFail("CORRUPT");

	// Only now call createSandboxLifecycle
	const lifecycleResult = await createSandboxLifecycle(runCommand, config, clock, delay);
	if (!lifecycleResult.ok) return factFail("LIFECYCLE_FAILED");

	const bundle = lifecycleResult.value;
	const lifecycle: SandboxLifecycle = bundle.lifecycle;
	const proofConsumer: ProofConsumer = bundle.proofConsumer;

	// Closure-private V4 state
	const retryState = new WeakMap<DeleteProof, OwnershipRecord>();
	const completed = new WeakSet<DeleteProof>();

	const finalizeDeleted = async (proof: DeleteProof, recordedAt: string): Promise<OwnershipDeletionResult> => {
		try {
			if (completed.has(proof)) return delFail("PROOF_INVALID");

			const expected = retryState.get(proof);
			const isRetry = expected !== undefined;

			// Recover chain (always first)
			const chainResult = await rC(u, jP, jDirDev, jDirIno, false);
			if (!chainResult.ok) return delFail(chainResult.code);
			const chain = chainResult.chain;

			if (isRetry) {
				// ── Retry path ──────────────────────────────────────

				// Accept exact full seq6 match before requiring seq5
				if (chain.records.length === 6) {
					const last = chain.records[5];
					if (
						last.sequence === 6 &&
						last.stage === "deleted" &&
						recEq(last, expected) &&
						sameBoundIntent(chain.intent, intent)
					) {
						retryState.delete(proof);
						completed.add(proof);
						return delOk();
					}
					return delFail("CORRUPT");
				}

				// Still on seq5 — validate and re-publish
				if (!expectDeletingSeq5(chain, intent)) return delFail("CORRUPT");

				// A retry is authority for exactly the stored candidate, including its timestamp.
				if (recordedAt !== expected.recordedAt) return delFail("INPUT_INVALID");
				const storedRecordedAt: string = expected.recordedAt;
				const storedPreviousDigest: string | null = expected.previousDigest;

				// Regenerate canonical bytes from stored record
				const regenBytes = produceDeletedRecordBytes(intent, storedRecordedAt, storedPreviousDigest);
				if (regenBytes === undefined) return delFail("CORRUPT");

				const pubBytes = new Uint8Array(regenBytes);
				try {
					const redecoded = buildDeletedRecordFromBytes(new Uint8Array(regenBytes));
					if (redecoded === undefined || !recEq(redecoded, expected)) return delFail("CORRUPT");

					const pub = await pRec(u, rp(jP, 6), pubBytes, redecoded, jP, jDirDev, jDirIno, sessionRoot, rD, rI);
					if (!pub.ok) return delFail(pub.code);

					// Post-publish verification
					const pp = await rC(u, jP, jDirDev, jDirIno, false);
					if (!pp.ok || pp.chain.records.length !== 6) return delFail("IO_UNCERTAIN");
					const pl = pp.chain.records[5];
					if (
						pl.sequence !== 6 ||
						pl.stage !== "deleted" ||
						!recEq(pl, redecoded) ||
						!sameBoundIntent(pp.chain.intent, intent)
					)
						return delFail("IO_UNCERTAIN");

					retryState.delete(proof);
					completed.add(proof);
					return delOk();
				} finally {
					ev(pubBytes);
					ev(regenBytes);
				}
			}

			// ── First attempt path ────────────────────────────────

			if (!validTimestampMs(recordedAt)) return delFail("INPUT_INVALID");

			if (!expectDeletingSeq5(chain, intent)) return delFail("CORRUPT");

			if (!laterTimestamp(recordedAt, chain.current.recordedAt)) return delFail("INPUT_INVALID");

			// Build candidate sequence-6 record privately
			const seq5Digest = chain.current.contentDigest;
			const candidateBytes = produceDeletedRecordBytes(intent, recordedAt, seq5Digest);
			if (candidateBytes === undefined) return delFail("INPUT_INVALID");

			let candidateRec: OwnershipRecord | undefined;
			let pubBytes: Uint8Array | undefined;
			try {
				const decodeBytes = new Uint8Array(candidateBytes);
				candidateRec = buildDeletedRecordFromBytes(decodeBytes);
				if (!ev(decodeBytes)) return delFail("IO_UNCERTAIN");
				if (candidateRec === undefined) return delFail("CORRUPT");

				// Validate candidate six-chain BEFORE consuming proof
				if (!validateDeletedCandidateSixChain(chain, candidateRec)) return delFail("CORRUPT");

				// Consume genuine proof BEFORE setting retry auth
				const consumeResult = proofConsumer.consumeProof(proof);
				if (!consumeResult.ok) return delFail("PROOF_INVALID");

				// Set retry authorization synchronously AFTER successful proof consumption
				retryState.set(proof, candidateRec);

				// Publish with O_EXCL in caught try — auth already set
				pubBytes = new Uint8Array(candidateBytes);
				try {
					const pub = await pRec(u, rp(jP, 6), pubBytes, candidateRec, jP, jDirDev, jDirIno, sessionRoot, rD, rI);
					if (!pub.ok) {
						// IO_UNCERTAIN — retryState retains authorization
						return delFail(pub.code);
					}

					// Post-publish recovery and exact equality check
					const pp = await rC(u, jP, jDirDev, jDirIno, false);
					if (!pp.ok || pp.chain.records.length !== 6) return delFail("IO_UNCERTAIN");
					const pl = pp.chain.records[5];
					if (
						pl.sequence !== 6 ||
						pl.stage !== "deleted" ||
						!recEq(pl, candidateRec) ||
						!sameBoundIntent(pp.chain.intent, intent)
					)
						return delFail("IO_UNCERTAIN");

					// Success — clear retry auth
					retryState.delete(proof);
					completed.add(proof);
					return delOk();
				} finally {
					ev(pubBytes);
				}
			} finally {
				ev(candidateBytes);
			}
		} catch {
			// Never propagate exception
			return delFail("IO_UNCERTAIN");
		}
	};

	const value: DeletionBundle = Object.freeze({
		lifecycle,
		finalizeDeleted,
	});
	return factOk(value);
}
