import { isIPv4, isIPv6 } from "node:net";

/** Hostname suffixes that only ever resolve inside a local network. */
const PRIVATE_NAME_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

const PRIVATE_IPV4_RANGES: Array<[number, number]> = [
	[0x00000000, 8], // 0.0.0.0/8 "this" network
	[0x0a000000, 8], // 10.0.0.0/8
	[0x64400000, 10], // 100.64.0.0/10 shared address space (CGNAT)
	[0x7f000000, 8], // 127.0.0.0/8 loopback
	[0xa9fe0000, 16], // 169.254.0.0/16 link-local
	[0xac100000, 12], // 172.16.0.0/12
	[0xc0000000, 24], // 192.0.0.0/24 IETF protocol assignments
	[0xc0000200, 24], // 192.0.2.0/24 TEST-NET-1
	[0xc0586300, 24], // 192.88.99.0/24 6to4 relay anycast (deprecated)
	[0xc0a80000, 16], // 192.168.0.0/16
	[0xc6120000, 15], // 198.18.0.0/15 benchmarking
	[0xc6336400, 24], // 198.51.100.0/24 TEST-NET-2
	[0xcb007100, 24], // 203.0.113.0/24 TEST-NET-3
	[0xe0000000, 4], // 224.0.0.0/4 multicast
	[0xf0000000, 4], // 240.0.0.0/4 reserved and broadcast
];

function ipv4ToNumber(address: string): number {
	return address.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);
}

function isPublicIPv4(address: string): boolean {
	const value = ipv4ToNumber(address);
	return !PRIVATE_IPV4_RANGES.some(([base, bits]) => value >>> (32 - bits) === base >>> (32 - bits));
}

/** Expand an IPv6 literal into eight 16-bit groups; undefined when malformed. */
function ipv6Groups(address: string): number[] | undefined {
	let text = address;
	const zone = text.indexOf("%");
	if (zone !== -1) text = text.slice(0, zone);
	// Embedded dotted IPv4 tail (e.g. ::ffff:127.0.0.1) becomes two groups.
	const lastColon = text.lastIndexOf(":");
	const tail = text.slice(lastColon + 1);
	if (tail.includes(".")) {
		if (!isIPv4(tail)) return undefined;
		const v4 = ipv4ToNumber(tail);
		text = `${text.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
	}
	const halves = text.split("::");
	if (halves.length > 2) return undefined;
	const parse = (part: string): number[] => (part === "" ? [] : part.split(":").map((group) => parseInt(group, 16)));
	const head = parse(halves[0] ?? "");
	const rest = halves.length === 2 ? parse(halves[1] ?? "") : [];
	const missing = 8 - head.length - rest.length;
	if (missing < 0 || (halves.length === 1 && missing !== 0)) return undefined;
	const groups = [...head, ...new Array<number>(Math.max(0, missing)).fill(0), ...rest];
	return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff)
		? groups
		: undefined;
}

function isPublicIPv6(address: string): boolean {
	const groups = ipv6Groups(address);
	if (!groups) return false;
	const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
	const embeddedV4 = (): string => `${g6 >>> 8}.${g6 & 0xff}.${g7 >>> 8}.${g7 & 0xff}`;
	// :: (unspecified) and ::1 (loopback)
	if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) {
		return false;
	}
	// ::ffff:a.b.c.d (IPv4-mapped) and ::a.b.c.d (IPv4-compatible, deprecated)
	if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
		return isPublicIPv4(embeddedV4());
	}
	// 64:ff9b::/96 NAT64 well-known prefix
	if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isPublicIPv4(embeddedV4());
	if ((g0 & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
	if ((g0 & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
	if ((g0 & 0xffc0) === 0xfec0) return false; // fec0::/10 site-local (deprecated)
	if ((g0 & 0xff00) === 0xff00) return false; // ff00::/8 multicast
	if (g0 === 0x2001 && g1 === 0x0db8) return false; // 2001:db8::/32 documentation
	if (g0 === 0x2001 && g1 === 0) return false; // 2001::/32 Teredo (tunnels client addresses)
	if (g0 === 0x2002) return isPublicIPv4(`${g1 >>> 8}.${g1 & 0xff}.${g2 >>> 8}.${g2 & 0xff}`); // 2002::/16 6to4
	return true;
}

/**
 * True when a URL hostname (as produced by the WHATWG URL parser) can only name a
 * public destination: not a loopback, private, link-local, multicast or otherwise
 * reserved literal address and not a name reserved for local networks.
 */
export function isPublicHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	if (host === "") return false;
	if (host.startsWith("[") && host.endsWith("]")) {
		const literal = host.slice(1, -1);
		return isIPv6(literal) && isPublicIPv6(literal);
	}
	if (isIPv4(host)) return isPublicIPv4(host);
	if (isIPv6(host)) return isPublicIPv6(host);
	if (host === "localhost") return false;
	if (PRIVATE_NAME_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
	// Single-label names resolve through local search domains, never public DNS.
	return host.includes(".");
}
