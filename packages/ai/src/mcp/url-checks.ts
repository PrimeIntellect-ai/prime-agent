/**
 * Literal-address URL checks shared by the catalog validator, the local source
 * loader and the importer. Structural checks only: loopback, RFC1918 private,
 * link-local and unspecified IPs, plus plain `localhost` names. This is NOT
 * DNS, redirect or rebinding SSRF enforcement — request-time network policy
 * stays with the host/runtime. DNS names that resolve to private space are out
 * of scope here.
 */
export function isLiteralPrivateOrLoopbackHost(hostname: string): boolean {
	const bare = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (bare === "localhost" || bare.endsWith(".localhost")) return true;
	const v4 = /^((?:\d{1,3}\.){3}\d{1,3})$/.exec(bare);
	if (v4) {
		const parts = bare.split(".").map(Number);
		if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
		const [a, b] = parts as [number, number, number, number];
		if (a === 127 || a === 10 || a === 0) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
		if (a === 169 && b === 254) return true;
		return false;
	}
	if (bare.includes(":")) {
		const expanded = expandIpv6(bare);
		if (expanded === undefined) return true;
		if (expanded.every((word) => word === 0)) return true;
		if (expanded.slice(0, 7).every((word) => word === 0) && expanded[7] === 1) return true;
		if (
			expanded[0] === 0 &&
			expanded[1] === 0 &&
			expanded[2] === 0 &&
			expanded[3] === 0 &&
			expanded[4] === 0 &&
			expanded[5] === 0xffff
		) {
			return isLiteralPrivateOrLoopbackHost(
				`${expanded[6] >> 8}.${expanded[6] & 0xff}.${expanded[7] >> 8}.${expanded[7] & 0xff}`,
			);
		}
		if ((expanded[0] & 0xffc0) === 0xfe80) return true;
	}
	return false;
}

/** Expands an IPv6 address into 8 numeric 16-bit words; undefined when malformed. */
function expandIpv6(address: string): number[] | undefined {
	const [head, tail = ""] = address.split("::");
	const headParts = head === "" ? [] : head.split(":");
	const tailParts = tail === "" ? [] : tail.split(":");
	const total = headParts.length + tailParts.length;
	if (!address.includes("::")) {
		if (total !== 8 || headParts.some((part) => part === "")) return undefined;
	} else if (total > 7) {
		return undefined;
	}
	const words: number[] = [];
	for (const part of headParts) {
		const word = Number.parseInt(part || "0", 16);
		if (!Number.isInteger(word) || word < 0 || word > 0xffff) return undefined;
		words.push(word);
	}
	const fill = 8 - total;
	for (let index = 0; index < fill; index++) words.push(0);
	for (const part of tailParts) {
		const word = Number.parseInt(part || "0", 16);
		if (!Number.isInteger(word) || word < 0 || word > 0xffff) return undefined;
		words.push(word);
	}
	return words.length === 8 ? words : undefined;
}
